import type { AgentEventMetadata, AgentEventType } from '../types/events.js';
import type { AgentSessionConfig } from '../types/providers.js';
import { v4 as uuid } from 'uuid';

export function emitAgentEvent(
  config: AgentSessionConfig,
  type: AgentEventType,
  content: string,
  metadata?: AgentEventMetadata,
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
