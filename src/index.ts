// Types
export type {
  AgentEvent,
  AgentEventType,
  AgentEventMetadata,
} from './types/events.js';

export type {
  AgentType,
  AgentStatus,
  AgentInfo,
} from './types/agents.js';

export type {
  WSMessage,
} from './types/messages.js';

export type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentSessionHooks,
  AgentAttachment,
  AgentResult,
} from './types/providers.js';

// Providers
export { CopilotProvider } from './providers/copilot.js';
export { ClaudeProvider } from './providers/claude.js';
export { CodexProvider } from './providers/codex.js';
export { OpenCodeProvider } from './providers/opencode.js';
export { detectAgents } from './providers/detection.js';
export { ProgressAggregator } from './providers/progress.js';

// WebSocket utilities
export { createHeartbeat, broadcast, createWSServer } from './ws/server.js';
export { WSClient } from './ws/client.js';
