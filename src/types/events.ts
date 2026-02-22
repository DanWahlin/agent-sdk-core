import type { AgentType } from './agents.js';

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_edit'
  | 'command'
  | 'output'
  | 'error'
  | 'complete';

export interface AgentEventMetadata {
  file?: string;
  language?: string;
  command?: string;
  diff?: string;
  agentType?: AgentType;
  duration?: number;
  error?: string;
}

export interface AgentEvent {
  id: string;
  contextId: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: AgentEventMetadata;
}
