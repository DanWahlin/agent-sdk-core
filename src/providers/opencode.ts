import { v4 as uuid } from 'uuid';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Event as OpenCodeEvent, Part as OpenCodePart } from '@opencode-ai/sdk';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
} from '../types/providers.js';
import { classifyToolKind } from './tool-classification.js';
import { diagnoseError, formatDiagnostic } from './diagnostics.js';

export interface OpenCodeProviderOptions {
  /** Model in "providerID/modelID" format (e.g., "anthropic/claude-sonnet-4-20250514") */
  model?: string;
  /** Hostname for the OpenCode server (default: '127.0.0.1') */
  hostname?: string;
  /** Port for the OpenCode server (default: auto) */
  port?: number;
  /** Connect to an existing OpenCode server instead of starting one */
  baseUrl?: string;
}

/**
 * Extract a human-readable message from an OpenCode SDK error object.
 */
function extractErrorMessage(error: { name: string; data?: unknown }): string {
  if (error.data && typeof error.data === 'object' && 'message' in error.data) {
    return (error.data as { message: string }).message;
  }
  return error.name;
}

export class OpenCodeProvider implements AgentProvider {
  readonly name: AgentType = 'opencode';
  readonly displayName = 'OpenCode';
  readonly model: string;

  private client: OpencodeClient | null = null;
  private server: { url: string; close(): void } | null = null;
  private providerID: string;
  private modelID: string;
  private baseUrl?: string;
  private hostname: string;
  private port: number;

  constructor(options?: OpenCodeProviderOptions) {
    this.model = options?.model || process.env.OPENCODE_MODEL || 'anthropic/claude-sonnet-4-20250514';
    const [providerID, ...rest] = this.model.split('/');
    this.providerID = providerID;
    this.modelID = rest.join('/');
    this.baseUrl = options?.baseUrl;
    this.hostname = options?.hostname || '127.0.0.1';
    this.port = options?.port || 0;
  }

  async start(): Promise<void> {
    if (this.baseUrl) {
      this.client = createOpencodeClient({ baseUrl: this.baseUrl });
      console.log(`[opencode-provider] connected to existing server at ${this.baseUrl}`);
    } else {
      const result = await createOpencode({
        hostname: this.hostname,
        ...(this.port ? { port: this.port } : {}),
      });
      this.client = result.client;
      this.server = result.server;
      console.log(`[opencode-provider] server started at ${result.server.url} (model: ${this.model})`);
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.client = null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (!this.client) {
      throw new Error('OpenCode client not initialized — call start() first');
    }

    const client = this.client;
    const providerID = this.providerID;
    const modelID = this.modelID;

    // Create or resume session
    let sessionId: string;
    if (config.resumeSessionId) {
      try {
        const existing = await client.session.get({ path: { id: config.resumeSessionId } });
        if (existing.data) {
          sessionId = existing.data.id;
        } else {
          throw new Error('Session not found');
        }
      } catch {
        console.log('[opencode-provider] resume failed, creating new session');
        const created = await client.session.create({ body: { title: config.contextId } });
        sessionId = created.data!.id;
      }
    } else {
      const created = await client.session.create({ body: { title: config.contextId } });
      sessionId = created.data!.id;
    }

    // Subscribe to SSE for real-time events
    let sseStream: AsyncGenerator<OpenCodeEvent> | null = null;
    let sseLoopDone: Promise<void> | null = null;
    let hasSse = false;
    let destroyed = false;

    try {
      const sse = await client.event.subscribe();
      sseStream = sse.stream as AsyncGenerator<OpenCodeEvent>;
      hasSse = true;
      sseLoopDone = (async () => {
        try {
          for await (const event of sseStream!) {
            if (destroyed) break;
            mapOpenCodeEvent(sessionId, event, config.contextId, config.onEvent);
          }
        } catch {
          // SSE connection lost — non-critical, prompt() still returns final result
        }
      })();
    } catch {
      // SSE subscription failed — proceed without real-time events
      console.warn('[opencode-provider] SSE subscription failed, real-time events unavailable');
    }

    let isFirstPrompt = true;

    const agentSession: AgentSession = {
      get sessionId() {
        return sessionId;
      },

      async execute(prompt: string): Promise<AgentResult> {
        try {
          const result = await client.session.prompt({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              parts: [{ type: 'text', text: prompt }],
              ...(isFirstPrompt && config.systemPrompt ? { system: config.systemPrompt } : {}),
            },
          });
          isFirstPrompt = false;

          const info = result.data?.info;
          if (info && 'error' in info && info.error) {
            const errMsg = extractErrorMessage(info.error);
            const diag = formatDiagnostic(diagnoseError('opencode', errMsg, config.workingDirectory));
            return { status: 'failed', error: diag };
          }

          // Emit events from response parts only when SSE is unavailable
          if (!hasSse && result.data?.parts) {
            emitPartsAsEvents(result.data.parts, sessionId, config.contextId, config.onEvent);
          }

          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'complete',
            content: 'OpenCode completed the task.', timestamp: Date.now(),
          });
          return { status: 'complete' };
        } catch (err: unknown) {
          isFirstPrompt = false;
          const message = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('opencode', message, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `OpenCode SDK error: ${diag}`, timestamp: Date.now(),
          });
          return { status: 'failed', error: diag };
        }
      },

      async send(message: string): Promise<void> {
        try {
          const result = await client.session.prompt({
            path: { id: sessionId },
            body: {
              model: { providerID, modelID },
              parts: [{ type: 'text', text: message }],
            },
          });
          if (!hasSse && result.data?.parts) {
            emitPartsAsEvents(result.data.parts, sessionId, config.contextId, config.onEvent);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('opencode', msg, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `OpenCode SDK error: ${diag}`, timestamp: Date.now(),
          });
        }
      },

      async abort(): Promise<void> {
        try { await client.session.abort({ path: { id: sessionId } }); } catch { /* ignore */ }
      },

      async destroy(): Promise<void> {
        destroyed = true;
        if (sseStream) {
          try { await sseStream.return(undefined as never); } catch { /* ignore */ }
          sseStream = null;
        }
        if (sseLoopDone) {
          try { await sseLoopDone; } catch { /* ignore */ }
        }
        try { await client.session.delete({ path: { id: sessionId } }); } catch { /* ignore */ }
      },
    };

    return agentSession;
  }
}

/**
 * Map an OpenCode SSE event to unified AgentEvent(s).
 * Only processes events belonging to the given session.
 */
export function mapOpenCodeEvent(
  sessionId: string,
  event: OpenCodeEvent,
  contextId: string,
  onEvent: AgentSessionConfig['onEvent'],
): void {
  switch (event.type) {
    case 'message.part.updated': {
      const { part, delta } = event.properties;
      if (part.sessionID !== sessionId) return;

      switch (part.type) {
        case 'text':
          onEvent({
            id: uuid(), contextId, type: 'output',
            content: delta || part.text, timestamp: Date.now(),
          });
          break;
        case 'reasoning':
          onEvent({
            id: uuid(), contextId, type: 'thinking',
            content: delta || part.text, timestamp: Date.now(),
          });
          break;
        case 'tool': {
          const toolName = part.tool;
          const state = part.state;
          if (state.status === 'running') {
            const kind = classifyToolKind(toolName);
            onEvent({
              id: uuid(), contextId, type: kind,
              content: `${toolName}: ${JSON.stringify(state.input)}`,
              timestamp: Date.now(),
              metadata: { command: toolName },
            });
          } else if (state.status === 'completed') {
            onEvent({
              id: uuid(), contextId, type: 'command_output',
              content: state.output || '',
              timestamp: Date.now(),
            });
          } else if (state.status === 'error') {
            onEvent({
              id: uuid(), contextId, type: 'error',
              content: state.error,
              timestamp: Date.now(),
            });
          }
          break;
        }
        case 'step-start':
          onEvent({
            id: uuid(), contextId, type: 'thinking',
            content: 'Starting a new step...', timestamp: Date.now(),
          });
          break;
        case 'patch':
          for (const file of part.files) {
            onEvent({
              id: uuid(), contextId, type: 'file_write',
              content: file, timestamp: Date.now(),
              metadata: { file },
            });
          }
          break;
        default:
          break;
      }
      break;
    }

    case 'session.error': {
      const props = event.properties;
      if (props.sessionID && props.sessionID !== sessionId) return;
      const errMsg = props.error ? extractErrorMessage(props.error) : 'Session error';
      onEvent({ id: uuid(), contextId, type: 'error', content: errMsg, timestamp: Date.now() });
      break;
    }

    case 'session.idle': {
      if (event.properties.sessionID !== sessionId) return;
      onEvent({ id: uuid(), contextId, type: 'complete', content: 'Session idle.', timestamp: Date.now() });
      break;
    }

    default:
      break;
  }
}

/**
 * Emit events from response parts (fallback for when SSE is unavailable).
 */
function emitPartsAsEvents(
  parts: OpenCodePart[],
  sessionId: string,
  contextId: string,
  onEvent: AgentSessionConfig['onEvent'],
): void {
  for (const part of parts) {
    if (part.sessionID !== sessionId) continue;
    switch (part.type) {
      case 'text':
        onEvent({ id: uuid(), contextId, type: 'output', content: part.text, timestamp: Date.now() });
        break;
      case 'reasoning':
        onEvent({ id: uuid(), contextId, type: 'thinking', content: part.text, timestamp: Date.now() });
        break;
      case 'tool':
        if (part.state.status === 'completed') {
          const kind = classifyToolKind(part.tool);
          onEvent({
            id: uuid(), contextId, type: kind,
            content: `${part.tool}: ${part.state.title || ''}`,
            timestamp: Date.now(),
            metadata: { command: part.tool },
          });
        }
        break;
      case 'patch':
        for (const file of part.files) {
          onEvent({
            id: uuid(), contextId, type: 'file_write',
            content: file, timestamp: Date.now(),
            metadata: { file },
          });
        }
        break;
      default:
        break;
    }
  }
}
