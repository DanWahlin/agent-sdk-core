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
export { HermesProvider } from './providers/hermes.js';
export { OpenClawProvider } from './providers/openclaw.js';
export { OpenClawGatewayProvider } from './providers/openclaw-gateway.js';
export { detectAgents } from './providers/detection.js';
export { ProgressAggregator } from './providers/progress.js';

// WebSocket utilities
export { createHeartbeat, broadcast, createWSServer } from './ws/server.js';
export { WSClient } from './ws/client.js';
export { sanitizeJson } from './ws/sanitize.js';

export type { CopilotProviderOptions } from './providers/copilot.js';
export type { ClaudeProviderOptions } from './providers/claude.js';
export type { CodexProviderOptions } from './providers/codex.js';
export type { OpenCodeProviderOptions } from './providers/opencode.js';
export type { HermesProviderOptions } from './providers/hermes.js';
export type { OpenClawProviderOptions, OpenClawAcpProvenanceMode } from './providers/openclaw.js';
export type { OpenClawDeviceIdentity, OpenClawGatewayProviderOptions } from './providers/openclaw-gateway.js';

export { buildContentBlocks } from './providers/claude.js';
export { createHermesEnvironment, buildAcpPromptBlocks } from './providers/hermes.js';
export { buildOpenClawAcpArgs, createOpenClawEnvironment, buildOpenClawAcpPromptBlocks } from './providers/openclaw.js';
export { buildOpenClawDeviceAuthPayloadV3, extractOpenClawText, mapOpenClawChatEvent } from './providers/openclaw-gateway.js';
export { mapOpenCodeEvent } from './providers/opencode.js';
export { MAX_ATTACHMENT_SIZE, isAbsolutePath } from './providers/validation.js';
export { LOCAL_IMAGE_MIME_TYPES as OPENCLAW_GATEWAY_LOCAL_IMAGE_MIME_TYPES } from './providers/openclaw-gateway.js';
