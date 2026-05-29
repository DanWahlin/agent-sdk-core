export type AgentType = 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes';
export type AgentStatus = 'idle' | 'planning' | 'executing' | 'complete' | 'failed';

export interface AgentInfo {
  name: AgentType;
  displayName: string;
  available: boolean;
  version?: string;
  reason?: string;
}
