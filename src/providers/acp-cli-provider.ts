import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import { Readable, Writable } from 'stream';
import { v4 as uuid } from 'uuid';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentAttachment,
} from '../types/providers.js';
import { diagnoseError, formatDiagnostic } from './diagnostics.js';
import {
  buildAcpPromptBlocks,
  emitAcpPlanUpdate,
  emitAcpToolUpdate,
  mapAcpToolKindToPermissionKind,
} from './acp-utils.js';
import { emitAgentEvent } from './events.js';

export type SpawnedAcpProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill'> & {
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): SpawnedAcpProcess;
  on(event: 'error', listener: (error: Error) => void): SpawnedAcpProcess;
};

export type SpawnAcpProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => SpawnedAcpProcess;

type AcpClient = ClientSideConnection;

type RegisteredSession = {
  config: AgentSessionConfig;
  destroyed: boolean;
  aborted: boolean;
  inFlightPrompt?: Promise<AgentResult>;
  rejectInFlight?: (error: Error) => void;
};

export interface AcpCliProviderBaseConfig {
  name: AgentType;
  displayName: string;
  providerLabel: string;
  diagnosticName: string;
  command: string;
  model: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  spawnProcess: SpawnAcpProcess;
  sessionRequest: (config: AgentSessionConfig) => Record<string, unknown>;
  clientVersion: string;
  consolePrefix: string;
  notInitializedMessage: string;
  missingSessionMessage: string;
  destroyedMessage: string;
  abortedMessage: string;
  completedMessage: string;
}

export class AcpCliProviderBase implements AgentProvider {
  readonly name: AgentType;
  readonly displayName: string;
  readonly model: string;

  private config: AcpCliProviderBaseConfig;
  private client: AcpClient | null = null;
  private child: SpawnedAcpProcess | null = null;
  private stderrTail: string[] = [];
  private sessions = new Map<string, RegisteredSession>();

  constructor(config: AcpCliProviderBaseConfig) {
    this.config = config;
    this.name = config.name;
    this.displayName = config.displayName;
    this.model = config.model;
  }

  async start(): Promise<void> {
    if (this.client) return;

    const child = this.config.spawnProcess(this.config.command, this.config.args, {
      env: this.config.env,
      windowsHide: true,
    });

    this.child = child;
    child.stderr.on('data', chunk => this.captureStderr(chunk.toString()));
    child.on('error', error => this.handleConnectionFailure(error));
    child.on('close', (code, signal) => {
      if (!this.client) return;
      this.handleConnectionFailure(new Error(
        `${this.config.providerLabel} ACP exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}${this.formatStderr()}`,
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
          version: this.config.clientVersion,
        },
        clientCapabilities: {
          auth: { terminal: false },
          fs: {},
          terminal: false,
        },
      });
      console.log(`[${this.config.consolePrefix}] ACP initialized (command: ${this.config.command}, model: ${this.model})`);
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
    const sessionRequest = this.config.sessionRequest(config);
    const response = config.resumeSessionId
      ? await client.resumeSession({ ...sessionRequest, sessionId: config.resumeSessionId } as Parameters<AcpClient['resumeSession']>[0])
      : await client.newSession(sessionRequest as Parameters<AcpClient['newSession']>[0]);
    const sessionId = 'sessionId' in response && typeof response.sessionId === 'string'
      ? response.sessionId
      : config.resumeSessionId;
    if (!sessionId) {
      throw new Error(this.config.missingSessionMessage);
    }

    const registered: RegisteredSession = {
      config,
      destroyed: false,
      aborted: false,
    };
    this.sessions.set(sessionId, registered);

    let initialPromptSent = Boolean(config.resumeSessionId);
    let promptLock: Promise<void> = Promise.resolve();

    const runPrompt = async (
      prompt: string,
      attachments: AgentAttachment[] | undefined,
      includeInitialContext: boolean,
    ): Promise<AgentResult> => {
      if (registered.destroyed) {
        return { status: 'failed', error: this.config.destroyedMessage };
      }

      registered.aborted = false;
      const blocks = await buildAcpPromptBlocks(
        this.config.providerLabel,
        includeInitialContext && config.systemPrompt ? `${config.systemPrompt}\n\n${prompt}` : prompt,
        attachments,
        config.workingDirectory,
      );

      const promptPromise = this.sendPrompt(client, sessionId, blocks, registered);
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
        return sessionId;
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
          const diag = formatDiagnostic(diagnoseError(this.config.diagnosticName, errorMessage(err), config.workingDirectory));
          emitAgentEvent(config, 'error', `${this.config.providerLabel} ACP error: ${diag}`);
          return { status: 'failed', error: diag };
        }
      }),

      send: async (message: string, attachments?: AgentAttachment[]): Promise<void> => {
        await withPromptLock(async () => {
          try {
            await runPrompt(message, attachments, false);
          } catch (err: unknown) {
            const diag = formatDiagnostic(diagnoseError(this.config.diagnosticName, errorMessage(err), config.workingDirectory));
            emitAgentEvent(config, 'error', `${this.config.providerLabel} ACP error: ${diag}`);
          }
        });
      },

      abort: async (): Promise<void> => {
        registered.aborted = true;
        try {
          await this.requireClient().cancel({ sessionId });
        } catch (err: unknown) {
          emitAgentEvent(config, 'error', `${this.config.providerLabel} cancel failed: ${errorMessage(err)}`);
        }
        await registered.inFlightPrompt?.catch(() => undefined);
      },

      destroy: async (): Promise<void> => {
        registered.destroyed = true;
        this.sessions.delete(sessionId);
        try {
          await this.client?.closeSession({ sessionId });
        } catch {
          // Session cleanup must be safe in finally blocks even if the bridge already exited.
        }
      },
    };
  }

  private requireClient(): AcpClient {
    if (!this.client) {
      throw new Error(this.config.notInitializedMessage);
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
    client: AcpClient,
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
      return { status: 'failed', error: this.config.abortedMessage };
    }
    if (stopReason === 'end_turn' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      emitAgentEvent(session.config, 'complete', this.config.completedMessage);
      return { status: 'complete' };
    }
    const error = `${this.config.providerLabel} stopped with reason: ${stopReason}`;
    emitAgentEvent(session.config, 'error', error);
    return { status: 'failed', error };
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (!session || session.destroyed) return;

    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractContentText(update.content);
        if (text) emitAgentEvent(session.config, 'output', text);
        break;
      }
      case 'agent_thought_chunk': {
        const text = extractContentText(update.content);
        if (text) emitAgentEvent(session.config, 'thinking', text);
        break;
      }
      case 'tool_call':
      case 'tool_call_update':
        emitAcpToolUpdate(session.config, update, this.config.providerLabel);
        break;
      case 'plan':
        emitAcpPlanUpdate(session.config, update);
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
    emitAcpToolUpdate(session.config, toolCall, this.config.providerLabel);
    const hookKind = mapAcpToolKindToPermissionKind(toolCall.kind);
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
      emitAgentEvent(session.config, 'error', `${this.config.providerLabel} ACP process failed: ${error.message}`);
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
    return this.stderrTail.length ? `\n${this.config.providerLabel} stderr:\n${this.stderrTail.join('\n')}` : '';
  }
}

function extractContentText(content: ContentBlock): string {
  return content.type === 'text' ? content.text : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
