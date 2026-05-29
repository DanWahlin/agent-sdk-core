import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  HermesProvider,
  buildAcpPromptBlocks,
  createHermesEnvironment,
} from '../src/providers/hermes.ts';
import type { AgentEvent } from '../src/types/events.ts';

type RpcMessage = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

class FakeHermesProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignal: string | undefined;
  messages: RpcMessage[] = [];
  private buffer = '';
  private onMessage?: (message: RpcMessage, process: FakeHermesProcess) => void;

  constructor(onMessage?: (message: RpcMessage, process: FakeHermesProcess) => void) {
    super();
    this.onMessage = onMessage;
    this.stdin.on('data', chunk => this.handleInput(chunk.toString()));
  }

  kill(signal?: string): boolean {
    this.killedSignal = signal;
    this.emit('close', null, signal ?? 'SIGTERM');
    return true;
  }

  respond(request: RpcMessage, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: request.id, result });
  }

  send(message: RpcMessage): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendSplit(message: RpcMessage): void {
    const frame = `${JSON.stringify(message)}\n`;
    const splitAt = Math.max(1, Math.floor(frame.length / 2));
    this.stdout.write(frame.slice(0, splitAt));
    queueMicrotask(() => this.stdout.write(frame.slice(splitAt)));
  }

  close(code = 0): void {
    this.emit('close', code, null);
  }

  private handleInput(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as RpcMessage;
      this.messages.push(message);
      this.onMessage?.(message, this);
    }
  }
}

function collectEvents(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: event => events.push(event) };
}

function createStartedProvider(fake: FakeHermesProcess): HermesProvider {
  return new HermesProvider({
    command: 'hermes',
    model: 'configured default',
    spawn: () => fake as never,
  });
}

function respondToInitialize(message: RpcMessage, process: FakeHermesProcess): boolean {
  if (message.method !== 'initialize') return false;
  process.respond(message, {
    protocolVersion: 1,
    agentInfo: { name: 'hermes-agent', version: '0.14.0' },
    agentCapabilities: {},
  });
  return true;
}

describe('HermesProvider ACP construction', () => {
  it('should expose Hermes metadata', () => {
    const provider = new HermesProvider({ model: 'gpt-5.5', command: 'hermes' });
    assert.equal(provider.name, 'hermes');
    assert.equal(provider.displayName, 'Hermes Agent');
    assert.equal(provider.model, 'gpt-5.5');
  });

  it('should throw if createSession is called before start', async () => {
    const provider = new HermesProvider();
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

  it('should wait for a split initialize frame', async () => {
    const fake = new FakeHermesProcess((message, process) => {
      if (message.method === 'initialize') {
        process.sendSplit({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: 1, agentInfo: { name: 'hermes-agent' }, agentCapabilities: {} },
        });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();
    assert.equal(fake.messages[0].method, 'initialize');
  });
});

describe('Hermes ACP helpers', () => {
  it('should not include unrelated server secrets in the child environment', () => {
    const env = createHermesEnvironment({
      API_KEY: 'server-secret',
      DATABASE_URL: 'postgres://secret',
      HERMES_HOME: '/tmp/hermes',
    });

    assert.equal(env.API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.HERMES_HOME, '/tmp/hermes');
  });

  it('should build text and image ACP prompt blocks', async () => {
    const blocks = await buildAcpPromptBlocks('hello', [
      { type: 'base64_image', data: Buffer.from('image').toString('base64'), mediaType: 'image/png', displayName: 'Screenshot' },
    ], '/tmp/project');

    assert.deepEqual(blocks, [
      { type: 'text', text: '[Screenshot]' },
      { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('should reject file attachments explicitly', async () => {
    await assert.rejects(
      () => buildAcpPromptBlocks('hello', [{ type: 'file', path: '/tmp/project/file.txt' }], '/tmp/project'),
      { message: /file attachments are not supported/ },
    );
  });
});

describe('HermesProvider ACP sessions', () => {
  it('should create a session, execute a prompt, and map streaming updates', async () => {
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        assert.equal(message.params?.cwd, '/tmp/project');
        process.respond(message, { sessionId: 'sess-123' });
        return;
      }
      if (message.method === 'session/prompt') {
        const prompt = message.params?.prompt as Array<{ type: string; text?: string }>;
        assert.ok(prompt.some(block => block.text?.includes('system prompt')));
        process.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-123',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
          },
        });
        process.respond(message, { stopReason: 'end_turn' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();

    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: 'system prompt',
      onEvent,
    });

    const result = await session.execute('prompt');

    assert.equal(result.status, 'complete');
    assert.equal(session.sessionId, 'sess-123');
    assert.ok(events.some(event => event.type === 'output' && event.content === 'done'));
    assert.ok(events.some(event => event.type === 'complete'));
  });

  it('should resume a session and avoid duplicating the system prompt', async () => {
    const promptTexts: string[] = [];
    let resumeParams: Record<string, unknown> | undefined;
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/resume') {
        resumeParams = message.params;
        process.respond(message, { sessionId: 'sess-existing' });
        return;
      }
      if (message.method === 'session/prompt') {
        const prompt = message.params?.prompt as Array<{ text?: string }>;
        promptTexts.push(prompt.map(block => block.text ?? '').join('\n'));
        process.respond(message, { stopReason: 'end_turn' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();

    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: 'system prompt',
      resumeSessionId: 'sess-existing',
      onEvent: () => {},
    });

    await session.execute('follow-up');

    assert.equal(session.sessionId, 'sess-existing');
    assert.deepEqual(resumeParams, {
      sessionId: 'sess-existing',
      cwd: '/tmp/project',
      mcpServers: [],
    });
    assert.equal(promptTexts[0], 'follow-up');
  });

  it('should prefer allow_once for approved permission requests', async () => {
    let permissionResponse: RpcMessage | undefined;
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        process.respond(message, { sessionId: 'sess-perm' });
        return;
      }
      if (message.method === 'session/prompt') {
        process.send({
          jsonrpc: '2.0',
          id: 'perm-1',
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-perm',
            toolCall: { toolCallId: 'tc-1', kind: 'execute', title: 'Run shell', rawInput: { command: 'npm test' } },
            options: [
              { kind: 'allow_always', name: 'Always', optionId: 'always' },
              { kind: 'allow_once', name: 'Once', optionId: 'once' },
            ],
          },
        });
        return;
      }
      if (message.id === 'perm-1' && message.result) {
        permissionResponse = message;
        const promptRequest = process.messages.find(candidate => candidate.method === 'session/prompt');
        assert.ok(promptRequest);
        process.respond(promptRequest, { stopReason: 'end_turn' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();

    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: '',
      onEvent: () => {},
      hooks: {
        onPermissionRequest: () => ({ kind: 'approved' }),
      },
    });

    await session.execute('prompt');

    assert.deepEqual(permissionResponse?.result, {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  });

  it('should prefer reject_once for denied permission requests', async () => {
    let permissionResponse: RpcMessage | undefined;
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        process.respond(message, { sessionId: 'sess-deny' });
        return;
      }
      if (message.method === 'session/prompt') {
        process.send({
          jsonrpc: '2.0',
          id: 'perm-2',
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-deny',
            toolCall: { toolCallId: 'tc-1', kind: 'execute', title: 'Run shell' },
            options: [
              { kind: 'reject_always', name: 'Never', optionId: 'never' },
              { kind: 'reject_once', name: 'No', optionId: 'no' },
            ],
          },
        });
        return;
      }
      if (message.id === 'perm-2' && message.result) {
        permissionResponse = message;
        const promptRequest = process.messages.find(candidate => candidate.method === 'session/prompt');
        assert.ok(promptRequest);
        process.respond(promptRequest, { stopReason: 'end_turn' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();

    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: '',
      onEvent: () => {},
      hooks: {
        onPermissionRequest: () => ({ kind: 'denied-by-rules' }),
      },
    });

    await session.execute('prompt');

    assert.deepEqual(permissionResponse?.result, {
      outcome: { outcome: 'selected', optionId: 'no' },
    });
  });

  it('should send session/cancel and resolve the in-flight prompt as failed on abort', async () => {
    let promptRequest: RpcMessage | undefined;
    let cancelSent = false;
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        process.respond(message, { sessionId: 'sess-abort' });
        return;
      }
      if (message.method === 'session/prompt') {
        promptRequest = message;
        return;
      }
      if (message.method === 'session/cancel') {
        cancelSent = true;
        process.respond(message, {});
        assert.ok(promptRequest);
        process.respond(promptRequest, { stopReason: 'cancelled' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();
    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: '',
      onEvent: () => {},
    });

    const execution = session.execute('long prompt');
    await new Promise<void>(resolve => setImmediate(resolve));
    await session.abort();
    const result = await execution;

    assert.equal(cancelSent, true);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /aborted/);
  });

  it('should fail pending prompts when the ACP process exits', async () => {
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        process.respond(message, { sessionId: 'sess-close' });
        return;
      }
      if (message.method === 'session/prompt') {
        process.stderr.write('boom\n');
        process.close(1);
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: '',
      onEvent,
    });

    const result = await session.execute('prompt');

    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('boom'));
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('Hermes ACP process failed')));
  });

  it('should reply to unknown agent requests with method-not-found', async () => {
    let unknownResponse: RpcMessage | undefined;
    const fake = new FakeHermesProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        process.respond(message, { sessionId: 'sess-unknown' });
        return;
      }
      if (message.method === 'session/prompt') {
        process.send({
          jsonrpc: '2.0',
          id: 'unknown-1',
          method: 'client/unknown',
          params: {},
        });
        return;
      }
      if (message.id === 'unknown-1' && message.error) {
        unknownResponse = message;
        const promptRequest = process.messages.find(candidate => candidate.method === 'session/prompt');
        assert.ok(promptRequest);
        process.respond(promptRequest, { stopReason: 'end_turn' });
      }
    });
    const provider = createStartedProvider(fake);
    await provider.start();
    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: '',
      onEvent: () => {},
    });

    await session.execute('prompt');

    assert.equal(unknownResponse?.error?.code, -32601);
  });
});
