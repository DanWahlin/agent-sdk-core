import { spawn as defaultSpawn } from 'child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
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
import { getSafeExtension, isAttachmentSizeValid, isPathWithinBoundary } from './validation.js';

export interface HermesProviderOptions {
  /** Hermes CLI command or absolute path (default: HERMES_COMMAND or "hermes") */
  command?: string;
  /** Display/configured model name. Hermes ACP reads its active model from Hermes config. */
  model?: string;
  /** Auto-approve unseen Hermes shell hooks for headless ACP startup */
  acceptHooks?: boolean;
  /** MCP server definitions forwarded to session/new */
  mcpServers?: unknown[];
  /** Injected process spawner for deterministic tests */
  spawn?: SpawnHermesProcess;
  /** Extra environment values merged through the safe allowlist */
  env?: NodeJS.ProcessEnv;
  /** Timeout for ACP initialize/session requests */
  requestTimeoutMs?: number;
}

type SpawnedHermesProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill'> & {
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedHermesProcess;
  on(event: 'error', listener: (error: Error) => void): SpawnedHermesProcess;
};

type SpawnHermesProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => SpawnedHermesProcess;

type JsonRpcId = number | string | null;
type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string };

type AcpUpdate = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RegisteredSession {
  config: AgentSessionConfig;
  destroyed: boolean;
  aborted: boolean;
  inFlightPrompt?: Promise<AgentResult>;
}

const HERMES_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROMPT_REQUEST_TIMEOUT_MS = 0;
const SAFE_ENV_PREFIXES = ['HERMES_'];
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'TERM',
]);
const DENIED_ENV_KEYS = new Set(['API_KEY', 'DATABASE_URL', 'VITE_API_KEY']);
const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export class HermesProvider implements AgentProvider {
  readonly name: AgentType = 'hermes';
  readonly displayName = 'Hermes Agent';
  readonly model: string;

  private command: string;
  private acceptHooks: boolean;
  private mcpServers: unknown[];
  private spawnProcess: SpawnHermesProcess;
  private env?: NodeJS.ProcessEnv;
  private requestTimeoutMs: number;
  private connection: HermesAcpConnection | null = null;
  private sessions = new Map<string, RegisteredSession>();

  constructor(options?: HermesProviderOptions) {
    this.command = options?.command || process.env.HERMES_COMMAND || 'hermes';
    this.model = options?.model || process.env.HERMES_MODEL || process.env.HERMES_INFERENCE_MODEL || 'configured default';
    this.acceptHooks = options?.acceptHooks ?? isTruthy(process.env.HERMES_ACCEPT_HOOKS);
    this.mcpServers = options?.mcpServers ?? [];
    this.spawnProcess = options?.spawn ?? defaultSpawn;
    this.env = options?.env;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.connection) return;

    const args = ['acp'];
    if (this.acceptHooks) args.push('--accept-hooks');

    const connection = new HermesAcpConnection({
      command: this.command,
      args,
      env: createHermesEnvironment(this.env),
      spawnProcess: this.spawnProcess,
      requestTimeoutMs: this.requestTimeoutMs,
      onSessionUpdate: (sessionId, update) => this.handleSessionUpdate(sessionId, update),
      onClientRequest: (method, params) => this.handleClientRequest(method, params),
      onFailure: error => this.handleConnectionFailure(error),
    });

    this.connection = connection;
    try {
      await connection.start();
      await connection.sendRequest('initialize', {
        protocolVersion: HERMES_PROTOCOL_VERSION,
        clientInfo: {
          name: 'agent-sdk-core',
          version: '0.4.0',
        },
        clientCapabilities: {
          auth: { terminal: false },
          fs: {},
        },
      });
      console.log(`[hermes-provider] ACP initialized (command: ${this.command}, model: ${this.model})`);
    } catch (err: unknown) {
      await connection.close();
      this.connection = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.sessions.clear();
    await connection?.close();
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const connection = this.requireConnection();
    const response = config.resumeSessionId
      ? await connection.sendRequest('session/resume', { sessionId: config.resumeSessionId }, this.requestTimeoutMs)
      : await connection.sendRequest('session/new', { cwd: config.workingDirectory, mcpServers: this.mcpServers }, this.requestTimeoutMs);
    const hermesSessionId = config.resumeSessionId ?? getStringProperty(response, 'sessionId');
    if (!hermesSessionId) {
      throw new Error('Hermes ACP did not return a sessionId.');
    }

    const registered: RegisteredSession = {
      config,
      destroyed: false,
      aborted: false,
    };
    this.sessions.set(hermesSessionId, registered);

    let initialPromptSent = Boolean(config.resumeSessionId);
    let promptLock: Promise<void> = Promise.resolve();

    const runPrompt = async (
      prompt: string,
      attachments: AgentAttachment[] | undefined,
      includeInitialContext: boolean,
    ): Promise<AgentResult> => {
      if (registered.destroyed) {
        return { status: 'failed', error: 'Hermes session has been destroyed' };
      }

      registered.aborted = false;
      const blocks = await buildAcpPromptBlocks(
        includeInitialContext && config.systemPrompt ? `${config.systemPrompt}\n\n${prompt}` : prompt,
        attachments,
        config.workingDirectory,
      );

      const promptPromise = this.sendPrompt(connection, hermesSessionId, blocks, registered);
      registered.inFlightPrompt = promptPromise;
      try {
        return await promptPromise;
      } finally {
        if (registered.inFlightPrompt === promptPromise) {
          registered.inFlightPrompt = undefined;
        }
      }
    };

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

    return {
      get sessionId() {
        return hermesSessionId;
      },

      execute: async (prompt: string, attachments?: AgentAttachment[]): Promise<AgentResult> => withPromptLock(async () => {
        try {
          const merged = initialPromptSent
            ? attachments
            : [...(config.attachments ?? []), ...(attachments ?? [])];
          const result = await runPrompt(prompt, merged, !initialPromptSent);
          initialPromptSent = true;
          return result;
        } catch (err: unknown) {
          const diag = formatDiagnostic(diagnoseError('hermes', errorMessage(err), config.workingDirectory));
          emitEvent(config, 'error', `Hermes ACP error: ${diag}`);
          return { status: 'failed', error: diag };
        }
      }),

      send: async (message: string, attachments?: AgentAttachment[]): Promise<void> => {
        await withPromptLock(async () => {
          try {
            await runPrompt(message, attachments, false);
          } catch (err: unknown) {
            const diag = formatDiagnostic(diagnoseError('hermes', errorMessage(err), config.workingDirectory));
            emitEvent(config, 'error', `Hermes ACP error: ${diag}`);
          }
        });
      },

      abort: async (): Promise<void> => {
        registered.aborted = true;
        try {
          await this.requireConnection().sendRequest('session/cancel', { sessionId: hermesSessionId }, this.requestTimeoutMs);
        } catch (err: unknown) {
          emitEvent(config, 'error', `Hermes cancel failed: ${errorMessage(err)}`);
        }
        await registered.inFlightPrompt?.catch(() => undefined);
      },

      destroy: async (): Promise<void> => {
        registered.destroyed = true;
        this.sessions.delete(hermesSessionId);
        try {
          await this.connection?.sendRequest('session/close', { sessionId: hermesSessionId }, this.requestTimeoutMs);
        } catch {
          // Session cleanup must be safe in finally blocks even if Hermes already exited.
        }
      },
    };
  }

  private requireConnection(): HermesAcpConnection {
    if (!this.connection) {
      throw new Error('Hermes ACP client not initialized — call start() first');
    }
    return this.connection;
  }

  private async sendPrompt(
    connection: HermesAcpConnection,
    sessionId: string,
    prompt: AcpContentBlock[],
    session: RegisteredSession,
  ): Promise<AgentResult> {
    const response = await connection.sendRequest(
      'session/prompt',
      { sessionId, prompt, messageId: uuid() },
      PROMPT_REQUEST_TIMEOUT_MS,
    );
    const stopReason = getStringProperty(response, 'stopReason') ?? 'end_turn';
    if (session.aborted || stopReason === 'cancelled') {
      return { status: 'failed', error: 'Hermes execution aborted' };
    }
    if (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      emitEvent(session.config, 'complete', 'Hermes completed the task.');
      return { status: 'complete' };
    }
    const error = `Hermes stopped with reason: ${stopReason}`;
    emitEvent(session.config, 'error', error);
    return { status: 'failed', error };
  }

  private handleSessionUpdate(sessionId: string, update: AcpUpdate): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.destroyed) return;

    const updateKind = getUpdateKind(update);
    switch (updateKind) {
      case 'agent_message_chunk': {
        const text = extractContentText(update.content);
        if (text) emitEvent(session.config, 'output', text);
        break;
      }
      case 'agent_thought_chunk': {
        const text = extractContentText(update.content);
        if (text) emitEvent(session.config, 'thinking', text);
        break;
      }
      case 'tool_call':
      case 'tool_call_update':
        emitToolUpdate(session.config, update);
        break;
      case 'plan':
        emitPlanUpdate(session.config, update);
        break;
      default:
        break;
    }
  }

  private async handleClientRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') {
      throw new JsonRpcRequestError(-32601, `Method not found: ${method}`);
    }
    if (!isObject(params)) {
      throw new JsonRpcRequestError(-32602, 'Invalid params');
    }

    const sessionId = getStringProperty(params, 'sessionId');
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const toolCall = isObject(params.toolCall) ? params.toolCall : {};
    emitToolUpdate(session.config, toolCall);
    const hookKind = mapToolKindToPermissionKind(getStringProperty(toolCall, 'kind'));
    const decision = session.config.hooks?.onPermissionRequest?.({ kind: hookKind }) ?? { kind: 'denied-by-rules' as const };
    const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
    const preferredKinds = decision.kind === 'approved'
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    const selected = preferredKinds
      .map(kind => options.find(option => option.kind === kind))
      .find(Boolean);

    if (selected) {
      return {
        outcome: {
          outcome: 'selected',
          optionId: getStringProperty(selected, 'optionId') ?? getStringProperty(selected, 'option_id'),
        },
      };
    }

    return { outcome: { outcome: 'cancelled' } };
  }

  private handleConnectionFailure(error: Error): void {
    for (const session of this.sessions.values()) {
      session.destroyed = true;
      emitEvent(session.config, 'error', `Hermes ACP process failed: ${error.message}`);
    }
    this.sessions.clear();
    this.connection = null;
  }
}

class HermesAcpConnection {
  private command: string;
  private args: string[];
  private env: NodeJS.ProcessEnv;
  private spawnProcess: SpawnHermesProcess;
  private requestTimeoutMs: number;
  private onSessionUpdate: (sessionId: string, update: AcpUpdate) => void;
  private onClientRequest: (method: string, params: unknown) => Promise<unknown>;
  private onFailure: (error: Error) => void;
  private child: SpawnedHermesProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private stdoutBuffer = '';
  private stderrTail: string[] = [];
  private closed = false;

  constructor(options: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    spawnProcess: SpawnHermesProcess;
    requestTimeoutMs: number;
    onSessionUpdate: (sessionId: string, update: AcpUpdate) => void;
    onClientRequest: (method: string, params: unknown) => Promise<unknown>;
    onFailure: (error: Error) => void;
  }) {
    this.command = options.command;
    this.args = options.args;
    this.env = options.env;
    this.spawnProcess = options.spawnProcess;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onSessionUpdate = options.onSessionUpdate;
    this.onClientRequest = options.onClientRequest;
    this.onFailure = options.onFailure;
  }

  async start(): Promise<void> {
    this.child = this.spawnProcess(this.command, this.args, {
      env: this.env,
      windowsHide: true,
    });
    this.child.stdout.on('data', chunk => this.handleStdout(chunk.toString()));
    this.child.stderr.on('data', chunk => this.captureStderr(chunk.toString()));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', (code, signal) => {
      if (this.closed) return;
      this.fail(new Error(`Hermes ACP exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}${this.formatStderr()}`));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAll(new Error('Hermes ACP connection closed'));
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  sendRequest(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Hermes ACP request timed out: ${method}${this.formatStderr()}`));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, {
        resolve,
        reject,
        timer: timer ?? undefinedTimer(),
      });
      try {
        this.writeMessage(message);
      } catch (err: unknown) {
        this.pending.delete(id);
        clearTimeout(timer ?? undefinedTimer());
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private writeMessage(message: JsonRpcMessage): void {
    if (!this.child || this.closed) {
      throw new Error('Hermes ACP process is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '').replace(/^\uFEFF/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (err: unknown) {
      console.warn(`[hermes-provider] ignored malformed ACP frame: ${errorMessage(err)}`);
      return;
    }

    if ('id' in message && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id ?? null);
      if (!pending) return;
      this.pending.delete(message.id ?? null);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Hermes ACP error ${message.error.code ?? 'unknown'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      if (message.method === 'session/update') {
        this.handleSessionUpdateNotification(message.params);
      } else if ('id' in message) {
        this.handleAgentRequest(message.id ?? null, message.method, message.params);
      }
    }
  }

  private handleSessionUpdateNotification(params: unknown): void {
    if (!isObject(params)) return;
    const sessionId = getStringProperty(params, 'sessionId');
    const update = isObject(params.update) ? params.update : undefined;
    if (sessionId && update) {
      this.onSessionUpdate(sessionId, update);
    }
  }

  private handleAgentRequest(id: JsonRpcId, method: string, params: unknown): void {
    void this.onClientRequest(method, params)
      .then(result => this.sendResponse(id, result))
      .catch((err: unknown) => {
        const code = err instanceof JsonRpcRequestError ? err.code : -32603;
        this.sendError(id, code, errorMessage(err));
      });
  }

  private captureStderr(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    this.stderrTail.push(...lines);
    if (this.stderrTail.length > 20) {
      this.stderrTail.splice(0, this.stderrTail.length - 20);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const failure = new Error(`${error.message}${this.formatStderr()}`);
    this.rejectAll(failure);
    this.onFailure(failure);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private formatStderr(): string {
    return this.stderrTail.length ? `\nHermes stderr:\n${this.stderrTail.join('\n')}` : '';
  }
}

class JsonRpcRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export function createHermesEnvironment(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const copyAllowed = ([key, value]: [string, string | undefined]) => {
    if (value === undefined || DENIED_ENV_KEYS.has(key)) return;
    if (SAFE_ENV_KEYS.has(key) || SAFE_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
      env[key] = value;
    }
  };

  for (const entry of Object.entries(process.env)) copyAllowed(entry);
  for (const entry of Object.entries(extraEnv ?? {})) copyAllowed(entry);
  return env;
}

export async function buildAcpPromptBlocks(
  prompt: string,
  attachments: AgentAttachment[] | undefined,
  workingDirectory: string,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.displayName) {
      blocks.push({ type: 'text', text: `[${attachment.displayName}]` });
    }

    if (attachment.type === 'base64_image') {
      if (!attachment.data || !attachment.mediaType) {
        throw new Error('Hermes base64_image attachments require data and mediaType.');
      }
      if (!getSafeExtension(attachment.mediaType)) {
        throw new Error(`Hermes rejected unsupported image MIME type: ${attachment.mediaType}`);
      }
      if (!isAttachmentSizeValid(attachment.data)) {
        throw new Error('Hermes rejected oversized image attachment.');
      }
      blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mediaType });
      continue;
    }

    if (attachment.type === 'local_image') {
      if (!attachment.path) {
        throw new Error('Hermes local_image attachments require a path.');
      }
      if (!isPathWithinBoundary(attachment.path, workingDirectory)) {
        throw new Error(`Hermes blocked image attachment outside working directory: ${attachment.path}`);
      }
      const mimeType = LOCAL_IMAGE_MIME_TYPES[extname(attachment.path).toLowerCase()];
      if (!mimeType) {
        throw new Error(`Hermes rejected unsupported image attachment: ${attachment.path}`);
      }
      const data = (await readFile(attachment.path)).toString('base64');
      if (!isAttachmentSizeValid(data)) {
        throw new Error('Hermes rejected oversized image attachment.');
      }
      blocks.push({ type: 'image', data, mimeType, uri: attachment.path });
      continue;
    }

    throw new Error('Hermes ACP supports image attachments only; file attachments are not supported by this provider.');
  }
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

function emitToolUpdate(config: AgentSessionConfig, update: Record<string, unknown>): void {
  const kind = getStringProperty(update, 'kind');
  const title = getStringProperty(update, 'title') ?? 'Hermes tool call';
  const rawInput = update.rawInput ?? update.raw_input;
  const rawOutput = update.rawOutput ?? update.raw_output;
  const locations = Array.isArray(update.locations) ? update.locations.filter(isObject) : [];
  const file = locations.map(location => getStringProperty(location, 'path')).find(Boolean);
  const eventType = mapToolKindToEventType(kind);
  const content = rawOutput !== undefined
    ? stringifyToolValue(rawOutput)
    : rawInput !== undefined
      ? `${title}: ${stringifyToolValue(rawInput)}`
      : title;

  emitEvent(config, eventType, content, {
    command: kind === 'execute' ? extractCommand(rawInput) ?? title : title,
    file,
  });
}

function emitPlanUpdate(config: AgentSessionConfig, update: Record<string, unknown>): void {
  const entries = Array.isArray(update.entries) ? update.entries.filter(isObject) : [];
  const content = entries
    .map(entry => {
      const status = getStringProperty(entry, 'status') ?? 'pending';
      const text = getStringProperty(entry, 'content') ?? '';
      return text ? `${status}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  if (content) emitEvent(config, 'thinking', content);
}

function emitEvent(
  config: AgentSessionConfig,
  type: AgentEventType,
  content: string,
  metadata?: { command?: string; file?: string },
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

function mapToolKindToEventType(kind: string | undefined): AgentEventType {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return 'file_read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write';
    case 'execute':
      return 'command';
    case 'think':
      return 'thinking';
    default:
      return 'tool_call';
  }
}

function mapToolKindToPermissionKind(kind: string | undefined): string {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'edit':
    case 'delete':
    case 'move':
      return 'write';
    case 'fetch':
      return 'url';
    case 'read':
    case 'search':
      return 'read';
    default:
      return kind ?? 'other';
  }
}

function extractContentText(content: unknown): string {
  if (!isObject(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (isObject(content.content)) return extractContentText(content.content);
  return '';
}

function extractCommand(input: unknown): string | undefined {
  return isObject(input)
    ? getStringProperty(input, 'command') ?? getStringProperty(input, 'cmd')
    : undefined;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getUpdateKind(update: Record<string, unknown>): string | undefined {
  return getStringProperty(update, 'sessionUpdate') ?? getStringProperty(update, 'session_update');
}

function getStringProperty(value: unknown, key: string): string | undefined {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

function undefinedTimer(): NodeJS.Timeout {
  return undefined as unknown as NodeJS.Timeout;
}
