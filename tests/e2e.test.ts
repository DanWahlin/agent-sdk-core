import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotProvider } from '../dist/providers/copilot.js';
import { ClaudeProvider } from '../dist/providers/claude.js';
import { CodexProvider } from '../dist/providers/codex.js';
import { OpenCodeProvider } from '../dist/providers/opencode.js';
import { detectAgents } from '../dist/providers/detection.js';
import type { AgentEvent } from '../src/types/events.ts';
import type { AgentProvider } from '../src/types/providers.ts';

// These tests call real agent CLIs. Skip if not available.
const agents = await detectAgents();
const copilotAvailable = agents.find(a => a.name === 'copilot')?.available ?? false;
const claudeAvailable = agents.find(a => a.name === 'claude')?.available ?? false;
const codexAvailable = agents.find(a => a.name === 'codex')?.available ?? false;
const opencodeAvailable = agents.find(a => a.name === 'opencode')?.available ?? false;

/**
 * Shared e2e test suite that runs the same real-world scenarios against any provider.
 * Each provider shares a single instance across all tests (mirrors real-world usage).
 */
function providerE2eSuite(
  name: string,
  createProvider: () => AgentProvider,
  available: boolean,
) {
  describe(`e2e: ${name}`, { skip: !available && `${name} CLI not available` }, () => {
    let provider: AgentProvider;

    it('should stream events and complete', { timeout: 120_000 }, async () => {
      provider = createProvider();
      await provider.start();

      const events: AgentEvent[] = [];
      const session = await provider.createSession({
        contextId: `e2e-${name}-${Date.now()}`,
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events.push(event),
      });

      const result = await session.execute('Say exactly: hello e2e');
      await session.destroy();

      assert.equal(result.status, 'complete');
      assert.ok(events.length > 0, 'Should emit at least one event');

      const types = new Set(events.map(e => e.type));
      assert.ok(types.has('thinking') || types.has('output') || types.has('complete'),
        'Should have thinking, output, or complete events');

      // Verify event structure
      for (const event of events) {
        assert.ok(event.id, 'Event should have an id');
        assert.ok(event.contextId, 'Event should have a contextId');
        assert.ok(event.type, 'Event should have a type');
        assert.ok(event.timestamp > 0, 'Event should have a timestamp');
      }
    });

    it('should support multiple sessions from one provider', { timeout: 120_000 }, async () => {
      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];

      const session1 = await provider.createSession({
        contextId: 'e2e-multi-1',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events1.push(event),
      });
      const session2 = await provider.createSession({
        contextId: 'e2e-multi-2',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events2.push(event),
      });

      const [r1, r2] = await Promise.all([
        session1.execute('Say exactly: session one'),
        session2.execute('Say exactly: session two'),
      ]);

      await session1.destroy();
      await session2.destroy();

      assert.equal(r1.status, 'complete');
      assert.equal(r2.status, 'complete');

      // Events should be routed to the correct session's callback
      assert.ok(events1.length > 0, 'Session 1 should have events');
      assert.ok(events2.length > 0, 'Session 2 should have events');
      assert.ok(events1.every(e => e.contextId === 'e2e-multi-1'), 'Session 1 events should have correct contextId');
      assert.ok(events2.every(e => e.contextId === 'e2e-multi-2'), 'Session 2 events should have correct contextId');
    });

    it('should support session resume', { timeout: 120_000 }, async () => {
      const events: AgentEvent[] = [];

      // First session
      const session1 = await provider.createSession({
        contextId: 'e2e-resume',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events.push(event),
      });
      await session1.execute('Remember the word: pineapple');
      const savedId = session1.sessionId;
      assert.ok(savedId, 'Session should have an ID after execute');

      // Resume into the same session
      const session2 = await provider.createSession({
        contextId: 'e2e-resume-2',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events.push(event),
        resumeSessionId: savedId!,
      });

      const result = await session2.execute('What word did I ask you to remember?');
      await session2.destroy();

      assert.equal(result.status, 'complete');
    });

    it('should handle abort gracefully', { timeout: 120_000 }, async () => {
      const session = await provider.createSession({
        contextId: 'e2e-abort',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant.',
        onEvent: () => {},
      });

      // Start a long prompt and abort quickly
      const executePromise = session.execute(
        'Write a very long and detailed essay about the entire history of computing from abacus to quantum computers',
      );
      await new Promise(r => setTimeout(r, 1000));
      await session.abort();

      const result = await executePromise;
      assert.ok(
        result.status === 'complete' || result.status === 'failed',
        'Should complete or fail after abort',
      );

      await session.destroy();
    });

    it('should send follow-up messages', { timeout: 120_000 }, async () => {
      const events: AgentEvent[] = [];
      const session = await provider.createSession({
        contextId: 'e2e-followup',
        workingDirectory: '/tmp',
        systemPrompt: 'You are a test assistant. Be extremely brief.',
        onEvent: (event) => events.push(event),
      });

      const result = await session.execute('Say exactly: first message');
      assert.equal(result.status, 'complete');

      // Follow-up via send()
      await session.send('Say exactly: second message');

      await session.destroy();

      assert.ok(events.length > 0, 'Should have events from both messages');
    });

    it('should stop provider cleanly', { timeout: 120_000 }, async () => {
      // Provider should stop without errors
      await provider.stop();
    });
  });
}

// ── Run the same suite against each provider ──

providerE2eSuite('CopilotProvider', () => new CopilotProvider(), copilotAvailable);
providerE2eSuite('ClaudeProvider', () => new ClaudeProvider(), claudeAvailable);
providerE2eSuite('CodexProvider', () => new CodexProvider(), codexAvailable);
providerE2eSuite('OpenCodeProvider', () => new OpenCodeProvider(), opencodeAvailable);
