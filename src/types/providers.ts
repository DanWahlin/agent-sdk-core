import type { AgentType, AgentEvent } from '../index.js';

export interface AgentResult {
  status: 'complete' | 'failed';
  error?: string;
}

export interface AgentAttachment {
  type: 'file' | 'base64_image' | 'local_image';
  /** File path (for type 'file' or 'local_image') */
  path?: string;
  /** Display name for the attachment */
  displayName?: string;
  /** Base64-encoded data (for type 'base64_image') */
  data?: string;
  /** MIME type (for type 'base64_image') */
  mediaType?: string;
}

export interface AgentSessionHooks {
  /** Intercept tool calls before execution (e.g., worktree path rewriting) */
  onPreToolUse?: (input: unknown) => unknown;
  /** Handle permission requests (e.g., deny-lists) */
  onPermissionRequest?: (request: { kind: string }) => { kind: 'approved' | 'denied-by-rules' };
}

export interface AgentSessionConfig {
  contextId: string;
  workingDirectory: string;
  systemPrompt: string;
  onEvent: (event: AgentEvent) => void;
  /** Original repo path — used for worktree path rewriting */
  repoPath?: string;
  /** Resume a previous session by ID */
  resumeSessionId?: string;
  /** File/image attachments to include with messages */
  attachments?: AgentAttachment[];
  /** Optional hooks for middleware injection */
  hooks?: AgentSessionHooks;
}

export interface AgentSession {
  execute(prompt: string): Promise<AgentResult>;
  /** Send a follow-up message to a running agent session */
  send(message: string): Promise<void>;
  abort(): Promise<void>;
  destroy(): Promise<void>;
  readonly sessionId: string | null;
}

export interface AgentProvider {
  readonly name: AgentType;
  readonly displayName: string;
  readonly model: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  createSession(config: AgentSessionConfig): Promise<AgentSession>;
}
