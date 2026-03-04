import { v4 as uuid, v4 as randomUUID } from 'uuid';
import {
  CopilotClient,
  type CopilotSession,
  type SessionEvent,
} from '@github/copilot-sdk';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentAttachment,
} from '../types/providers.js';
import { classifyToolKind } from './tool-classification.js';
import { diagnoseError, formatDiagnostic } from './diagnostics.js';
import { getSafeExtension, isAttachmentSizeValid, isPathWithinBoundary } from './validation.js';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export interface CopilotProviderOptions {
  model?: string;
  /** Comma-separated tool kinds to deny (e.g., "dangerous_tool,rm_rf") */
  deniedTools?: string;
}

export class CopilotProvider implements AgentProvider {
  readonly name: AgentType = 'copilot';
  readonly displayName = 'GitHub Copilot';
  readonly model: string;

  private client: CopilotClient | null = null;
  private deniedTools: Set<string>;

  constructor(options?: CopilotProviderOptions) {
    this.model = options?.model || process.env.COPILOT_MODEL || 'claude-opus-4-20250514';
    this.deniedTools = new Set(
      (options?.deniedTools || process.env.COPILOT_DENIED_TOOLS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
    );
  }

  async start(): Promise<void> {
    this.client = new CopilotClient({
      logLevel: 'info',
      autoRestart: true,
    });
    await this.client.start();
    console.log(`[copilot-provider] SDK client started (model: ${this.model})`);
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (!this.client) {
      throw new Error('Copilot client not initialized — call start() first');
    }

    const deniedTools = this.deniedTools;
    const repoPath = config.repoPath;
    const worktreePath = repoPath && config.workingDirectory !== repoPath
      ? config.workingDirectory
      : undefined;

    // Build hooks: merge worktree path rewriting with consumer-provided hooks
    const consumerHooks = config.hooks;
    const hooks = worktreePath && repoPath
      ? {
          onPreToolUse: (input: { toolName: string; toolArgs: unknown; cwd: string }) => {
            // Consumer hook first
            if (consumerHooks?.onPreToolUse) {
              const result = consumerHooks.onPreToolUse(input);
              if (result && typeof result === 'object') {
                input = { ...input, ...result };
              }
            }
            // Then worktree path rewriting
            if (!input.toolArgs || typeof input.toolArgs !== 'object') return {};
            const args = input.toolArgs as Record<string, unknown>;
            let changed = false;

            function rewriteValue(val: unknown): unknown {
              if (typeof val === 'string' && val.includes(repoPath!)) {
                const rewritten = val.replaceAll(repoPath!, worktreePath!);
                // Validate rewritten path stays within worktree boundary
                if (rewritten.includes('..') && !isPathWithinBoundary(rewritten, worktreePath!)) {
                  console.warn(`[copilot-provider] blocked path traversal: ${rewritten}`);
                  return val; // Return original, don't rewrite
                }
                changed = true;
                return rewritten;
              }
              if (Array.isArray(val)) return val.map(rewriteValue);
              if (val && typeof val === 'object') {
                const obj: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
                  obj[k] = rewriteValue(v);
                }
                return obj;
              }
              return val;
            }

            const modifiedArgs: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(args)) {
              modifiedArgs[key] = rewriteValue(value);
            }
            return changed ? { modifiedArgs } : {};
          },
        }
      : undefined;

    // Build permission handler: merge deny-list with consumer-provided hook
    const onPermissionRequest = (req: { kind: string }) => {
      if (deniedTools.size > 0 && deniedTools.has(req.kind)) {
        return { kind: 'denied-by-rules' as const };
      }
      if (consumerHooks?.onPermissionRequest) {
        return consumerHooks.onPermissionRequest(req);
      }
      return { kind: 'approved' as const };
    };

    const sessionConfig = {
      model: this.model,
      streaming: true,
      workingDirectory: config.workingDirectory,
      systemMessage: {
        mode: 'append' as const,
        content: config.systemPrompt,
      },
      onPermissionRequest,
      ...(hooks ? { hooks } : {}),
    };

    let session: CopilotSession;
    if (config.resumeSessionId) {
      try {
        session = await this.client.resumeSession(config.resumeSessionId, sessionConfig);
      } catch {
        // Session expired or not found — fall back to new session
        console.log('[copilot-provider] resume failed, creating new session');
        session = await this.client.createSession(sessionConfig);
      }
    } else {
      session = await this.client.createSession(sessionConfig);
    }

    let unsubscribe: (() => void) | null = null;
    let lastSessionError: string | undefined;

    /** Convert AgentAttachments to Copilot SDK file attachments, bridging images to temp files.
     *  Returns the SDK attachments and a list of temp file paths created (for per-request cleanup). */
    async function toCopilotAttachments(
      attachments: AgentAttachment[] | undefined,
    ): Promise<{ sdkAttachments: Array<{ type: 'file'; path: string; displayName?: string }>; createdTempFiles: string[] }> {
      if (!attachments?.length) return { sdkAttachments: [], createdTempFiles: [] };
      const sdkAttachments: Array<{ type: 'file'; path: string; displayName?: string }> = [];
      const createdTempFiles: string[] = [];

      for (const att of attachments) {
        if (att.type === 'file' && att.path) {
          if (!isPathWithinBoundary(att.path, config.workingDirectory)) {
            console.warn(`[copilot-provider] blocked attachment outside working directory: ${att.path}`);
            continue;
          }
          sdkAttachments.push({ type: 'file', path: att.path, displayName: att.displayName });
        } else if (att.type === 'base64_image' && att.data && att.mediaType) {
          const ext = getSafeExtension(att.mediaType);
          if (!ext) {
            console.warn(`[copilot-provider] rejected attachment with unsupported MIME type: ${att.mediaType}`);
            continue;
          }
          if (!isAttachmentSizeValid(att.data)) {
            console.warn(`[copilot-provider] rejected oversized attachment (${(att.data.length / 1024 / 1024).toFixed(1)}MB)`);
            continue;
          }
          const tempPath = join(tmpdir(), `agent-sdk-${randomUUID()}.${ext}`);
          await writeFile(tempPath, Buffer.from(att.data, 'base64'), { mode: 0o600 });
          createdTempFiles.push(tempPath);
          sdkAttachments.push({ type: 'file', path: tempPath, displayName: att.displayName });
        } else if (att.type === 'local_image' && att.path) {
          if (!isPathWithinBoundary(att.path, config.workingDirectory)) {
            console.warn(`[copilot-provider] blocked attachment outside working directory: ${att.path}`);
            continue;
          }
          sdkAttachments.push({ type: 'file', path: att.path, displayName: att.displayName });
        }
      }

      return { sdkAttachments, createdTempFiles };
    }

    /** Clean up temp files created for a single request */
    async function cleanupTempFiles(files: string[]): Promise<void> {
      for (const f of files) {
        try { await unlink(f); } catch { /* ignore missing files */ }
      }
    }

    const agentSession: AgentSession = {
      get sessionId() {
        return session.sessionId ?? null;
      },

      async execute(prompt: string, attachments?: AgentAttachment[]): Promise<AgentResult> {
        lastSessionError = undefined;

        unsubscribe = session.on((event: SessionEvent) => {
          mapSessionEvent(config.contextId, event, config.onEvent);
          if (event.type === 'session.error') {
            lastSessionError = event.data?.message || 'Unknown session error';
          }
        });

        // Merge config-level attachments with per-call attachments
        const merged = [...(config.attachments || []), ...(attachments || [])];
        const { sdkAttachments: copilotAttachments, createdTempFiles } = await toCopilotAttachments(merged);
        try {
          await session.sendAndWait({
            prompt,
            ...(copilotAttachments.length ? { attachments: copilotAttachments } : {}),
          }, 2_147_483_647); // no timeout — agent-manager handles its own AGENT_TIMEOUT_MS
          if (lastSessionError) {
            const diag = formatDiagnostic(diagnoseError('copilot', lastSessionError, config.workingDirectory));
            return { status: 'failed', error: diag };
          }
          return { status: 'complete' };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('copilot', message, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `Copilot SDK error: ${diag}`, timestamp: Date.now(),
          });
          return { status: 'failed', error: diag };
        } finally {
          await cleanupTempFiles(createdTempFiles);
        }
      },

      async send(message: string, attachments?: AgentAttachment[]): Promise<void> {
        const { sdkAttachments: copilotAttachments, createdTempFiles } = await toCopilotAttachments(attachments);
        try {
          await session.sendAndWait({
            prompt: message,
            ...(copilotAttachments.length ? { attachments: copilotAttachments } : {}),
          }, 2_147_483_647); // no timeout
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('copilot', msg, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `Copilot SDK error: ${diag}`, timestamp: Date.now(),
          });
        } finally {
          await cleanupTempFiles(createdTempFiles);
        }
      },

      async abort(): Promise<void> {
        try { await session.abort(); } catch { /* ignore */ }
      },

      async destroy(): Promise<void> {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try { await session.destroy(); } catch { /* ignore */ }
      },
    };

    return agentSession;
  }
}

function mapSessionEvent(
  contextId: string,
  event: SessionEvent,
  onEvent: AgentSessionConfig['onEvent'],
): void {
  switch (event.type) {
    case 'assistant.turn_start':
      onEvent({ id: uuid(), contextId, type: 'thinking', content: 'Starting a new turn...', timestamp: Date.now() });
      break;

    case 'assistant.intent':
      onEvent({ id: uuid(), contextId, type: 'thinking', content: event.data.intent, timestamp: Date.now() });
      break;

    case 'assistant.reasoning_delta':
      onEvent({ id: uuid(), contextId, type: 'thinking', content: event.data.deltaContent, timestamp: Date.now() });
      break;

    case 'assistant.message':
      onEvent({ id: uuid(), contextId, type: 'output', content: event.data.content, timestamp: Date.now() });
      break;

    case 'assistant.message_delta':
      onEvent({ id: uuid(), contextId, type: 'output', content: event.data.deltaContent, timestamp: Date.now() });
      break;

    case 'tool.execution_start': {
      const toolName = event.data.toolName;
      const kind = classifyToolKind(toolName);
      onEvent({
        id: uuid(), contextId, type: kind,
        content: `${toolName}: ${JSON.stringify(event.data.arguments ?? '')}`,
        timestamp: Date.now(),
        metadata: { command: toolName },
      });
      break;
    }

    case 'tool.execution_complete':
      onEvent({
        id: uuid(), contextId, type: 'command_output',
        content: event.data.result?.content ?? event.data.error?.message ?? '',
        timestamp: Date.now(),
      });
      break;

    case 'tool.execution_partial_result': {
      // Filter out CLI spinner frames (Braille patterns U+2800-U+28FF)
      const partial = event.data.partialOutput?.replace(/[\u2800-\u28FF]/g, '').trim();
      if (partial) {
        onEvent({ id: uuid(), contextId, type: 'output', content: partial, timestamp: Date.now() });
      }
      break;
    }

    case 'session.idle':
      onEvent({ id: uuid(), contextId, type: 'complete', content: 'Session idle.', timestamp: Date.now() });
      break;

    case 'session.error':
      onEvent({ id: uuid(), contextId, type: 'error', content: event.data.message, timestamp: Date.now() });
      break;

    default:
      break;
  }
}
