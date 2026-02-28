import { v4 as uuid } from 'uuid';
import { Codex } from '@openai/codex-sdk';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentAttachment,
} from '../types/providers.js';
import { getToolDisplayName } from './tool-classification.js';
import { diagnoseError, formatDiagnostic } from './diagnostics.js';
import { getSafeExtension, isAttachmentSizeValid, isPathWithinBoundary } from './validation.js';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface CodexProviderOptions {
  model?: string;
}

type CodexInput = { type: 'text'; text: string } | { type: 'local_image'; path: string };

export class CodexProvider implements AgentProvider {
  readonly name: AgentType = 'codex';
  readonly displayName = 'OpenAI Codex';
  readonly model: string;

  private codex: Codex | null = null;

  constructor(options?: CodexProviderOptions) {
    this.model = options?.model || process.env.CODEX_MODEL || 'gpt-5.2-codex';
  }

  async start(): Promise<void> {
    this.codex = new Codex();
    console.log(`[codex-provider] SDK initialized (model: ${this.model})`);
  }

  async stop(): Promise<void> {
    this.codex = null;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    if (!this.codex) {
      throw new Error('Codex client not initialized — call start() first');
    }

    const threadOptions = {
      model: this.model,
      workingDirectory: config.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write' as const,
    };

    let thread;
    if (config.resumeSessionId) {
      try {
        thread = this.codex.resumeThread(config.resumeSessionId, threadOptions);
      } catch {
        console.log('[codex-provider] resume failed, starting new thread');
        thread = this.codex.startThread(threadOptions);
      }
    } else {
      thread = this.codex.startThread(threadOptions);
    }

    let abortController: AbortController | null = null;
    const tempFiles: string[] = [];

    async function buildInput(text: string, attachments?: AgentAttachment[]): Promise<CodexInput[]> {
      const input: CodexInput[] = [];
      if (attachments) {
        for (const att of attachments) {
          if (att.type === 'base64_image' && att.data && att.mediaType) {
            // Validate MIME type
            const ext = getSafeExtension(att.mediaType);
            if (!ext) {
              console.warn(`[codex-provider] rejected attachment with unsupported MIME type: ${att.mediaType}`);
              continue;
            }
            // Validate size
            if (!isAttachmentSizeValid(att.data)) {
              console.warn(`[codex-provider] rejected oversized attachment (${(att.data.length / 1024 / 1024).toFixed(1)}MB)`);
              continue;
            }
            const tempPath = join(tmpdir(), `agent-sdk-${randomUUID()}.${ext}`);
            await writeFile(tempPath, Buffer.from(att.data, 'base64'), { mode: 0o600 });
            tempFiles.push(tempPath);
            if (att.displayName) {
              input.push({ type: 'text', text: `[${att.displayName}]` });
            }
            input.push({ type: 'local_image', path: tempPath });
          } else if (att.type === 'local_image' && att.path) {
            // Validate path is within working directory
            if (!isPathWithinBoundary(att.path, config.workingDirectory)) {
              console.warn(`[codex-provider] blocked attachment outside working directory: ${att.path}`);
              continue;
            }
            if (att.displayName) {
              input.push({ type: 'text', text: `[${att.displayName}]` });
            }
            input.push({ type: 'local_image', path: att.path });
          }
        }
      }
      input.push({ type: 'text', text });
      return input;
    }

    // Codex SDK event shape (typed loosely since the SDK doesn't export the event type)
    interface CodexStreamEvent {
      type: string;
      item?: {
        type: string;
        text?: string;
        command?: string;
        tool?: string;
        aggregated_output?: string;
        changes?: Array<{ kind: string; path: string }>;
      };
      error?: { message?: string };
      message?: string;
    }

    async function processEvents(
      events: AsyncIterable<CodexStreamEvent>,
      contextId: string,
      onEvent: AgentSessionConfig['onEvent'],
      signal: AbortSignal | undefined,
    ): Promise<AgentResult> {
      let result: AgentResult = { status: 'complete' };

      for await (const event of events) {
        if (signal?.aborted) break;

        switch (event.type) {
          case 'item.started':
            if (event.item?.type) {
              onEvent({
                id: uuid(), contextId, type: 'command',
                content: `Started: ${getToolDisplayName(event.item)}`,
                timestamp: Date.now(),
                metadata: { command: event.item.type },
              });
            }
            break;

          case 'item.completed':
            if (event.item) {
              switch (event.item.type) {
                case 'agent_message':
                  onEvent({
                    id: uuid(), contextId, type: 'output',
                    content: (event.item.text || '') + '\n',
                    timestamp: Date.now(),
                  });
                  break;
                case 'reasoning':
                  onEvent({
                    id: uuid(), contextId, type: 'thinking',
                    content: event.item.text || '',
                    timestamp: Date.now(),
                  });
                  break;
                case 'command_execution':
                  onEvent({
                    id: uuid(), contextId, type: 'command',
                    content: `$ ${event.item.command || ''}`,
                    timestamp: Date.now(),
                    metadata: { command: event.item.command },
                  });
                  onEvent({
                    id: uuid(), contextId, type: 'command_output',
                    content: event.item.aggregated_output || '',
                    timestamp: Date.now(),
                  });
                  break;
                case 'file_change': {
                  const changes = (event.item.changes ?? []) as Array<{ kind: string; path: string }>;
                  for (const change of changes) {
                    onEvent({
                      id: uuid(), contextId, type: 'file_write',
                      content: `${change.kind}: ${change.path}`,
                      timestamp: Date.now(),
                      metadata: { file: change.path },
                    });
                  }
                  break;
                }
              }
            }
            break;

          case 'turn.completed':
            onEvent({
              id: uuid(), contextId, type: 'complete',
              content: 'Codex completed the task.',
              timestamp: Date.now(),
            });
            return { status: 'complete' };

          case 'turn.failed': {
            const errorMsg = event.error?.message || 'Codex turn failed';
            onEvent({
              id: uuid(), contextId, type: 'error',
              content: errorMsg, timestamp: Date.now(),
            });
            return { status: 'failed', error: errorMsg };
          }

          case 'error': {
            const errorMsg = event.message || 'Unknown Codex error';
            onEvent({
              id: uuid(), contextId, type: 'error',
              content: errorMsg, timestamp: Date.now(),
            });
            result = { status: 'failed', error: errorMsg };
            break;
          }
        }
      }

      if (signal?.aborted) {
        return { status: 'failed', error: 'Execution aborted' };
      }
      return result;
    }

    const agentSession: AgentSession = {
      get sessionId() {
        return thread.id;
      },

      async execute(prompt: string): Promise<AgentResult> {
        abortController = new AbortController();
        try {
          const input = await buildInput(
            `${config.systemPrompt}\n\n${prompt}`,
            config.attachments,
          );
          const { events } = await thread.runStreamed(input);
          return await processEvents(events, config.contextId, config.onEvent, abortController.signal);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('codex', message, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `Codex SDK error: ${diag}`, timestamp: Date.now(),
          });
          return { status: 'failed', error: diag };
        }
      },

      async send(message: string): Promise<void> {
        abortController = new AbortController();
        try {
          const input = await buildInput(message);
          const { events } = await thread.runStreamed(input);
          await processEvents(events, config.contextId, config.onEvent, abortController.signal);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const diag = formatDiagnostic(diagnoseError('codex', msg, config.workingDirectory));
          config.onEvent({
            id: uuid(), contextId: config.contextId, type: 'error',
            content: `Codex SDK error: ${diag}`, timestamp: Date.now(),
          });
        }
      },

      async abort(): Promise<void> {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
      },

      async destroy(): Promise<void> {
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        // Clean up temp files created for image attachments
        for (const f of tempFiles) {
          try { await unlink(f); } catch { /* ignore missing files */ }
        }
        tempFiles.length = 0;
      },
    };

    return agentSession;
  }
}
