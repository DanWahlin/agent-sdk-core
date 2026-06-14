import { spawn as defaultSpawn } from 'child_process';
import type { McpServer, ContentBlock } from '@agentclientprotocol/sdk';
import type { AgentSessionConfig, AgentAttachment } from '../types/providers.js';
import { buildAcpPromptBlocks as buildSharedAcpPromptBlocks } from './acp-utils.js';
import { AcpCliProviderBase } from './acp-cli-provider.js';
import type { SpawnAcpProcess } from './acp-cli-provider.js';
import { createSafeChildEnvironment } from './env.js';

export interface HermesProviderOptions {
  /** Hermes CLI command or absolute path (default: HERMES_COMMAND or "hermes") */
  command?: string;
  /** Display/configured model name. Hermes ACP reads its active model from Hermes config. */
  model?: string;
  /** Auto-approve unseen Hermes shell hooks for headless ACP startup */
  acceptHooks?: boolean;
  /** MCP server definitions forwarded to session/new */
  mcpServers?: McpServer[];
  /** Injected process spawner for deterministic tests */
  spawn?: SpawnAcpProcess;
  /** Extra environment values merged through the safe allowlist */
  env?: NodeJS.ProcessEnv;
}

const CLIENT_VERSION = '0.6.0';

export class HermesProvider extends AcpCliProviderBase {
  constructor(options?: HermesProviderOptions) {
    const command = options?.command || process.env.HERMES_COMMAND || 'hermes';
    const model = options?.model || process.env.HERMES_MODEL || process.env.HERMES_INFERENCE_MODEL || 'configured default';
    const args = ['acp'];
    const acceptHooks = options?.acceptHooks ?? isTruthy(process.env.HERMES_ACCEPT_HOOKS);
    if (acceptHooks) args.push('--accept-hooks');

    super({
      name: 'hermes',
      displayName: 'Hermes Agent',
      providerLabel: 'Hermes',
      diagnosticName: 'hermes',
      command,
      model,
      args,
      env: createHermesEnvironment(options?.env),
      spawnProcess: options?.spawn ?? defaultSpawn,
      sessionRequest: (config: AgentSessionConfig) => ({
        cwd: config.workingDirectory,
        mcpServers: options?.mcpServers ?? [],
      }),
      clientVersion: CLIENT_VERSION,
      consolePrefix: 'hermes-provider',
      notInitializedMessage: 'Hermes ACP client not initialized — call start() first',
      missingSessionMessage: 'Hermes ACP did not return a sessionId.',
      destroyedMessage: 'Hermes session has been destroyed',
      abortedMessage: 'Hermes execution aborted',
      completedMessage: 'Hermes completed the task.',
    });
  }
}

export function createHermesEnvironment(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return createSafeChildEnvironment({ prefixes: ['HERMES_'], extraEnv });
}

export async function buildAcpPromptBlocks(
  prompt: string,
  attachments: AgentAttachment[] | undefined,
  workingDirectory: string,
): Promise<ContentBlock[]> {
  return buildSharedAcpPromptBlocks('Hermes', prompt, attachments, workingDirectory);
}

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}
