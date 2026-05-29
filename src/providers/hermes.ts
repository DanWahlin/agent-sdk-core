import { spawn as defaultSpawn } from 'child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import { Readable, Writable } from 'stream';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { v4 as uuid } from 'uuid';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  Client,
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
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
  mcpServers?: McpServer[];
  /** Injected process spawner for deterministic tests */
  spawn?: SpawnHermesProcess;
  /** Extra environment values merged through the safe allowlist */
  env?: NodeJS.ProcessEnv;
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

type HermesAcpClient = ClientSideConnection;

interface RegisteredSession {
  config: AgentSessionConfig;
  destroyed: boolean;
  aborted: boolean;
  inFlightPrompt?: Promise<AgentResult>;
  rejectInFlight?: (error: Error) => void;
}

const CLIENT_VERSION = '0.4.1';
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
  private mcpServers: McpServer[];
  private spawnProcess: SpawnHermesProcess;
  private env?: NodeJS.ProcessEnv;
  private client: HermesAcpClient | null = null;
  private child: SpawnedHermesProcess | null = null;
  private stderrTail: string[] = [];
  private sessions = new Map<string, RegisteredSession>();

  constructor(options?: HermesProviderOptions) {
    this.command = options?.command || process.env.HERMES_COMMAND || 'hermes';
    this.model = options?.model || process.env.HERMES_MODEL || process.env.HERMES_INFERENCE_MODEL || 'configured default';
    this.acceptHooks = options?.acceptHooks ?? isTruthy(process.env.HERMES_ACCEPT_HOOKS);
    this.mcpServers = options?.mcpServers ?? [];
    this.spawnProcess = options?.spawn ?? defaultSpawn;
    this.env = options?.env;
  }

  async start(): Promise<void> {
    if (this.client) return;

    const args = ['acp'];
    if (this.acceptHooks) args.push('--accept-hooks');

    const child = this.spawnProcess(this.command, args, {
      env: createHermesEnvironment(this.env),
      windowsHide: true,
    });

    this.child = child;
    child.stderr.on('data', chunk => this.captureStderr(chunk.toString()));
    child.on('error', error => this.handleConnectionFailure(error));
    child.on('close', (code, signal) => {
      if (!this.client) return;
      this.handleConnectionFailure(new Error(
        `Hermes ACP exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}${this.formatStderr()}`,
      ));
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client = new ClientSideConnection(() => this.createAcpClient(), stream);
    this.client = client;

    try {
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: 'agent-sdk-core',
          version: CLIENT_VERSION,
        },
        clientCapabilities: {
          auth: { terminal: false },
          fs: {},
          terminal: false,
        },
      });
      console.log(`[hermes-provider] ACP initialized (command: ${this.command}, model: ${this.model})`);
    } catch (err: unknown) {
      await this.closeConnection();
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    await this.closeConnection();
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const client = this.requireClient();
    const sessionRequest = {
      cwd: config.workingDirectory,
      mcpServers: this.mcpServers,
    };
    const response = config.resumeSessionId
      ? await client.resumeSession({ ...sessionRequest, sessionId: config.resumeSessionId })
      : await client.newSession(sessionRequest);
    const hermesSessionId = 'sessionId' in response && typeof response.sessionId === 'string'
      ? response.sessionId
      : config.resumeSessionId;
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

      const promptPromise = this.sendPrompt(client, hermesSessionId, blocks, registered);
      registered.inFlightPrompt = promptPromise;
      try {
        return await promptPromise;
      } finally {
        if (registered.inFlightPrompt === promptPromise) {
          registered.inFlightPrompt = undefined;
          registered.rejectInFlight = undefined;
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
          await this.requireClient().cancel({ sessionId: hermesSessionId });
        } catch (err: unknown) {
          emitEvent(config, 'error', `Hermes cancel failed: ${errorMessage(err)}`);
        }
        await registered.inFlightPrompt?.catch(() => undefined);
      },

      destroy: async (): Promise<void> => {
        registered.destroyed = true;
        this.sessions.delete(hermesSessionId);
        try {
          await this.client?.closeSession({ sessionId: hermesSessionId });
        } catch {
          // Session cleanup must be safe in finally blocks even if Hermes already exited.
        }
      },
    };
  }

  private requireClient(): HermesAcpClient {
    if (!this.client) {
      throw new Error('Hermes ACP client not initialized — call start() first');
    }
    return this.client;
  }

  private createAcpClient(): Client {
    return {
      sessionUpdate: async params => this.handleSessionUpdate(params),
      requestPermission: async params => this.handlePermissionRequest(params),
    };
  }

  private async sendPrompt(
    client: HermesAcpClient,
    sessionId: string,
    prompt: ContentBlock[],
    session: RegisteredSession,
  ): Promise<AgentResult> {
    const promptRequest = client.prompt({ sessionId, prompt, messageId: uuid() });
    const response = await new Promise<Awaited<typeof promptRequest>>((resolve, reject) => {
      session.rejectInFlight = reject;
      promptRequest.then(resolve, reject);
    });
    const stopReason = response.stopReason;
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

  private handleSessionUpdate(params: SessionNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (!session || session.destroyed) return;

    const update = params.update;
    switch (update.sessionUpdate) {
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

  private async handlePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const toolCall = params.toolCall;
    emitToolUpdate(session.config, toolCall);
    const hookKind = mapToolKindToPermissionKind(toolCall.kind);
    const decision = session.config.hooks?.onPermissionRequest?.({ kind: hookKind }) ?? { kind: 'denied-by-rules' as const };
    const preferredKinds = decision.kind === 'approved'
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    const selected = preferredKinds
      .map(kind => params.options.find(option => option.kind === kind))
      .find(Boolean);

    if (selected) {
      return {
        outcome: {
          outcome: 'selected',
          optionId: selected.optionId,
        },
      };
    }

    return { outcome: { outcome: 'cancelled' } };
  }

  private handleConnectionFailure(error: Error): void {
    for (const session of this.sessions.values()) {
      session.destroyed = true;
      session.rejectInFlight?.(error);
      emitEvent(session.config, 'error', `Hermes ACP process failed: ${error.message}`);
    }
    this.sessions.clear();
    this.client = null;
    this.child = null;
  }

  private async closeConnection(): Promise<void> {
    const child = this.child;
    this.client = null;
    this.child = null;
    if (child) {
      child.kill('SIGTERM');
    }
  }

  private captureStderr(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    this.stderrTail.push(...lines);
    if (this.stderrTail.length > 20) {
      this.stderrTail.splice(0, this.stderrTail.length - 20);
    }
  }

  private formatStderr(): string {
    return this.stderrTail.length ? `\nHermes stderr:\n${this.stderrTail.join('\n')}` : '';
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
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
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

function emitToolUpdate(config: AgentSessionConfig, update: ToolCallUpdate): void {
  const kind = update.kind;
  const title = update.title ?? 'Hermes tool call';
  const rawInput = update.rawInput;
  const rawOutput = update.rawOutput;
  const file = update.locations?.map(location => location.path).find(Boolean);
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

function emitPlanUpdate(config: AgentSessionConfig, update: { entries?: Array<{ status?: string; content?: string }> }): void {
  const entries = update.entries ?? [];
  const content = entries
    .map(entry => {
      const status = entry.status ?? 'pending';
      const text = entry.content ?? '';
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

function mapToolKindToEventType(kind: ToolKind | null | undefined): AgentEventType {
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

function mapToolKindToPermissionKind(kind: ToolKind | null | undefined): string {
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

function extractContentText(content: ContentBlock): string {
  return content.type === 'text' ? content.text : '';
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
