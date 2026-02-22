import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotProvider } from '../dist/providers/copilot.js';
import { ClaudeProvider } from '../dist/providers/claude.js';
import { CodexProvider } from '../dist/providers/codex.js';
import { detectAgents } from '../dist/providers/detection.js';
import type { AgentEvent } from '../src/types/events.ts';
import type { AgentProvider } from '../src/types/providers.ts';

// These tests call real agent CLIs. Skip if not available.
const agents = await detectAgents();
const copilotAvailable = agents.find(a => a.name === 'copilot')?.available ?? false;
const claudeAvailable = agents.find(a => a.name === 'claude')?.available ?? false;
const codexAvailable = agents.find(a => a.name === 'codex')?.available ?? false;

/**
 * Helper: run a short prompt against a provider and collect events.
 */
async function runShortPrompt(provider: AgentProvider): Promise<{ events: AgentEvent[]; status: string }> {
  await provider.start();
  const events: AgentEvent[] = [];
  const session = await provider.createSession({
    contextId: `e2e-test-${Date.now()}`,
    workingDirectory: '/tmp',
    systemPrompt: 'You are a test assistant. Be extremely brief.',
    onEvent: (event) => events.push(event),
  });

  const result = await session.execute('Say exactly: hello e2e');
  await session.destroy();
  await provider.stop();
  return { events, status: result.status };
}

describe('e2e: CopilotProvider', { skip: !copilotAvailable && 'Copilot CLI not available' }, () => {
  it('should stream events and complete', { timeout: 120_000 }, async () => {
    const { events, status } = await runShortPrompt(new CopilotProvider());
    assert.equal(status, 'complete');
    assert.ok(events.length > 0, 'Should emit at least one event');

    const types = new Set(events.map(e => e.type));
    assert.ok(types.has('thinking') || types.has('output'), 'Should have thinking or output events');

    // Verify event structure
    for (const event of events) {
      assert.ok(event.id, 'Event should have an id');
      assert.ok(event.contextId, 'Event should have a contextId');
      assert.ok(event.type, 'Event should have a type');
      assert.ok(event.timestamp > 0, 'Event should have a timestamp');
    }
  });
});

describe('e2e: ClaudeProvider', { skip: !claudeAvailable && 'Claude CLI not available' }, () => {
  it('should stream events and complete', { timeout: 120_000 }, async () => {
    const { events, status } = await runShortPrompt(new ClaudeProvider());
    assert.equal(status, 'complete');
    assert.ok(events.length > 0, 'Should emit at least one event');

    const types = new Set(events.map(e => e.type));
    assert.ok(types.has('output') || types.has('complete'), 'Should have output or complete events');
  });
});

describe('e2e: CodexProvider', { skip: !codexAvailable && 'Codex CLI not available' }, () => {
  it('should stream events and complete', { timeout: 120_000 }, async () => {
    const { events, status } = await runShortPrompt(new CodexProvider());
    assert.equal(status, 'complete');
    assert.ok(events.length > 0, 'Should emit at least one event');

    const types = new Set(events.map(e => e.type));
    assert.ok(types.has('output') || types.has('complete'), 'Should have output or complete events');
  });
});
