import { userInfo } from 'os';

interface DiagnosticResult {
  message: string;
  suggestion?: string;
}

/**
 * Enrich an agent error message with diagnostic context and actionable fixes.
 * Called by providers when an SDK error occurs.
 *
 * Set `redactPaths: true` in production/multi-tenant environments to avoid
 * leaking filesystem paths in error messages.
 */
export function diagnoseError(
  agentName: string,
  error: string,
  workingDirectory?: string,
  options?: { redactPaths?: boolean },
): DiagnosticResult {
  const redact = options?.redactPaths ?? false;
  const dirLabel = redact ? '<project-directory>' : (workingDirectory || '<project-directory>');
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
    return {
      message: error,
      suggestion: `The agent lacks file system permissions. Check ownership of: ${dirLabel}. ` +
        `Fix with: chown -R $(whoami) ${dirLabel}`,
    };
  }

  // Write permissions — agent reports it can't write
  if (lower.includes('don\'t have write') || lower.includes('cannot write') || lower.includes('read-only')) {
    return {
      message: error,
      suggestion: `The project directory is not writable by the agent process: ${dirLabel}. ` +
        `If using a custom spawn user, ensure that user owns the project files: ` +
        `chown -R <agent-user> ${dirLabel}`,
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

  // OpenCode: server connection refused
  if (agentName === 'opencode' && (lower.includes('econnrefused') || lower.includes('fetch failed'))) {
    return {
      message: error,
      suggestion: 'The OpenCode server is not running or not reachable. ' +
        'Start it with: opencode serve --port 4096, or check your hostname/port configuration.',
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
