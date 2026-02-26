import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Test the unified event types and interfaces
describe('AgentEvent types', () => {
  it('should create a valid AgentEvent', () => {
    const event = {
      id: 'test-id',
      contextId: 'ctx-1',
      type: 'output' as const,
      content: 'Hello world',
      timestamp: Date.now(),
    };
    assert.equal(event.contextId, 'ctx-1');
    assert.equal(event.type, 'output');
  });

  it('should support all event types', () => {
    const types = ['thinking', 'tool_call', 'file_edit', 'command', 'output', 'error', 'complete'];
    for (const type of types) {
      const event = { id: '1', contextId: 'c', type, content: '', timestamp: 0 };
      assert.ok(event.type);
    }
  });

  it('should support metadata', () => {
    const event = {
      id: 'test-id',
      contextId: 'ctx-1',
      type: 'command' as const,
      content: 'bash: ls',
      timestamp: Date.now(),
      metadata: {
        command: 'bash',
        file: '/tmp/test.ts',
        agentType: 'copilot' as const,
      },
    };
    assert.equal(event.metadata.command, 'bash');
    assert.equal(event.metadata.file, '/tmp/test.ts');
    assert.equal(event.metadata.agentType, 'copilot');
  });
});

describe('WSMessage envelope', () => {
  it('should create a generic WSMessage', () => {
    const msg = {
      type: 'agent_event',
      payload: { id: '1', contextId: 'c', type: 'output', content: 'hi', timestamp: 0 },
      timestamp: Date.now(),
    };
    assert.equal(msg.type, 'agent_event');
    assert.equal(msg.payload.content, 'hi');
  });

  it('should work with app-specific message types', () => {
    // Kanban-style
    const kanbanMsg = {
      type: 'task_updated',
      payload: { id: 'task-1', title: 'Fix bug' },
    };
    assert.equal(kanbanMsg.type, 'task_updated');

    // AgentMic-style
    const agentmicMsg = {
      type: 'delta',
      payload: { content: 'chunk of text' },
    };
    assert.equal(agentmicMsg.type, 'delta');
  });
});

describe('AgentSessionConfig', () => {
  it('should support optional resume', () => {
    const config = {
      contextId: 'ctx-1',
      workingDirectory: '/tmp',
      systemPrompt: 'You are helpful.',
      onEvent: () => {},
      resumeSessionId: 'session-123',
    };
    assert.equal(config.resumeSessionId, 'session-123');
  });

  it('should support optional attachments', () => {
    const config = {
      contextId: 'ctx-1',
      workingDirectory: '/tmp',
      systemPrompt: 'You are helpful.',
      onEvent: () => {},
      attachments: [
        { type: 'base64_image' as const, data: 'abc123', mediaType: 'image/png', displayName: 'Screenshot' },
        { type: 'file' as const, path: '/tmp/img.png' },
        { type: 'local_image' as const, path: '/tmp/local.png' },
      ],
    };
    assert.equal(config.attachments!.length, 3);
    assert.equal(config.attachments![0].type, 'base64_image');
  });

  it('should support optional hooks', () => {
    const hookCalled = { permission: false, preTool: false };
    const config = {
      contextId: 'ctx-1',
      workingDirectory: '/tmp',
      systemPrompt: 'You are helpful.',
      onEvent: () => {},
      hooks: {
        onPermissionRequest: (req: { kind: string }) => {
          hookCalled.permission = true;
          return { kind: 'approved' as const };
        },
        onPreToolUse: (input: unknown) => {
          hookCalled.preTool = true;
          return input;
        },
      },
    };
    config.hooks!.onPermissionRequest!({ kind: 'shell' });
    config.hooks!.onPreToolUse!({});
    assert.ok(hookCalled.permission);
    assert.ok(hookCalled.preTool);
  });
});

describe('detectAgents', () => {
  it('should return an array of AgentInfo', async () => {
    // This test runs against the real system — agents may or may not be installed
    const { detectAgents } = await import('../src/providers/detection.ts');
    const agents = await detectAgents();
    assert.ok(Array.isArray(agents));
    assert.equal(agents.length, 4);
    const names = agents.map(a => a.name);
    assert.ok(names.includes('copilot'));
    assert.ok(names.includes('claude'));
    assert.ok(names.includes('codex'));
    assert.ok(names.includes('opencode'));
    for (const agent of agents) {
      assert.equal(typeof agent.available, 'boolean');
      assert.equal(typeof agent.displayName, 'string');
    }
  });
});
