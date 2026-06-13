import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawProvider } from '../src/providers/openclaw.ts';

const LIVE_ENABLED = process.env.OPENCLAW_ACP_LIVE === '1';
const LIVE_CHAT_ENABLED = process.env.OPENCLAW_ACP_LIVE_CHAT === '1';

describe('OpenClawProvider live ACP smoke', { skip: !LIVE_ENABLED && 'set OPENCLAW_ACP_LIVE=1 to run openclaw acp against a configured Gateway' }, () => {
  it('should start and stop the real openclaw ACP bridge without a model turn', async () => {
    const provider = new OpenClawProvider({
      command: process.env.OPENCLAW_COMMAND || 'openclaw',
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN,
      gatewayPassword: process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.OPENCLAW_PASSWORD,
      sessionKey: process.env.OPENCLAW_SESSION_KEY,
      requireExistingSession: process.env.OPENCLAW_ACP_REQUIRE_EXISTING === '1',
    });

    await provider.start();
    await provider.stop();

    assert.equal(provider.name, 'openclaw');
  });

  it('should create an ACP session and execute a real chat turn when explicitly enabled', { skip: !LIVE_CHAT_ENABLED && 'set OPENCLAW_ACP_LIVE_CHAT=1 to allow a real OpenClaw model turn' }, async () => {
    const events: string[] = [];
    const provider = new OpenClawProvider({
      command: process.env.OPENCLAW_COMMAND || 'openclaw',
      gatewayUrl: process.env.OPENCLAW_GATEWAY_URL,
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN,
      gatewayPassword: process.env.OPENCLAW_GATEWAY_PASSWORD || process.env.OPENCLAW_PASSWORD,
      sessionKey: process.env.OPENCLAW_SESSION_KEY,
      prefixCwd: false,
    });

    await provider.start();
    try {
      const session = await provider.createSession({
        contextId: 'openclaw-acp-live',
        workingDirectory: process.cwd(),
        systemPrompt: 'Reply tersely. Do not modify files.',
        onEvent: event => {
          events.push(`${event.type}:${event.content}`);
        },
      });
      const result = await session.execute('Reply with exactly: OPENCLAW_ACP_OK');
      await session.destroy();

      assert.equal(result.status, 'complete');
      assert.ok(events.some(event => event.includes('OPENCLAW_ACP_OK')) || events.some(event => event.startsWith('complete:')));
    } finally {
      await provider.stop();
    }
  });
});
