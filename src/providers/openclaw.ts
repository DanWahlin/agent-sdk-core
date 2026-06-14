import { spawn as defaultSpawn } from 'child_process';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { AgentSessionConfig, AgentAttachment } from '../types/providers.js';
import { buildAcpPromptBlocks as buildSharedAcpPromptBlocks } from './acp-utils.js';
import { AcpCliProviderBase } from './acp-cli-provider.js';
import type { SpawnAcpProcess } from './acp-cli-provider.js';
import { createSafeChildEnvironment } from './env.js';

export type OpenClawAcpProvenanceMode = 'off' | 'meta' | 'meta+receipt';

export interface OpenClawProviderOptions {
  /** OpenClaw CLI command or absolute path (default: OPENCLAW_COMMAND or "openclaw") */
  command?: string;
  /** Display/configured model name. OpenClaw ACP reads its active model from Gateway/session config. */
  model?: string;
  /** OpenClaw Gateway WebSocket URL forwarded to `openclaw acp --url`. */
  gatewayUrl?: string;
  /** @deprecated Use gatewayUrl. Kept for compatibility with the old Gateway provider option shape. */
  url?: string;
  /** Gateway token. Passed via OPENCLAW_GATEWAY_TOKEN, never as a process argument. */
  gatewayToken?: string;
  /** @deprecated Use gatewayToken. Kept for compatibility with the old Gateway provider option shape. */
  token?: string;
  /** @deprecated Mapped to gatewayToken when no explicit gatewayToken/token is set. For signed device auth, use OpenClawGatewayProvider. */
  deviceToken?: string;
  /** Gateway token file path. Forwarded as `--token-file`. */
  gatewayTokenFile?: string;
  /** Gateway password. Passed via OPENCLAW_GATEWAY_PASSWORD, never as a process argument. */
  gatewayPassword?: string;
  /** @deprecated Use gatewayPassword. Kept for compatibility with the old Gateway provider option shape. */
  password?: string;
  /** Gateway password file path. Forwarded as `--password-file`. */
  gatewayPasswordFile?: string;
  /** Default Gateway session key to bind ACP sessions to. */
  sessionKey?: string;
  /** Default Gateway session label to resolve. */
  sessionLabel?: string;
  /** Fail if the session key/label does not already exist. */
  requireExistingSession?: boolean;
  /** Reset the Gateway session key before first use. */
  resetSession?: boolean;
  /** Prefix prompts with the working directory. Defaults to OpenClaw's bridge default. */
  prefixCwd?: boolean;
  /** ACP provenance mode passed through to OpenClaw. */
  provenanceMode?: OpenClawAcpProvenanceMode;
  /** Enable verbose bridge logging on stderr. */
  verbose?: boolean;
  /** Injected process spawner for deterministic tests. */
  spawn?: SpawnAcpProcess;
  /** Extra environment values merged through the safe allowlist. */
  env?: NodeJS.ProcessEnv;
}

const CLIENT_VERSION = '0.6.0';

export class OpenClawProvider extends AcpCliProviderBase {
  constructor(options: OpenClawProviderOptions = {}) {
    const env = options.env ?? process.env;
    const command = options.command || env.OPENCLAW_COMMAND || 'openclaw';
    const model = options.model || env.OPENCLAW_MODEL || 'gateway configured default';
    const normalizedOptions = normalizeOpenClawOptions(options);

    super({
      name: 'openclaw',
      displayName: 'OpenClaw',
      providerLabel: 'OpenClaw',
      diagnosticName: 'openclaw',
      command,
      model,
      args: buildOpenClawAcpArgs(normalizedOptions),
      env: createOpenClawEnvironment(normalizedOptions.env, {
        gatewayToken: normalizedOptions.gatewayToken,
        gatewayPassword: normalizedOptions.gatewayPassword,
      }),
      spawnProcess: options.spawn ?? defaultSpawn,
      sessionRequest: (config: AgentSessionConfig) => ({
        cwd: config.workingDirectory,
        mcpServers: [],
      }),
      clientVersion: CLIENT_VERSION,
      consolePrefix: 'openclaw-provider',
      notInitializedMessage: 'OpenClaw ACP client not initialized — call start() first',
      missingSessionMessage: 'OpenClaw ACP did not return a sessionId.',
      destroyedMessage: 'OpenClaw session has been destroyed',
      abortedMessage: 'OpenClaw execution aborted',
      completedMessage: 'OpenClaw completed the task.',
    });
  }
}

export function buildOpenClawAcpArgs(options: OpenClawProviderOptions = {}): string[] {
  const normalized = normalizeOpenClawOptions(options);
  const args = ['acp'];
  pushOption(args, '--url', normalized.gatewayUrl);
  pushOption(args, '--token-file', normalized.gatewayTokenFile);
  pushOption(args, '--password-file', normalized.gatewayPasswordFile);
  pushOption(args, '--session', normalized.sessionKey);
  pushOption(args, '--session-label', normalized.sessionLabel);
  if (normalized.requireExistingSession) args.push('--require-existing');
  if (normalized.resetSession) args.push('--reset-session');
  if (normalized.prefixCwd === false) args.push('--no-prefix-cwd');
  pushOption(args, '--provenance', normalized.provenanceMode);
  if (normalized.verbose) args.push('--verbose');
  return args;
}

function normalizeOpenClawOptions(options: OpenClawProviderOptions): OpenClawProviderOptions {
  return {
    ...options,
    gatewayUrl: options.gatewayUrl ?? options.url,
    gatewayToken: options.gatewayToken ?? options.token ?? options.deviceToken,
    gatewayPassword: options.gatewayPassword ?? options.password,
  };
}

function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value !== '') args.push(flag, value);
}

export function createOpenClawEnvironment(
  extraEnv?: NodeJS.ProcessEnv,
  credentials?: { gatewayToken?: string; gatewayPassword?: string },
): NodeJS.ProcessEnv {
  const env = createSafeChildEnvironment({ prefixes: ['OPENCLAW_'], extraEnv });

  // OpenClaw's bridge resolves OPENCLAW_GATEWAY_* names. Preserve SDK
  // compatibility with the older OPENCLAW_TOKEN / OPENCLAW_PASSWORD aliases
  // without putting secrets in process arguments.
  if (!env.OPENCLAW_GATEWAY_TOKEN && env.OPENCLAW_TOKEN) {
    env.OPENCLAW_GATEWAY_TOKEN = env.OPENCLAW_TOKEN;
  }
  if (!env.OPENCLAW_GATEWAY_PASSWORD && env.OPENCLAW_PASSWORD) {
    env.OPENCLAW_GATEWAY_PASSWORD = env.OPENCLAW_PASSWORD;
  }

  if (credentials?.gatewayToken) env.OPENCLAW_GATEWAY_TOKEN = credentials.gatewayToken;
  if (credentials?.gatewayPassword) env.OPENCLAW_GATEWAY_PASSWORD = credentials.gatewayPassword;
  return env;
}

export async function buildOpenClawAcpPromptBlocks(
  prompt: string,
  attachments: AgentAttachment[] | undefined,
  workingDirectory: string,
): Promise<ContentBlock[]> {
  return buildSharedAcpPromptBlocks('OpenClaw', prompt, attachments, workingDirectory);
}
