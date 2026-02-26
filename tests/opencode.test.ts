import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mapOpenCodeEvent } from '../src/providers/opencode.ts';
import type { AgentEvent } from '../src/types/events.ts';

// ── Helper: collect events emitted by mapOpenCodeEvent ──

function collectEvents(
  sessionId: string,
  event: unknown,
  contextId = 'ctx-1',
): AgentEvent[] {
  const events: AgentEvent[] = [];
  mapOpenCodeEvent(sessionId, event as any, contextId, (e) => events.push(e));
  return events;
}

// ── Construction tests ──

describe('OpenCodeProvider construction', () => {
  it('should parse model into providerID/modelID', async () => {
    // Dynamically import to avoid triggering SDK import at module level
    const mod = await import('../src/providers/opencode.ts');
    const provider = new mod.OpenCodeProvider({ model: 'anthropic/claude-sonnet-4-20250514' });
    assert.equal(provider.name, 'opencode');
    assert.equal(provider.displayName, 'OpenCode');
    assert.equal(provider.model, 'anthropic/claude-sonnet-4-20250514');
  });

  it('should handle model with multiple slashes', async () => {
    const mod = await import('../src/providers/opencode.ts');
    const provider = new mod.OpenCodeProvider({ model: 'openai/gpt-4/turbo' });
    assert.equal(provider.model, 'openai/gpt-4/turbo');
  });

  it('should use default model when none provided', async () => {
    const mod = await import('../src/providers/opencode.ts');
    const provider = new mod.OpenCodeProvider();
    assert.ok(provider.model.includes('/'));
  });

  it('should throw if createSession called before start', async () => {
    const mod = await import('../src/providers/opencode.ts');
    const provider = new mod.OpenCodeProvider();
    await assert.rejects(
      () => provider.createSession({
        contextId: 'ctx-1',
        workingDirectory: '/tmp',
        systemPrompt: 'test',
        onEvent: () => {},
      }),
      { message: /not initialized/ },
    );
  });
});

// ── SSE event mapping tests ──

describe('mapOpenCodeEvent', () => {
  const SESSION_ID = 'sess-123';

  it('should map text part update to output event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1', sessionID: SESSION_ID, messageID: 'm1',
          type: 'text', text: 'Hello world',
        },
        delta: 'Hello',
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'output');
    assert.equal(events[0].content, 'Hello');
  });

  it('should use full text when no delta for text part', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1', sessionID: SESSION_ID, messageID: 'm1',
          type: 'text', text: 'Full text here',
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'Full text here');
  });

  it('should map reasoning part to thinking event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p2', sessionID: SESSION_ID, messageID: 'm1',
          type: 'reasoning', text: 'Let me think...',
        },
        delta: 'Let me think...',
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'thinking');
    assert.equal(events[0].content, 'Let me think...');
  });

  it('should map tool running state to classified event type', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p3', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'read', callID: 'c1',
          state: { status: 'running', input: { path: 'src/index.ts' }, time: { start: 1 } },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'file_read');
    assert.ok(events[0].content.includes('read'));
    assert.equal(events[0].metadata?.command, 'read');
  });

  it('should map tool completed state to command_output', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p3', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'bash', callID: 'c1',
          state: {
            status: 'completed',
            input: { command: 'ls' },
            output: 'file1.ts\nfile2.ts',
            title: 'bash', metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'command_output');
    assert.equal(events[0].content, 'file1.ts\nfile2.ts');
  });

  it('should map tool error state to error event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p3', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'write', callID: 'c1',
          state: {
            status: 'error',
            input: { path: '/etc/passwd' },
            error: 'Permission denied',
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].content, 'Permission denied');
  });

  it('should map write tool to file_write event type', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p4', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'write', callID: 'c2',
          state: { status: 'running', input: { path: 'src/new.ts', content: '...' }, time: { start: 1 } },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'file_write');
  });

  it('should map edit tool to file_write event type', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p5', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'edit', callID: 'c3',
          state: { status: 'running', input: { path: 'src/index.ts' }, time: { start: 1 } },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'file_write');
  });

  it('should map step-start to thinking event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p6', sessionID: SESSION_ID, messageID: 'm1',
          type: 'step-start',
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'thinking');
  });

  it('should map patch part to file_write events', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p7', sessionID: SESSION_ID, messageID: 'm1',
          type: 'patch', hash: 'abc', files: ['src/a.ts', 'src/b.ts'],
        },
      },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'file_write');
    assert.equal(events[0].content, 'src/a.ts');
    assert.equal(events[0].metadata?.file, 'src/a.ts');
    assert.equal(events[1].content, 'src/b.ts');
  });

  it('should map session.error to error event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.error',
      properties: {
        sessionID: SESSION_ID,
        error: {
          name: 'UnknownError',
          data: { message: 'Something went wrong' },
        },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].content, 'Something went wrong');
  });

  it('should map session.idle to complete event', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.idle',
      properties: { sessionID: SESSION_ID },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'complete');
  });

  // ── Session filtering tests ──

  it('should ignore events from different sessions (part update)', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1', sessionID: 'other-session', messageID: 'm1',
          type: 'text', text: 'Should be ignored',
        },
      },
    });
    assert.equal(events.length, 0);
  });

  it('should ignore session.error from different session', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.error',
      properties: {
        sessionID: 'other-session',
        error: { name: 'UnknownError', data: { message: 'Not ours' } },
      },
    });
    assert.equal(events.length, 0);
  });

  it('should ignore session.idle from different session', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.idle',
      properties: { sessionID: 'other-session' },
    });
    assert.equal(events.length, 0);
  });

  it('should handle session.error without sessionID (global error)', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.error',
      properties: {
        error: { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'Auth failed' } },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].content, 'Auth failed');
  });

  it('should ignore unknown event types', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'server.connected',
      properties: {},
    });
    assert.equal(events.length, 0);
  });

  it('should ignore unknown part types', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1', sessionID: SESSION_ID, messageID: 'm1',
          type: 'compaction', auto: true,
        },
      },
    });
    assert.equal(events.length, 0);
  });

  it('should set contextId on all emitted events', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p1', sessionID: SESSION_ID, messageID: 'm1',
          type: 'text', text: 'test',
        },
      },
    }, 'my-context');
    assert.equal(events[0].contextId, 'my-context');
  });

  it('should handle tool pending state (no event emitted)', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'p3', sessionID: SESSION_ID, messageID: 'm1',
          type: 'tool', tool: 'bash', callID: 'c1',
          state: { status: 'pending', input: {}, raw: '' },
        },
      },
    });
    assert.equal(events.length, 0);
  });

  it('should handle session.error with error that has no data.message', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.error',
      properties: {
        sessionID: SESSION_ID,
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'Aborted');
  });

  it('should handle session.error with no error property', () => {
    const events = collectEvents(SESSION_ID, {
      type: 'session.error',
      properties: { sessionID: SESSION_ID },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].content, 'Session error');
  });
});

// ── Diagnostics integration tests ──

describe('OpenCode diagnostics', () => {
  it('should diagnose connection refused errors', async () => {
    const { diagnoseError, formatDiagnostic } = await import('../src/providers/diagnostics.ts');
    const result = diagnoseError('opencode', 'fetch failed: ECONNREFUSED');
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('opencode serve'));
    const formatted = formatDiagnostic(result);
    assert.ok(formatted.includes('💡'));
  });

  it('should diagnose generic auth errors for opencode', async () => {
    const { diagnoseError } = await import('../src/providers/diagnostics.ts');
    const result = diagnoseError('opencode', 'authentication token expired');
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('Authentication failed'));
  });
});
