import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentInfo } from '../types/agents.js';

const execFileAsync = promisify(execFile);

async function checkCLI(command: string): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { installed: true, version: stdout.split('\n')[0].trim() };
  } catch {
    return { installed: false };
  }
}

export async function detectAgents(): Promise<AgentInfo[]> {
  const [copilotCheck, claudeCheck, codexCheck, opencodeCheck] = await Promise.all([
    checkCLI('copilot'),
    checkCLI('claude'),
    checkCLI('codex'),
    checkCLI('opencode'),
  ]);

  const agents: AgentInfo[] = [];

  agents.push({
    name: 'copilot',
    displayName: 'GitHub Copilot',
    available: copilotCheck.installed,
    version: copilotCheck.version,
    reason: copilotCheck.installed ? undefined : 'Copilot CLI not found in PATH',
  });

  agents.push({
    name: 'claude',
    displayName: 'Claude Code',
    available: claudeCheck.installed,
    version: claudeCheck.version,
    reason: claudeCheck.installed ? undefined : 'Claude Code CLI not found in PATH',
  });

  if (codexCheck.installed) {
    const hasAuth = existsSync(join(homedir(), '.codex', 'auth.json'));
    agents.push({
      name: 'codex',
      displayName: 'OpenAI Codex',
      available: hasAuth,
      version: codexCheck.version,
      reason: hasAuth ? undefined : 'Codex CLI installed but not logged in. Run: codex',
    });
  } else {
    agents.push({
      name: 'codex',
      displayName: 'OpenAI Codex',
      available: false,
      reason: 'Codex CLI not found in PATH',
    });
  }

  agents.push({
    name: 'opencode',
    displayName: 'OpenCode',
    available: opencodeCheck.installed,
    version: opencodeCheck.version,
    reason: opencodeCheck.installed ? undefined : 'OpenCode CLI not found in PATH',
  });

  return agents;
}
