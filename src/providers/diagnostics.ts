import { userInfo } from 'os';
import { accessSync, constants } from 'fs';

interface DiagnosticResult {
  message: string;
  suggestion?: string;
}

/**
 * Enrich an agent error message with diagnostic context and actionable fixes.
 * Called by providers when an SDK error occurs.
 */
export function diagnoseError(
  agentName: string,
  error: string,
  workingDirectory?: string,
): DiagnosticResult {
  const lower = error.toLowerCase();

  // Claude Code: process exit code 1 when running as root
  if (agentName === 'claude' && lower.includes('exited with code 1')) {
    if (userInfo().uid === 0) {
      return {
        message: error,
        suggestion: 'Claude Code cannot run as root with default permissions. ' +
          'Ensure a non-root user (e.g., ccrunner) is configured with spawnClaudeCodeProcess, ' +
          'and that the user has write access to the project directory.',
      };
    }
  }

  // Permission denied / EACCES errors
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    const dirInfo = workingDirectory ? ` Check ownership of: ${workingDirectory}` : '';
    return {
      message: error,
      suggestion: `The agent lacks file system permissions.${dirInfo} ` +
        `Fix with: chown -R $(whoami) <project-directory>`,
    };
  }

  // Write permissions — agent reports it can't write
  if (lower.includes('don\'t have write') || lower.includes('cannot write') || lower.includes('read-only')) {
    const dirInfo = workingDirectory ? ` for: ${workingDirectory}` : '';
    return {
      message: error,
      suggestion: `The project directory is not writable by the agent process${dirInfo}. ` +
        `If using a custom spawn user, ensure that user owns the project files: ` +
        `chown -R <agent-user> <project-directory>`,
    };
  }

  // ENOENT — CLI not found
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('spawn')) {
    return {
      message: error,
      suggestion: `The ${agentName} CLI binary was not found in PATH. ` +
        `Ensure it is installed and accessible to the process user.`,
    };
  }

  // Auth / credentials errors
  if (lower.includes('auth') || lower.includes('credential') || lower.includes('token') || lower.includes('login')) {
    return {
      message: error,
      suggestion: `Authentication failed for ${agentName}. ` +
        `Ensure the agent CLI is logged in for the user running the server.`,
    };
  }

  // No enrichment needed
  return { message: error };
}

/**
 * Format a diagnostic result into a single error string with suggestion.
 */
export function formatDiagnostic(result: DiagnosticResult): string {
  if (result.suggestion) {
    return `${result.message}\n\n💡 ${result.suggestion}`;
  }
  return result.message;
}
