import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OpenClawGatewayProvider as OpenClawProvider } from '../src/providers/openclaw-gateway.ts';

const LIVE_ENABLED = process.env.OPENCLAW_LIVE === '1';
const LIVE_CHAT_ENABLED = process.env.OPENCLAW_LIVE_CHAT === '1';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem?: string;
  publicKey?: string;
  privateKeyPem: string;
};

type DeviceAuth = {
  token: string;
  scopes: string[];
};

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stringProperty(value: unknown, key: string): string | undefined {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[key] === 'string'
    ? (value as Record<string, string>)[key]
    : undefined;
}

function loadDeviceIdentity(): DeviceIdentity {
  const fromEnv = {
    deviceId: process.env.OPENCLAW_DEVICE_ID,
    publicKey: process.env.OPENCLAW_DEVICE_PUBLIC_KEY,
    privateKeyPem: process.env.OPENCLAW_DEVICE_PRIVATE_KEY,
  };
  if (fromEnv.deviceId && fromEnv.publicKey && fromEnv.privateKeyPem) {
    return fromEnv as DeviceIdentity;
  }

  const identityPath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH
    ?? path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
  const parsed = readJsonFile(identityPath);
  const deviceId = stringProperty(parsed, 'deviceId');
  const publicKeyPem = stringProperty(parsed, 'publicKeyPem');
  const privateKeyPem = stringProperty(parsed, 'privateKeyPem');
  if (!deviceId || !publicKeyPem || !privateKeyPem) {
    throw new Error(`OpenClaw device identity is incomplete: ${identityPath}`);
  }
  return { deviceId, publicKeyPem, privateKeyPem };
}

function loadDeviceAuth(): DeviceAuth {
  if (process.env.OPENCLAW_DEVICE_TOKEN) {
    return {
      token: process.env.OPENCLAW_DEVICE_TOKEN,
      scopes: process.env.OPENCLAW_DEVICE_SCOPES?.split(',').map(scope => scope.trim()).filter(Boolean)
        ?? ['operator.read', 'operator.write'],
    };
  }

  const authPath = process.env.OPENCLAW_DEVICE_AUTH_PATH
    ?? path.join(os.homedir(), '.openclaw', 'identity', 'device-auth.json');
  const parsed = readJsonFile(authPath) as Record<string, unknown>;
  const tokens = parsed.tokens as Record<string, unknown> | undefined;
  const operator = tokens?.operator as Record<string, unknown> | undefined;
  const token = stringProperty(operator, 'token');
  const scopes = Array.isArray(operator?.scopes)
    ? operator.scopes.filter((scope): scope is string => typeof scope === 'string')
    : ['operator.read', 'operator.write'];
  if (!token) {
    throw new Error(`OpenClaw operator device token is missing: ${authPath}`);
  }
  return { token, scopes };
}

function createLiveProvider(): OpenClawProvider {
  const deviceIdentity = loadDeviceIdentity();
  const deviceAuth = loadDeviceAuth();
  return new OpenClawProvider({
    url: process.env.OPENCLAW_GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
    deviceIdentity,
    deviceToken: deviceAuth.token,
    scopes: deviceAuth.scopes,
    sessionKey: `agent-sdk-live-${process.pid}`,
    timeoutMs: Number(process.env.OPENCLAW_LIVE_TIMEOUT_MS ?? 30_000),
  });
}

describe('OpenClawProvider live Gateway smoke', { skip: !LIVE_ENABLED && 'set OPENCLAW_LIVE=1 to run against a local OpenClaw Gateway' }, () => {
  it('should authenticate to a real OpenClaw Gateway without starting a model run', { timeout: 15_000 }, async () => {
    const provider = createLiveProvider();

    await provider.start();
    assert.equal(provider.name, 'openclaw');
    await provider.stop();
  });

  it('should send a chat message through the real Gateway when explicitly enabled', { timeout: 90_000, skip: !LIVE_CHAT_ENABLED && 'set OPENCLAW_LIVE_CHAT=1 to run a real chat.send turn' }, async () => {
    const provider = createLiveProvider();
    const events: string[] = [];

    await provider.start();
    try {
      const session = await provider.createSession({
        contextId: `openclaw-live-chat-${Date.now()}`,
        workingDirectory: process.cwd(),
        systemPrompt: 'You are a smoke-test assistant. Reply with exactly: openclaw sdk ok',
        onEvent: event => {
          if (event.content) events.push(event.content);
        },
      });
      const result = await session.execute('Reply now.');
      await session.destroy();

      assert.equal(result.status, 'complete');
      assert.match(events.join('\n').toLowerCase(), /openclaw sdk ok/);
    } finally {
      await provider.stop();
    }
  });
});
