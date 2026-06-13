import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  OpenClawProvider,
  buildOpenClawAcpPromptBlocks,
  createOpenClawEnvironment,
} from '../src/providers/openclaw.ts';
import type { AgentEvent } from '../src/types/events.ts';

type RpcMessage = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

class FakeOpenClawProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignal: string | undefined;
  messages: RpcMessage[] = [];
  private buffer = '';
  private onMessage?: (message: RpcMessage, process: FakeOpenClawProcess) => void;

  constructor(onMessage?: (message: RpcMessage, process: FakeOpenClawProcess) => void) {
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

function respondToInitialize(message: RpcMessage, process: FakeOpenClawProcess): boolean {
  if (message.method !== 'initialize') return false;
  process.respond(message, {
    protocolVersion: 1,
    agentInfo: { name: 'openclaw', version: '2026.6.2' },
    agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } },
  });
  return true;
}

describe('OpenClawProvider ACP construction', () => {
  it('should expose OpenClaw metadata', () => {
    const provider = new OpenClawProvider({ model: 'gateway configured default', command: 'openclaw' });
    assert.equal(provider.name, 'openclaw');
    assert.equal(provider.displayName, 'OpenClaw');
    assert.equal(provider.model, 'gateway configured default');
  });

  it('should read command and model defaults from the injected env', () => {
    const provider = new OpenClawProvider({
      env: {
        OPENCLAW_COMMAND: '/opt/openclaw/bin/openclaw',
        OPENCLAW_MODEL: 'configured-gateway-model',
      },
    });

    assert.equal(provider.model, 'configured-gateway-model');
  });

  it('should spawn openclaw acp with safe args and env-backed secrets', async () => {
    let spawnCall: { command: string; args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const fake = new FakeOpenClawProcess((message, process) => {
      respondToInitialize(message, process);
    });
    const provider = new OpenClawProvider({
      command: 'openclaw',
      gatewayUrl: 'ws://127.0.0.1:18789',
      gatewayToken: 'secret-token',
      sessionKey: 'agent:main:main',
      resetSession: true,
      provenanceMode: 'meta',
      verbose: true,
      env: { API_KEY: 'server-secret', OPENCLAW_HOME: '/tmp/openclaw' },
      spawn: (command, args, options) => {
        spawnCall = { command, args, env: options.env };
        return fake as never;
      },
    });

    await provider.start();

    assert.equal(spawnCall?.command, 'openclaw');
    assert.deepEqual(spawnCall?.args, [
      'acp',
      '--url', 'ws://127.0.0.1:18789',
      '--session', 'agent:main:main',
      '--reset-session',
      '--provenance', 'meta',
      '--verbose',
    ]);
    assert.equal(spawnCall?.args.includes('secret-token'), false);
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_TOKEN, 'secret-token');
    assert.equal(spawnCall?.env?.OPENCLAW_HOME, '/tmp/openclaw');
    assert.equal(spawnCall?.env?.API_KEY, undefined);
    assert.equal(fake.messages[0].method, 'initialize');
  });

  it('should keep legacy Gateway option names compatible without exposing secrets in args', async () => {
    let spawnCall: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const fake = new FakeOpenClawProcess((message, process) => {
      respondToInitialize(message, process);
    });
    const provider = new OpenClawProvider({
      url: 'ws://127.0.0.1:18789',
      token: 'legacy-token',
      password: 'legacy-password',
      spawn: (_command, args, options) => {
        spawnCall = { args, env: options.env };
        return fake as never;
      },
    });

    await provider.start();

    assert.deepEqual(spawnCall?.args, ['acp', '--url', 'ws://127.0.0.1:18789']);
    assert.equal(spawnCall?.args.includes('legacy-token'), false);
    assert.equal(spawnCall?.args.includes('legacy-password'), false);
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_TOKEN, 'legacy-token');
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_PASSWORD, 'legacy-password');
  });

  it('should throw if createSession is called before start', async () => {
    const provider = new OpenClawProvider();
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

describe('OpenClaw ACP helpers', () => {
  it('should not include unrelated server secrets in the child environment', () => {
    const env = createOpenClawEnvironment({
      API_KEY: 'server-secret',
      DATABASE_URL: 'postgres://secret',
      OPENCLAW_HOME: '/tmp/openclaw',
    });

    assert.equal(env.API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.OPENCLAW_HOME, '/tmp/openclaw');
  });

  it('should build text and image ACP prompt blocks', async () => {
    const imageData = Buffer.from('image').toString('base64');
    const blocks = await buildOpenClawAcpPromptBlocks('hello', [
      { type: 'base64_image', data: imageData, mediaType: 'image/png', displayName: 'Screenshot' },
    ], '/tmp/project');

    assert.deepEqual(blocks, [
      { type: 'text', text: '[Screenshot]' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
      { type: 'text', text: 'hello' },
    ]);
  });

  it('should reject unsupported file attachments explicitly', async () => {
    await assert.rejects(
      () => buildOpenClawAcpPromptBlocks('hello', [{ type: 'file', path: '/tmp/project/file.txt' }], '/tmp/project'),
      { message: /file attachments are not supported/ },
    );
  });
});

describe('OpenClawProvider ACP sessions', () => {
  it('should create a session, execute a prompt, and map streaming updates', async () => {
    const fake = new FakeOpenClawProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/new') {
        assert.equal(message.params?.cwd, '/tmp/project');
        process.respond(message, { sessionId: 'openclaw-sess-123' });
        return;
      }
      if (message.method === 'session/prompt') {
        const prompt = message.params?.prompt as Array<{ type: string; text?: string }>;
        assert.ok(prompt.some(block => block.text?.includes('system prompt')));
        process.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'openclaw-sess-123',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
          },
        });
        process.respond(message, { stopReason: 'end_turn' });
      }
    });
    const provider = new OpenClawProvider({ spawn: () => fake as never });
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
    assert.equal(session.sessionId, 'openclaw-sess-123');
    assert.ok(events.some(event => event.type === 'output' && event.content === 'done'));
    assert.ok(events.some(event => event.type === 'complete'));
  });

  it('should resume a session without duplicating the system prompt', async () => {
    const promptTexts: string[] = [];
    let resumeParams: Record<string, unknown> | undefined;
    const fake = new FakeOpenClawProcess((message, process) => {
      if (respondToInitialize(message, process)) return;
      if (message.method === 'session/resume') {
        resumeParams = message.params;
        process.respond(message, { sessionId: 'existing-acp-session' });
        return;
      }
      if (message.method === 'session/prompt') {
        const prompt = message.params?.prompt as Array<{ text?: string }>;
        promptTexts.push(prompt.map(block => block.text ?? '').join('\n'));
        process.respond(message, { stopReason: 'end_turn' });
      }
    });
    const provider = new OpenClawProvider({ spawn: () => fake as never });
    await provider.start();

    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: 'system prompt',
      resumeSessionId: 'existing-acp-session',
      onEvent: () => {},
    });

    await session.execute('follow-up');

    assert.equal(session.sessionId, 'existing-acp-session');
    assert.deepEqual(resumeParams, {
      sessionId: 'existing-acp-session',
      cwd: '/tmp/project',
      mcpServers: [],
    });
    assert.equal(promptTexts[0], 'follow-up');
  });

  it('should send session/cancel and resolve the in-flight prompt as failed on abort', async () => {
    let promptRequest: RpcMessage | undefined;
    let cancelSent = false;
    const fake = new FakeOpenClawProcess((message, process) => {
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
        assert.ok(promptRequest);
        process.respond(promptRequest, { stopReason: 'cancelled' });
      }
    });
    const provider = new OpenClawProvider({ spawn: () => fake as never });
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
    const fake = new FakeOpenClawProcess((message, process) => {
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
    const provider = new OpenClawProvider({ spawn: () => fake as never });
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
    assert.ok(result.error?.includes('connection closed') || result.error?.includes('boom'));
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('OpenClaw ACP process failed')));
  });
});
