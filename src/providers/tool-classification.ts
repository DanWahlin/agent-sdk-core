import type { AgentEventType } from '../types/events.js';

/**
 * Classify a tool/command name into a granular AgentEventType.
 * Used by all providers to map SDK-specific tool names to unified event kinds.
 */
export function classifyToolKind(toolName: string | undefined): AgentEventType {
  if (!toolName) return 'command';
  const name = toolName.toLowerCase();

  // File read operations
  if (name === 'read' || name === 'view' || name === 'cat' || name.includes('grep')) {
    return 'file_read';
  }

  // File write operations
  if (name === 'write' || name === 'edit' || name === 'multiedit' ||
      name.includes('patch') || name.includes('insert')) {
    return 'file_write';
  }

  return 'command';
}

/**
 * Human-readable display name for a Codex item type.
 */
export function getToolDisplayName(item: { type: string; command?: string; tool?: string }): string {
  switch (item.type) {
    case 'command_execution':
      return `Running: ${item.command?.split(' ')[0] || 'command'}`;
    case 'file_change':
      return 'Editing files';
    case 'reasoning':
      return 'Thinking...';
    case 'mcp_tool_call':
      return `MCP: ${item.tool || 'tool'}`;
    case 'web_search':
      return 'Searching the web';
    default:
      return item.type;
  }
}
