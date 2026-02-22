import type { AgentType } from './agents.js';

export type AgentEventType =
  | 'thinking'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'file_edit'       // alias: consumers that don't distinguish read/write can use this
  | 'command'
  | 'command_output'
  | 'output'
  | 'test_result'
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
  /** For test_result: number of tests passing */
  testsPassing?: number;
  /** For test_result: number of tests failing */
  testsFailing?: number;
}

export interface AgentEvent {
  id: string;
  contextId: string;
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: AgentEventMetadata;
}
