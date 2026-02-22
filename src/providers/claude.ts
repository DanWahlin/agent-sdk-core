import { v4 as uuid } from 'uuid';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentType } from '../types/agents.js';
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentResult,
  AgentAttachment,
} from '../types/providers.js';

export interface ClaudeProviderOptions {
  model?: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export class ClaudeProvider implements AgentProvider {
  readonly name: AgentType = 'claude';
  readonly displayName = 'Claude Code';
  readonly model: string;

  constructor(options?: ClaudeProviderOptions) {
    this.model = options?.model || process.env.CLAUDE_MODEL || 'claude-opus-4-20250514';
  }

  async start(): Promise<void> {
    console.log(`[claude-provider] ready (model: ${this.model})`);
  }

  async stop(): Promise<void> {
    // Stateless — nothing to clean up
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const model = this.model;
    let sessionId: string | null = config.resumeSessionId || null;
    let aborted = false;

    // Mutex — Claude SDK doesn't support concurrent queries
    let queryLock: Promise<void> = Promise.resolve();
    function withLock<T>(fn: () => Promise<T>): Promise<T> {
      const prev = queryLock;
      let resolve: () => void;
      queryLock = new Promise<void>(r => { resolve = r; });
      return prev.then(fn).finally(() => resolve!());
    }

    function buildContentBlocks(prompt: string, attachments?: AgentAttachment[]): ContentBlock[] {
      const content: ContentBlock[] = [];
      if (attachments) {
        for (const att of attachments) {
          if (att.type === 'base64_image' && att.data && att.mediaType) {
            if (att.displayName) {
              content.push({ type: 'text', text: `[${att.displayName}]` });
            }
            content.push({
              type: 'image',
              source: { type: 'base64', media_type: att.mediaType, data: att.data },
            });
          }
        }
      }
      content.push({ type: 'text', text: prompt });
      return content;
    }

    async function runQuery(
      prompt: string,
      attachments: AgentAttachment[] | undefined,
      onEvent: AgentSessionConfig['onEvent'],
      contextId: string,
    ): Promise<AgentResult> {
      let result: AgentResult = { status: 'complete' };
      const contentBlocks = buildContentBlocks(prompt, attachments);
      const messageGenerator = createMessageGenerator(contentBlocks);

      const response = query({
        prompt: messageGenerator,
        options: {
          model,
          cwd: config.workingDirectory,
          permissionMode: 'acceptEdits',
          systemPrompt: config.systemPrompt,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });

      for await (const message of response) {
        if (aborted) break;

        switch (message.type) {
          case 'system':
            if ('subtype' in message && message.subtype === 'init') {
              sessionId = message.session_id;
            }
            break;

          case 'assistant':
            if ('message' in message && message.message && 'content' in message.message) {
              const content = message.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    onEvent({
                      id: uuid(), contextId, type: 'output',
                      content: block.text, timestamp: Date.now(),
                    });
                  }
                }
              }
            }
            break;

          case 'stream_event':
            if (message.event?.type === 'content_block_delta') {
              const delta = message.event.delta;
              if (delta && 'text' in delta) {
                onEvent({
                  id: uuid(), contextId, type: 'output',
                  content: delta.text, timestamp: Date.now(),
                });
              }
            }
            break;

          case 'tool_progress':
            onEvent({
              id: uuid(), contextId, type: 'command',
              content: `Tool: ${message.tool_name}`,
              timestamp: Date.now(),
              metadata: { command: message.tool_name },
            });
            break;

          case 'result':
            if ('subtype' in message && message.subtype === 'success') {
              onEvent({
                id: uuid(), contextId, type: 'complete',
                content: 'Claude Code completed the task.',
                timestamp: Date.now(),
              });
              result = { status: 'complete' };
            } else {
              const errors = 'errors' in message && Array.isArray(message.errors)
                ? message.errors.join('; ')
                : `Agent ended with status: ${'subtype' in message ? message.subtype : 'unknown'}`;
              onEvent({
                id: uuid(), contextId, type: 'error',
                content: errors, timestamp: Date.now(),
              });
              result = { status: 'failed', error: errors };
            }
            break;
        }
      }
      if (aborted) {
        return { status: 'failed', error: 'Execution aborted' };
      }
      return result;
    }

    const agentSession: AgentSession = {
      get sessionId() {
        return sessionId;
      },

      async execute(prompt: string): Promise<AgentResult> {
        return withLock(async () => {
          try {
            return await runQuery(prompt, config.attachments, config.onEvent, config.contextId);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            config.onEvent({
              id: uuid(), contextId: config.contextId, type: 'error',
              content: `Claude SDK error: ${message}`, timestamp: Date.now(),
            });
            return { status: 'failed', error: message };
          }
        });
      },

      async send(message: string): Promise<void> {
        if (!sessionId) {
          throw new Error('Claude session not initialized — execute() must be called first');
        }
        await withLock(async () => {
          try {
            await runQuery(message, undefined, config.onEvent, config.contextId);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            config.onEvent({
              id: uuid(), contextId: config.contextId, type: 'error',
              content: `Claude SDK error: ${msg}`, timestamp: Date.now(),
            });
          }
        });
      },

      async abort(): Promise<void> {
        aborted = true;
      },

      async destroy(): Promise<void> {
        // SDK handles cleanup automatically
      },
    };

    return agentSession;
  }
}

type SDKUserMessage = {
  type: 'user';
  message: { role: 'user'; content: ContentBlock[] };
  parent_tool_use_id: string | null;
  session_id: string;
};

async function* createMessageGenerator(content: ContentBlock[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content,
    },
    parent_tool_use_id: null,
    session_id: '',
  };
}
