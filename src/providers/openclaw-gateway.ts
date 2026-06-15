import crypto from 'crypto';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { v4 as uuid } from 'uuid';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentAttachment,
} from '../types/providers.js';
import type { AgentEventType } from '../types/events.js';
import { diagnoseError, formatDiagnostic } from './diagnostics.js';
import { importOptionalPeer } from './peer-deps.js';
import { getSafeExtension, isAttachmentSizeValid, isPathWithinBoundary } from './validation.js';

const CLIENT_VERSION = '0.6.0';
const PROTOCOL_VERSION = 4;
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_SCOPES = ['operator.read', 'operator.write'];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface OpenClawDeviceIdentity {
  deviceId: string;
  /** PEM encoded public key, or use publicKey for OpenClaw's raw base64url public key. */
  publicKeyPem?: string;
  /** Raw OpenClaw public key as returned by device pairing. */
  publicKey?: string;
  privateKeyPem: string;
}

export interface OpenClawGatewayProviderOptions {
  /** OpenClaw Gateway WebSocket URL. Defaults to OPENCLAW_GATEWAY_URL or ws://127.0.0.1:18789. */
  url?: string;
  /** Shared gateway token. Defaults to OPENCLAW_GATEWAY_TOKEN or OPENCLAW_TOKEN. */
  token?: string;
  /** Paired device token. Defaults to OPENCLAW_DEVICE_TOKEN. */
  deviceToken?: string;
  /** Gateway password when gateway auth mode is password. Defaults to OPENCLAW_PASSWORD. */
  password?: string;
  /** Optional client device family metadata included in the signed device payload. */
  deviceFamily?: string;
  /** Display model. OpenClaw uses the gateway/session model config for real execution. */
  model?: string;
  /** Session key to use for new sessions. Defaults to OPENCLAW_SESSION_KEY or main. */
  sessionKey?: string;
  /** Optional OpenClaw agent id for chat.send. Defaults to OPENCLAW_AGENT_ID when set. */
  agentId?: string;
  /** Optional per-run timeout forwarded to chat.send. */
  timeoutMs?: number;
  /** Time to wait for the Gateway connect challenge/handshake. Defaults to 15 seconds. */
  connectTimeoutMs?: number;
  /** Requested gateway scopes. Defaults to operator.read and operator.write. */
  scopes?: string[];
  /** Optional device identity for signed device auth. Token/password auth works without this. */
  deviceIdentity?: OpenClawDeviceIdentity;
  /** Injected WebSocket constructor for tests. */
  WebSocketCtor?: WebSocketConstructor;
  /** Extra environment values used for option defaults. */
  env?: NodeJS.ProcessEnv;
}

type OpenClawStatus = AgentResult['status'];

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): WebSocketLike;
  on(event: 'message', listener: (data: unknown) => void): WebSocketLike;
  on(event: 'close', listener: (code: number, reason: unknown) => void): WebSocketLike;
  on(event: 'error', listener: (error: Error) => void): WebSocketLike;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

type GatewayResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

type GatewayEvent = {
  type: 'event';
  event: string;
  payload?: unknown;
};

type PendingRequest = {
  method: string;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type RegisteredSession = {
  config: AgentSessionConfig;
  sessionKey: string;
  agentId?: string;
  destroyed: boolean;
  activeRunId?: string;
  active?: ActivePrompt;
};

type ActivePrompt = {
  runId: string;
  idempotencyKey: string;
  adoptedRunId?: string;
  outputEmitted: boolean;
  outputText: string;
  resolve: (result: AgentResult) => void;
  settled: boolean;
  aborted: boolean;
};

type ChatEventMapping = {
  type: AgentEventType;
  content: string;
  terminal: boolean;
  status?: OpenClawStatus;
  replace?: boolean;
};

export class OpenClawGatewayProvider implements AgentProvider {
  readonly name: AgentType = 'openclaw';
  readonly displayName = 'OpenClaw';
  readonly model: string;

  private url: string;
  private token?: string;
  private deviceToken?: string;
  private password?: string;
  private deviceFamily?: string;
  private defaultSessionKey: string;
  private defaultAgentId?: string;
  private defaultTimeoutMs?: number;
  private connectTimeoutMs: number;
  private scopes: string[];
  private deviceIdentity?: OpenClawDeviceIdentity;
  private WebSocketCtor?: WebSocketConstructor;
  private socket: WebSocketLike | null = null;
  private pending = new Map<string, PendingRequest>();
  private sessions = new Set<RegisteredSession>();
  private connectPromise: Promise<void> | null = null;
  private connectResolve?: () => void;
  private connectReject?: (error: Error) => void;
  private connected = false;

  constructor(options: OpenClawGatewayProviderOptions = {}) {
    const env = options.env ?? process.env;
    this.url = options.url || env.OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL;
    this.token = options.token || env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_TOKEN;
    this.deviceToken = options.deviceToken || env.OPENCLAW_DEVICE_TOKEN;
    this.password = options.password || env.OPENCLAW_PASSWORD;
    this.deviceFamily = options.deviceFamily;
    this.defaultSessionKey = options.sessionKey || env.OPENCLAW_SESSION_KEY || DEFAULT_SESSION_KEY;
    this.defaultAgentId = options.agentId || env.OPENCLAW_AGENT_ID;
    this.defaultTimeoutMs = options.timeoutMs;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.scopes = options.scopes ?? DEFAULT_SCOPES;
    this.deviceIdentity = options.deviceIdentity ?? readDeviceIdentityFromEnv(env);
    this.model = options.model || env.OPENCLAW_MODEL || 'gateway configured default';
    this.WebSocketCtor = options.WebSocketCtor;
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    let connectTimer: NodeJS.Timeout | undefined;
    this.connectPromise = (async () => {
      const WebSocketCtor = this.WebSocketCtor ?? await loadWebSocketConstructor();
      return new Promise<void>((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
        connectTimer = setTimeout(() => {
          if (!this.connected) {
            this.failConnection(new Error('OpenClaw connect challenge timed out'));
          }
        }, this.connectTimeoutMs);
        const socket = new WebSocketCtor(this.url);
        this.socket = socket;
        socket.on('open', () => {
          // Modern OpenClaw gateways send connect.challenge after opening. The
          // challenge drives connect auth so the device signature can include nonce.
        });
        socket.on('message', data => this.handleRawMessage(rawDataToString(data)));
        socket.on('error', error => this.failConnection(error));
        socket.on('close', (code, reason) => {
          const message = `OpenClaw Gateway closed (code=${code}${reason ? `, reason=${rawDataToString(reason)}` : ''})`;
          this.failConnection(new Error(message));
        });
      });
    })().finally(() => {
      if (connectTimer) clearTimeout(connectTimer);
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async stop(): Promise<void> {
    for (const request of this.pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(new Error('OpenClaw provider stopped'));
    }
    this.pending.clear();
    for (const session of this.sessions) {
      this.failActivePrompt(session, 'OpenClaw provider stopped');
    }
    this.sessions.clear();
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.requireConnection();
    const sessionKey = config.resumeSessionId || this.defaultSessionKey;
    const registered: RegisteredSession = {
      config,
      sessionKey,
      agentId: this.defaultAgentId,
      destroyed: false,
    };
    this.sessions.add(registered);

    let initialPromptSent = Boolean(config.resumeSessionId);
    let promptLock: Promise<void> = Promise.resolve();

    const withPromptLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      const previous = promptLock;
      let release!: () => void;
      promptLock = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    };

    const runPrompt = async (
      prompt: string,
      attachments: AgentAttachment[] | undefined,
      includeInitialContext: boolean,
    ): Promise<AgentResult> => {
      if (registered.destroyed) {
        return { status: 'failed', error: 'OpenClaw session has been destroyed' };
      }

      const message = includeInitialContext && config.systemPrompt
        ? `${config.systemPrompt}\n\n${prompt}`
        : prompt;
      let mergedAttachments: unknown[] | undefined;
      try {
        mergedAttachments = await buildOpenClawAttachmentsParam(attachments, config.workingDirectory);
      } catch (err: unknown) {
        const messageText = errorMessage(err);
        emitEvent(config, 'error', `OpenClaw attachment error: ${messageText}`);
        return { status: 'failed', error: messageText };
      }
      const idempotencyKey = `agent-sdk-${uuid()}`;
      let ack: unknown;
      try {
        ack = await this.request('chat.send', {
          sessionKey,
          ...(registered.agentId ? { agentId: registered.agentId } : {}),
          message,
          deliver: false,
          idempotencyKey,
          ...(this.defaultTimeoutMs !== undefined ? { timeoutMs: this.defaultTimeoutMs } : {}),
          ...(mergedAttachments ? { attachments: mergedAttachments } : {}),
        });
      } catch (err: unknown) {
        const diag = formatDiagnostic(diagnoseError('openclaw', errorMessage(err), config.workingDirectory));
        emitEvent(config, 'error', `OpenClaw Gateway error: ${diag}`);
        return { status: 'failed', error: diag };
      }

      const runId = readStringProperty(ack, 'runId') ?? idempotencyKey;
      registered.activeRunId = runId;

      return await new Promise<AgentResult>(resolve => {
        registered.active = {
          runId,
          idempotencyKey,
          outputEmitted: false,
          outputText: '',
          resolve,
          settled: false,
          aborted: false,
        };
      });
    };

    return {
      get sessionId() {
        return sessionKey;
      },

      execute: async (prompt: string, attachments?: AgentAttachment[]): Promise<AgentResult> => withPromptLock(async () => {
        const merged = initialPromptSent
          ? attachments
          : [...(config.attachments ?? []), ...(attachments ?? [])];
        const result = await runPrompt(prompt, merged, !initialPromptSent);
        initialPromptSent = true;
        return result;
      }),

      send: async (message: string, attachments?: AgentAttachment[]): Promise<void> => {
        await withPromptLock(async () => {
          const result = await runPrompt(message, attachments, false);
          if (result.status === 'failed' && result.error) {
            emitEvent(config, 'error', result.error);
          }
        });
      },

      abort: async (): Promise<void> => {
        const runId = registered.activeRunId;
        if (registered.active) registered.active.aborted = true;
        if (runId) {
          await this.request('chat.abort', { sessionKey, runId }).catch((err: unknown) => {
            emitEvent(config, 'error', `OpenClaw abort failed: ${errorMessage(err)}`);
          });
        }
        this.resolveActivePrompt(registered, { status: 'failed', error: 'OpenClaw execution aborted' });
      },

      destroy: async (): Promise<void> => {
        registered.destroyed = true;
        this.sessions.delete(registered);
        this.resolveActivePrompt(registered, { status: 'failed', error: 'OpenClaw session destroyed' });
      },
    };
  }

  private requireConnection(): void {
    if (!this.connected || !this.socket || this.socket.readyState !== 1) {
      throw new Error('OpenClaw Gateway client not initialized — call start() first');
    }
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (isGatewayEvent(parsed)) {
      this.handleGatewayEvent(parsed);
      return;
    }
    if (isGatewayResponse(parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        pending.reject(new Error(parsed.error?.message ?? `${pending.method} failed`));
      }
    }
  }

  private handleGatewayEvent(event: GatewayEvent): void {
    if (event.event === 'connect.challenge') {
      const nonce = readStringProperty(event.payload, 'nonce');
      if (!nonce) {
        this.failConnection(new Error('OpenClaw connect challenge missing nonce'));
        return;
      }
      this.sendConnect(nonce);
      return;
    }

    if (event.event !== 'chat' || !isObject(event.payload)) {
      return;
    }
    const payload = event.payload;
    const runId = readStringProperty(payload, 'runId');
    if (!runId) return;
    const session = this.findSessionForRunId(runId, payload);
    if (!session?.active || session.active.settled) return;

    const mapped = mapOpenClawChatEvent(payload);
    const active = session.active;
    if (mapped.terminal) {
      if (mapped.status === 'complete') {
        const completeText = mapped.content || active.outputText;
        if (mapped.content && !active.outputEmitted) {
          emitEvent(session.config, 'output', mapped.content, { agentType: 'openclaw' });
          active.outputEmitted = true;
          active.outputText = mapped.content;
        }
        emitEvent(session.config, 'complete', completeText, { agentType: 'openclaw' });
      } else {
        emitEvent(session.config, 'error', mapped.content || 'OpenClaw execution failed', { agentType: 'openclaw' });
      }
      const result: AgentResult = mapped.status === 'complete'
        ? { status: 'complete' }
        : { status: 'failed', error: mapped.content || 'OpenClaw execution failed' };
      this.resolveActivePrompt(session, result);
      return;
    }

    if (mapped.content) {
      active.outputText = mapped.replace ? mapped.content : `${active.outputText}${mapped.content}`;
      emitEvent(session.config, mapped.type, mapped.content, { agentType: 'openclaw', replace: mapped.replace });
      if (mapped.type === 'output') active.outputEmitted = true;
    }
  }

  private findSessionForRunId(runId: string, payload: Record<string, unknown>): RegisteredSession | undefined {
    const direct = [...this.sessions].find(entry => {
      const active = entry.active;
      return active && !active.settled && (
        active.runId === runId
        || active.idempotencyKey === runId
        || active.adoptedRunId === runId
      );
    });
    if (direct) return direct;

    // Defensive compatibility with older Gateway streams where chat.send ack
    // used the client idempotency key but deltas/finals used a distinct agent
    // run id. Fail closed unless the event carries a matching sessionKey.
    const eventSessionKey = readStringProperty(payload, 'sessionKey');
    if (!eventSessionKey) return undefined;
    for (const entry of this.sessions) {
      const active = entry.active;
      if (!active || active.settled || active.adoptedRunId) continue;
      if (!sessionKeysMatch(eventSessionKey, entry.sessionKey)) continue;
      active.adoptedRunId = runId;
      active.runId = runId;
      entry.activeRunId = runId;
      return entry;
    }
    return undefined;
  }

  private sendConnect(nonce: string): void {
    const auth: Record<string, string> = {};
    const signatureToken = this.token ?? this.deviceToken;
    if (this.token || this.deviceToken) auth.token = signatureToken!;
    if (this.deviceToken) auth.deviceToken = this.deviceToken;
    if (this.password) auth.password = this.password;
    const params: Record<string, unknown> = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'gateway-client',
        displayName: 'agent-sdk-core',
        version: CLIENT_VERSION,
        platform: process.platform,
        mode: 'backend',
        ...(this.deviceFamily ? { deviceFamily: this.deviceFamily } : {}),
      },
      caps: [],
      role: 'operator',
      scopes: this.scopes,
      ...(Object.keys(auth).length ? { auth } : {}),
      ...(this.deviceIdentity ? { device: this.buildDeviceConnectParams(nonce, signatureToken) } : {}),
    };
    void this.request('connect', params, { timeoutMs: 15_000 })
      .then(() => {
        this.connected = true;
        this.connectResolve?.();
        this.connectResolve = undefined;
        this.connectReject = undefined;
      })
      .catch(err => this.failConnection(err instanceof Error ? err : new Error(String(err))));
  }

  private buildDeviceConnectParams(nonce: string, token?: string): Record<string, unknown> {
    const identity = this.deviceIdentity!;
    const signedAt = Date.now();
    const payload = buildOpenClawDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: this.scopes,
      signedAtMs: signedAt,
      token,
      nonce,
      platform: process.platform,
      deviceFamily: this.deviceFamily,
    });
    return {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromIdentity(identity),
      signature: signBase64Url(identity.privateKeyPem, payload),
      signedAt,
      nonce,
    };
  }

  private request(method: string, params?: unknown, options?: { timeoutMs?: number | null }): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new Error('OpenClaw Gateway is not connected'));
    }
    const id = uuid();
    const frame = { type: 'req', id, method, params };
    const timeoutMs = options?.timeoutMs === null ? null : options?.timeoutMs ?? 120_000;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs === null
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`OpenClaw request timeout for ${method}`));
        }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket!.send(JSON.stringify(frame));
    });
  }

  async fetchHistory(sessionKey?: string, limit = 50): Promise<unknown[]> {
    this.requireConnection();
    const payload = await this.request('chat.history', {
      sessionKey: sessionKey || this.defaultSessionKey,
      limit,
    });
    if (Array.isArray(payload)) return payload;
    if (isObject(payload) && Array.isArray(payload.messages)) return payload.messages;
    return [];
  }

  private resolveActivePrompt(session: RegisteredSession, result: AgentResult): void {
    const active = session.active;
    if (!active || active.settled) return;
    active.settled = true;
    session.active = undefined;
    session.activeRunId = undefined;
    active.resolve(active.aborted ? { status: 'failed', error: 'OpenClaw execution aborted' } : result);
  }

  private failActivePrompt(session: RegisteredSession, message: string): void {
    this.resolveActivePrompt(session, { status: 'failed', error: message });
  }

  private failConnection(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
      this.connectResolve = undefined;
      this.connectReject = undefined;
    }
    this.connected = false;
    for (const request of this.pending.values()) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
    for (const session of this.sessions) {
      emitEvent(session.config, 'error', `OpenClaw Gateway failed: ${error.message}`);
      this.failActivePrompt(session, error.message);
    }
  }
}


async function loadWebSocketConstructor(): Promise<WebSocketConstructor> {
  const mod = await importOptionalPeer<typeof import('ws')>('OpenClaw Gateway', 'ws');
  return (mod.default ?? mod.WebSocket) as unknown as WebSocketConstructor;
}

export function buildOpenClawDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    normalizeDeviceMetadata(params.platform),
    normalizeDeviceMetadata(params.deviceFamily),
  ].join('|');
}

export function extractOpenClawText(value: unknown): string {
  if (!isObject(value)) return '';
  const deltaText = readStringProperty(value, 'deltaText');
  if (deltaText !== undefined) return deltaText;
  const text = readStringProperty(value, 'text');
  if (text !== undefined) return text;
  const content = (value as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(item => isObject(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '').join('');
  }
  const message = (value as Record<string, unknown>).message;
  if (isObject(message)) return extractOpenClawText(message);
  const delta = readStringProperty(value, 'delta');
  return delta ?? '';
}

export function mapOpenClawChatEvent(payload: Record<string, unknown>): ChatEventMapping {
  const state = readStringProperty(payload, 'state');
  switch (state) {
    case 'delta':
      return { type: 'output', content: extractOpenClawText(payload), terminal: false, replace: Boolean(payload.replace) };
    case 'final': {
      const finalText = extractOpenClawText(payload);
      return { type: 'complete', content: finalText, terminal: true, status: 'complete' };
    }
    case 'aborted':
      return { type: 'error', content: 'OpenClaw execution aborted', terminal: true, status: 'failed' };
    case 'error':
      return { type: 'error', content: readStringProperty(payload, 'errorMessage') ?? extractOpenClawText(payload) ?? 'OpenClaw execution failed', terminal: true, status: 'failed' };
    default:
      return { type: 'output', content: extractOpenClawText(payload), terminal: false };
  }
}

function emitEvent(
  config: AgentSessionConfig,
  type: AgentEventType,
  content: string,
  metadata?: { command?: string; file?: string; agentType?: AgentType; replace?: boolean },
): void {
  config.onEvent({
    id: uuid(),
    contextId: config.contextId,
    type,
    content,
    timestamp: Date.now(),
    metadata,
  });
}

async function buildOpenClawAttachmentsParam(
  attachments: AgentAttachment[] | undefined,
  workingDirectory: string,
): Promise<unknown[] | undefined> {
  if (!attachments?.length) return undefined;
  const mapped: unknown[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'base64_image') {
      if (!attachment.data || !attachment.mediaType) {
        throw new Error('OpenClaw base64_image attachments require data and mediaType.');
      }
      if (!getSafeExtension(attachment.mediaType)) {
        throw new Error(`OpenClaw rejected unsupported image MIME type: ${attachment.mediaType}`);
      }
      if (!isAttachmentSizeValid(attachment.data)) {
        throw new Error('OpenClaw rejected oversized image attachment.');
      }
      mapped.push({
        type: 'base64_image',
        fileName: attachment.displayName,
        displayName: attachment.displayName,
        content: attachment.data,
        mimeType: attachment.mediaType,
      });
      continue;
    }

    if (attachment.type === 'local_image') {
      if (!attachment.path) {
        throw new Error('OpenClaw local_image attachments require a path.');
      }
      if (!isPathWithinBoundary(attachment.path, workingDirectory)) {
        throw new Error(`OpenClaw blocked image attachment outside working directory: ${attachment.path}`);
      }
      const mimeType = LOCAL_IMAGE_MIME_TYPES[extname(attachment.path).toLowerCase()];
      if (!mimeType) {
        throw new Error(`OpenClaw rejected unsupported image attachment: ${attachment.path}`);
      }
      const content = (await readFile(attachment.path)).toString('base64');
      if (!isAttachmentSizeValid(content)) {
        throw new Error('OpenClaw rejected oversized image attachment.');
      }
      mapped.push({
        type: 'local_image',
        path: attachment.path,
        fileName: attachment.displayName,
        displayName: attachment.displayName,
        content,
        mimeType,
      });
      continue;
    }

    throw new Error('OpenClaw Gateway supports image attachments only; file attachments are not supported by this provider.');
  }
  return mapped.length ? mapped : undefined;
}

function isGatewayEvent(value: unknown): value is GatewayEvent {
  return isObject(value) && value.type === 'event' && typeof value.event === 'string';
}

function isGatewayResponse(value: unknown): value is GatewayResponse {
  return isObject(value) && value.type === 'res' && typeof value.id === 'string' && typeof value.ok === 'boolean';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function readDeviceIdentityFromEnv(env: NodeJS.ProcessEnv): OpenClawDeviceIdentity | undefined {
  const deviceId = env.OPENCLAW_DEVICE_ID;
  const publicKey = env.OPENCLAW_DEVICE_PUBLIC_KEY;
  const privateKeyPem = env.OPENCLAW_DEVICE_PRIVATE_KEY;
  if (!deviceId || !publicKey || !privateKeyPem) return undefined;
  return { deviceId, publicKey, privateKeyPem };
}

function sessionKeysMatch(eventSessionKey: string, expectedSessionKey: string): boolean {
  return eventSessionKey === expectedSessionKey || eventSessionKey.endsWith(`:${expectedSessionKey}`);
}

function rawDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map(entry => Buffer.from(entry))).toString('utf8');
  return String(data);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeDeviceMetadata(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function publicKeyRawBase64UrlFromIdentity(identity: OpenClawDeviceIdentity): string {
  if (identity.publicKeyPem) return publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  if (identity.publicKey) {
    const trimmed = identity.publicKey.trim();
    return trimmed.includes('BEGIN PUBLIC KEY') ? publicKeyRawBase64UrlFromPem(trimmed) : trimmed;
  }
  throw new Error('OpenClaw device identity requires publicKeyPem or publicKey.');
}

function signBase64Url(privateKeyPem: string, payload: string): string {
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
}
