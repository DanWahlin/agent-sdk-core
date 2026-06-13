import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentEvent } from '../src/types/events.ts';
import { OpenClawGatewayProvider as OpenClawProvider, buildOpenClawDeviceAuthPayloadV3, mapOpenClawChatEvent, extractOpenClawText } from '../src/providers/openclaw-gateway.ts';

type SentFrame = { type: 'req'; id: string; method: string; params?: Record<string, unknown> };
type IncomingFrame = Record<string, unknown>;

const OPEN = 1;
const CLOSED = 3;

class FakeWebSocket extends EventEmitter {
  static OPEN = OPEN;
  static instances: FakeWebSocket[] = [];
  static connectResponse: { ok: boolean; payload?: Record<string, unknown>; error?: { code?: string; message?: string } } = {
    ok: true,
    payload: { type: 'hello-ok' },
  };
  static challengePayload: Record<string, unknown> = { nonce: 'nonce-1' };

  readyState = OPEN;
  sent: SentFrame[] = [];
  url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.emit('open');
      if (!FakeWebSocket.challengePayload.skipChallenge) {
        this.receive({ type: 'event', event: 'connect.challenge', payload: FakeWebSocket.challengePayload });
      }
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as SentFrame;
    this.sent.push(frame);
    if (frame.method === 'connect') {
      this.receive({
        type: 'res',
        id: frame.id,
        ok: FakeWebSocket.connectResponse.ok,
        payload: FakeWebSocket.connectResponse.payload,
        error: FakeWebSocket.connectResponse.error,
      });
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.emit('close', 1000, Buffer.from('test close'));
  }

  fail(code = 1006, reason = 'network down'): void {
    this.readyState = CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }

  receive(frame: IncomingFrame): void {
    this.emit('message', JSON.stringify(frame));
  }

  respondToFrame(frame: SentFrame, payload: Record<string, unknown>, ok = true): SentFrame {
    this.receive({ type: 'res', id: frame.id, ok, payload });
    return frame;
  }

  rejectFrame(frame: SentFrame, message: string, code = 'TEST_ERROR'): void {
    this.receive({ type: 'res', id: frame.id, ok: false, error: { code, message } });
  }
}

function resetFakeSockets(): void {
  FakeWebSocket.instances = [];
  FakeWebSocket.connectResponse = { ok: true, payload: { type: 'hello-ok' } };
  FakeWebSocket.challengePayload = { nonce: 'nonce-1' };
}

function collectEvents(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: event => events.push(event) };
}

function generateDeviceIdentity(): { deviceId: string; publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const deviceId = crypto.createHash('sha256').update(rawPublicKey).digest('hex');
  return { deviceId, publicKeyPem, privateKeyPem };
}

async function waitForRequest(socket: FakeWebSocket, method: string): Promise<SentFrame> {
  return waitForRequestCount(socket, method, 1);
}

async function waitForRequestCount(socket: FakeWebSocket, method: string, count: number): Promise<SentFrame> {
  for (let i = 0; i < 30; i++) {
    const frames = socket.sent.filter(f => f.method === method);
    if (frames.length >= count) return frames[count - 1];
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.fail(`expected ${count} ${method} request(s)`);
}

async function startedProvider(options: Partial<ConstructorParameters<typeof OpenClawProvider>[0]> = {}): Promise<{ provider: OpenClawProvider; socket: FakeWebSocket }> {
  resetFakeSockets();
  const providerOptions: ConstructorParameters<typeof OpenClawProvider>[0] = {
    WebSocketCtor: FakeWebSocket as never,
    ...options,
  };
  if (!('url' in providerOptions) && !options.env?.OPENCLAW_GATEWAY_URL) providerOptions.url = 'ws://127.0.0.1:18789';
  if (!('token' in providerOptions) && !options.env?.OPENCLAW_DEVICE_TOKEN) providerOptions.token = 'test-token';
  const provider = new OpenClawProvider(providerOptions);
  await provider.start();
  const socket = FakeWebSocket.instances[0];
  assert.ok(socket);
  return { provider, socket };
}

async function createTempImage(): Promise<{ dir: string; imagePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-sdk-'));
  const imagePath = join(dir, 'screenshot.png');
  await writeFile(imagePath, Buffer.from('fake-png'));
  return { dir, imagePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('OpenClaw helpers', () => {
  it('should build v3 device auth payloads for protocol v4 gateways', () => {
    const payload = buildOpenClawDeviceAuthPayloadV3({
      deviceId: 'device-1',
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      signedAtMs: 123,
      token: 'tok',
      nonce: 'nonce',
      platform: 'Linux',
      deviceFamily: 'Server',
    });
    assert.equal(payload, 'v3|device-1|gateway-client|backend|operator|operator.read,operator.write|123|tok|nonce|linux|server');
  });

  it('should extract text from common OpenClaw payload shapes', () => {
    assert.equal(extractOpenClawText({ deltaText: 'delta' }), 'delta');
    assert.equal(extractOpenClawText({ text: 'text' }), 'text');
    assert.equal(extractOpenClawText({ message: { content: [{ type: 'text', text: 'hello' }] } }), 'hello');
  });

  it('should map chat delta and terminal events', () => {
    assert.deepEqual(mapOpenClawChatEvent({ state: 'delta', deltaText: 'hi' }), {
      type: 'output',
      content: 'hi',
      terminal: false,
      replace: false,
    });
    assert.deepEqual(mapOpenClawChatEvent({ state: 'final', message: { content: 'done' } }), {
      type: 'complete',
      content: 'done',
      terminal: true,
      status: 'complete',
    });
    assert.deepEqual(mapOpenClawChatEvent({ state: 'error', errorMessage: 'boom' }), {
      type: 'error',
      content: 'boom',
      terminal: true,
      status: 'failed',
    });
    assert.deepEqual(mapOpenClawChatEvent({ state: 'aborted' }), {
      type: 'error',
      content: 'OpenClaw execution aborted',
      terminal: true,
      status: 'failed',
    });
  });

  it('should not fabricate tool events for unknown OpenClaw chat states', () => {
    assert.deepEqual(mapOpenClawChatEvent({ state: 'custom', text: 'plain runtime text' }), {
      type: 'output',
      content: 'plain runtime text',
      terminal: false,
    });
  });

  it('should preserve OpenClaw replacement deltas as metadata', () => {
    assert.deepEqual(mapOpenClawChatEvent({ state: 'delta', deltaText: 'replacement', replace: true }), {
      type: 'output',
      content: 'replacement',
      terminal: false,
      replace: true,
    });
  });
});

describe('OpenClawProvider construction and connect', () => {
  it('should expose OpenClaw metadata', () => {
    const provider = new OpenClawProvider({ model: 'gateway-model' });
    assert.equal(provider.name, 'openclaw');
    assert.equal(provider.displayName, 'OpenClaw');
    assert.equal(provider.model, 'gateway-model');
  });

  it('should throw if createSession is called before start', async () => {
    const provider = new OpenClawProvider({ WebSocketCtor: FakeWebSocket as never });
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

  it('should connect to Gateway using token auth', async () => {
    const { provider, socket } = await startedProvider();
    const connect = socket.sent.find(f => f.method === 'connect');
    assert.ok(connect);
    assert.equal(connect.params?.minProtocol, 4);
    assert.equal(connect.params?.maxProtocol, 4);
    assert.deepEqual(connect.params?.scopes, ['operator.read', 'operator.write']);
    assert.deepEqual(connect.params?.auth, { token: 'test-token' });
    await provider.stop();
    assert.equal(socket.closed, true);
  });

  it('should connect to Gateway using password auth', async () => {
    const { provider, socket } = await startedProvider({ token: undefined, password: 'secret' });
    const connect = socket.sent.find(f => f.method === 'connect');
    assert.ok(connect);
    assert.deepEqual(connect.params?.auth, { password: 'secret' });
    await provider.stop();
  });

  it('should connect to Gateway using env defaults', async () => {
    const { provider, socket } = await startedProvider({
      token: undefined,
      env: {
        OPENCLAW_GATEWAY_URL: 'ws://example.test:18789',
        OPENCLAW_DEVICE_TOKEN: 'env-device-token',
        OPENCLAW_SESSION_KEY: 'env-session',
        OPENCLAW_AGENT_ID: 'agent-1',
        OPENCLAW_MODEL: 'env-model',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(socket.url, 'ws://example.test:18789');
    assert.equal(provider.model, 'env-model');
    const connect = socket.sent.find(f => f.method === 'connect');
    assert.ok(connect);
    assert.deepEqual(connect.params?.auth, { token: 'env-device-token', deviceToken: 'env-device-token' });
    const session = await provider.createSession({ contextId: 'ctx-env', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const executePromise = session.execute('hello');
    const frame = await waitForRequest(socket, 'chat.send');
    assert.equal(frame.params?.sessionKey, 'env-session');
    assert.equal(frame.params?.agentId, 'agent-1');
    socket.respondToFrame(frame, { runId: 'run-env', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-env', sessionKey: 'env-session', state: 'final' } });
    await executePromise;
    await provider.stop();
  });

  it('should connect to Gateway using a signed device token when device identity is provided', async () => {
    resetFakeSockets();
    const deviceIdentity = generateDeviceIdentity();
    const provider = new OpenClawProvider({
      url: 'ws://127.0.0.1:18789',
      deviceToken: 'device-token-1',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      deviceIdentity,
      WebSocketCtor: FakeWebSocket as never,
    });

    await provider.start();

    const socket = FakeWebSocket.instances[0];
    const connect = socket.sent.find(f => f.method === 'connect');
    assert.ok(connect);
    assert.deepEqual(connect.params?.auth, {
      token: 'device-token-1',
      deviceToken: 'device-token-1',
    });
    assert.deepEqual(connect.params?.scopes, ['operator.admin', 'operator.read', 'operator.write']);
    const client = connect.params?.client as Record<string, unknown>;
    const device = connect.params?.device as Record<string, unknown>;
    assert.equal(client.id, 'gateway-client');
    assert.equal(client.mode, 'backend');
    assert.equal(device.id, deviceIdentity.deviceId);
    assert.equal(typeof device.publicKey, 'string');
    assert.equal(typeof device.signature, 'string');
    assert.equal(device.nonce, 'nonce-1');
    assert.equal(typeof device.signedAt, 'number');

    const payload = buildOpenClawDeviceAuthPayloadV3({
      deviceId: deviceIdentity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write'],
      signedAtMs: device.signedAt as number,
      token: 'device-token-1',
      nonce: 'nonce-1',
      platform: process.platform,
    });
    const signature = Buffer.from((device.signature as string).replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    assert.equal(crypto.verify(null, Buffer.from(payload, 'utf8'), crypto.createPublicKey(deviceIdentity.publicKeyPem), signature), true);

    await provider.stop();
  });

  it('should fail start when the Gateway never sends connect.challenge', async () => {
    resetFakeSockets();
    FakeWebSocket.challengePayload = { skipChallenge: true };
    const provider = new OpenClawProvider({
      WebSocketCtor: FakeWebSocket as never,
      token: 'test-token',
      connectTimeoutMs: 5,
    });
    await assert.rejects(() => provider.start(), /connect challenge timed out/);
    await provider.stop();
  });

  it('should read AgentMic-style raw device identity from env', async () => {
    resetFakeSockets();
    const deviceIdentity = generateDeviceIdentity();
    const rawPublicKey = crypto.createPublicKey(deviceIdentity.publicKeyPem)
      .export({ type: 'spki', format: 'der' })
      .subarray(12)
      .toString('base64url');
    const provider = new OpenClawProvider({
      WebSocketCtor: FakeWebSocket as never,
      env: {
        OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:18789',
        OPENCLAW_DEVICE_ID: deviceIdentity.deviceId,
        OPENCLAW_DEVICE_PUBLIC_KEY: rawPublicKey,
        OPENCLAW_DEVICE_PRIVATE_KEY: deviceIdentity.privateKeyPem,
        OPENCLAW_DEVICE_TOKEN: 'env-device-token',
      } as NodeJS.ProcessEnv,
    });

    await provider.start();

    const socket = FakeWebSocket.instances[0];
    const connect = socket.sent.find(f => f.method === 'connect');
    assert.ok(connect);
    const device = connect.params?.device as Record<string, unknown>;
    assert.equal(device.id, deviceIdentity.deviceId);
    assert.equal(device.publicKey, rawPublicKey);
    assert.equal(device.nonce, 'nonce-1');
    await provider.stop();
  });
});

describe('OpenClawProvider sessions', () => {
  it('should execute chat.send and emit output/complete events', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'ctx-1',
      workingDirectory: '/tmp/project',
      systemPrompt: 'System prompt',
      onEvent,
    });

    const resultPromise = session.execute('Fix tests');
    const sendFrame = socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-1', status: 'started' });
    assert.equal(sendFrame.params?.sessionKey, 'main');
    assert.equal(sendFrame.params?.message, 'System prompt\n\nFix tests');
    assert.equal(sendFrame.params?.deliver, false);
    assert.equal(typeof sendFrame.params?.idempotencyKey, 'string');

    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-1', sessionKey: 'main', state: 'delta', deltaText: 'working' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-1', sessionKey: 'main', state: 'final', message: { content: 'done' } } });

    const result = await resultPromise;
    assert.equal(result.status, 'complete');
    assert.equal(session.sessionId, 'main');
    assert.ok(events.some(e => e.type === 'output' && e.content === 'working'));
    assert.ok(events.some(e => e.type === 'complete' && e.content === 'done'));
    await provider.stop();
  });

  it('should resume with resumeSessionId and avoid duplicating the system prompt', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({
      contextId: 'ctx-resume',
      workingDirectory: '/tmp/project',
      systemPrompt: 'System prompt',
      resumeSessionId: 'existing-session',
      onEvent: () => {},
    });

    const resultPromise = session.execute('Follow up');
    const frame = await waitForRequest(socket, 'chat.send');
    assert.equal(session.sessionId, 'existing-session');
    assert.equal(frame.params?.sessionKey, 'existing-session');
    assert.equal(frame.params?.message, 'Follow up');
    socket.respondToFrame(frame, { runId: 'run-resume', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-resume', sessionKey: 'existing-session', state: 'final' } });
    assert.equal((await resultPromise).status, 'complete');
    await provider.stop();
  });

  it('should send follow-up without repeating the system prompt', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-1', workingDirectory: '/tmp/project', systemPrompt: 'System prompt', onEvent: () => {} });

    const executePromise = session.execute('First');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-1', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-1', sessionKey: 'main', state: 'final', message: { content: 'ok' } } });
    await executePromise;

    const sendPromise = session.send('Follow up');
    const followUpFrame = await waitForRequestCount(socket, 'chat.send', 2);
    assert.equal(followUpFrame.params?.message, 'Follow up');
    socket.respondToFrame(followUpFrame, { runId: 'run-2', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-2', sessionKey: 'main', state: 'final', message: { content: 'ok' } } });
    await sendPromise;
    await provider.stop();
  });

  it('should route concurrent session events by runId', async () => {
    const { provider, socket } = await startedProvider();
    const one = collectEvents();
    const two = collectEvents();
    const session1 = await provider.createSession({ contextId: 'ctx-one', workingDirectory: '/tmp', systemPrompt: '', onEvent: one.onEvent });
    const session2 = await provider.createSession({ contextId: 'ctx-two', workingDirectory: '/tmp', systemPrompt: '', onEvent: two.onEvent });

    const result1 = session1.execute('one');
    const frame1 = await waitForRequest(socket, 'chat.send');
    socket.respondToFrame(frame1, { runId: 'run-one', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));

    const result2 = session2.execute('two');
    const frame2 = await waitForRequestCount(socket, 'chat.send', 2);
    socket.respondToFrame(frame2, { runId: 'run-two', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));

    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-two', sessionKey: 'main', state: 'delta', deltaText: 'two-output' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-one', sessionKey: 'main', state: 'delta', deltaText: 'one-output' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-one', sessionKey: 'main', state: 'final' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-two', sessionKey: 'main', state: 'final' } });

    assert.equal((await result1).status, 'complete');
    assert.equal((await result2).status, 'complete');
    assert.ok(one.events.some(event => event.contextId === 'ctx-one' && event.content === 'one-output'));
    assert.ok(two.events.some(event => event.contextId === 'ctx-two' && event.content === 'two-output'));
    assert.equal(one.events.some(event => event.content === 'two-output'), false);
    assert.equal(two.events.some(event => event.content === 'one-output'), false);
    await provider.stop();
  });

  it('should match events by idempotency key when chat.send ack has no runId', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-fallback', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const resultPromise = session.execute('hello');
    const frame = await waitForRequest(socket, 'chat.send');
    const idempotencyKey = frame.params?.idempotencyKey as string;
    socket.respondToFrame(frame, { status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: idempotencyKey, sessionKey: 'main', state: 'final' } });
    assert.equal((await resultPromise).status, 'complete');
    await provider.stop();
  });

  it('should defensively adopt a distinct event runId when the session key matches', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-adopt', workingDirectory: '/tmp', systemPrompt: '', onEvent });
    const resultPromise = session.execute('hello');
    const frame = await waitForRequest(socket, 'chat.send');
    const ackRunId = frame.params?.idempotencyKey as string;
    socket.respondToFrame(frame, { runId: ackRunId, status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'agent-run-1', sessionKey: 'agent:main:main', state: 'delta', deltaText: 'adopted', replace: true } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'agent-run-1', sessionKey: 'agent:main:main', state: 'final' } });
    assert.equal((await resultPromise).status, 'complete');
    assert.ok(events.some(event => event.type === 'output' && event.content === 'adopted' && event.metadata?.replace === true));
    assert.ok(events.some(event => event.type === 'complete' && event.content === 'adopted'));
    await provider.stop();
  });

  it('should not adopt a distinct event runId when the session key is missing or mismatched', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-no-adopt', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const resultPromise = session.execute('hello');
    const frame = await waitForRequest(socket, 'chat.send');
    const ackRunId = frame.params?.idempotencyKey as string;
    socket.respondToFrame(frame, { runId: ackRunId, status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'agent-run-missing-session', state: 'final' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'agent-run-wrong-session', sessionKey: 'agent:main:other', state: 'final' } });
    socket.receive({ type: 'event', event: 'chat', payload: { runId: ackRunId, sessionKey: 'main', state: 'final' } });
    assert.equal((await resultPromise).status, 'complete');
    await provider.stop();
  });

  it('should fetch chat history from the Gateway', async () => {
    const { provider, socket } = await startedProvider();
    const historyPromise = provider.fetchHistory('agentmic', 2);
    const frame = await waitForRequest(socket, 'chat.history');
    assert.equal(frame.params?.sessionKey, 'agentmic');
    assert.equal(frame.params?.limit, 2);
    socket.respondToFrame(frame, { messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(await historyPromise, [{ role: 'user', content: 'hi' }]);
    await provider.stop();
  });

  it('should return failed and emit error when chat.send is rejected', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-error', workingDirectory: '/tmp/project', systemPrompt: '', onEvent });
    const resultPromise = session.execute('boom');
    const frame = await waitForRequest(socket, 'chat.send');
    socket.rejectFrame(frame, 'gateway said no');
    const result = await resultPromise;
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /gateway said no/);
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('gateway said no')));
    await provider.stop();
  });

  it('should resolve failed when the Gateway emits an aborted chat event', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-aborted', workingDirectory: '/tmp', systemPrompt: '', onEvent });
    const resultPromise = session.execute('long');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-aborted', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-aborted', sessionKey: 'main', state: 'aborted' } });
    const result = await resultPromise;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'OpenClaw execution aborted');
    assert.ok(events.some(event => event.type === 'error' && event.content === 'OpenClaw execution aborted'));
    await provider.stop();
  });

  it('should abort the active OpenClaw run', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-1', workingDirectory: '/tmp/project', systemPrompt: '', onEvent: () => {} });

    const resultPromise = session.execute('Long task');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-abort', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const abortPromise = session.abort();
    const abortFrame = socket.respondToFrame(await waitForRequest(socket, 'chat.abort'), { ok: true, aborted: true, runIds: ['run-abort'] });
    assert.equal(abortFrame.params?.sessionKey, 'main');
    assert.equal(abortFrame.params?.runId, 'run-abort');
    await abortPromise;
    const result = await resultPromise;
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'OpenClaw execution aborted');
    await provider.stop();
  });

  it('should fail pending prompts when the Gateway socket closes', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-close', workingDirectory: '/tmp', systemPrompt: '', onEvent });
    const resultPromise = session.execute('long');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-close', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.fail(1006, 'network down');
    const result = await resultPromise;
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /network down/);
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('OpenClaw Gateway failed')));
    await provider.stop();
  });

  it('should fail active prompts on destroy', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-destroy', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const resultPromise = session.execute('long');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-destroy', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await session.destroy();
    assert.deepEqual(await resultPromise, { status: 'failed', error: 'OpenClaw session destroyed' });
    await provider.stop();
  });

  it('should fail active prompts on provider stop', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-stop', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const resultPromise = session.execute('long');
    socket.respondToFrame(await waitForRequest(socket, 'chat.send'), { runId: 'run-stop', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await provider.stop();
    assert.deepEqual(await resultPromise, { status: 'failed', error: 'OpenClaw provider stopped' });
  });
});

describe('OpenClawProvider attachments', () => {
  it('should send base64_image attachments on execute()', async () => {
    const { provider, socket } = await startedProvider();
    const session = await provider.createSession({ contextId: 'ctx-image', workingDirectory: '/tmp', systemPrompt: '', onEvent: () => {} });
    const imageData = Buffer.from('fake-image').toString('base64');

    const resultPromise = session.execute('describe', [{ type: 'base64_image', data: imageData, mediaType: 'image/png', displayName: 'screenshot.png' }]);
    const frame = await waitForRequest(socket, 'chat.send');
    const attachments = frame.params?.attachments as Array<Record<string, unknown>>;
    assert.deepEqual(attachments, [{ type: 'base64_image', fileName: 'screenshot.png', displayName: 'screenshot.png', content: imageData, mimeType: 'image/png' }]);
    socket.respondToFrame(frame, { runId: 'run-image', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-image', sessionKey: 'main', state: 'final' } });
    assert.equal((await resultPromise).status, 'complete');
    await provider.stop();
  });

  it('should merge config-level and per-call attachments on first execute()', async () => {
    const { provider, socket } = await startedProvider();
    const first = Buffer.from('first').toString('base64');
    const second = Buffer.from('second').toString('base64');
    const session = await provider.createSession({
      contextId: 'ctx-merge',
      workingDirectory: '/tmp',
      systemPrompt: '',
      onEvent: () => {},
      attachments: [{ type: 'base64_image', data: first, mediaType: 'image/png', displayName: 'first.png' }],
    });

    const resultPromise = session.execute('describe', [{ type: 'base64_image', data: second, mediaType: 'image/jpeg', displayName: 'second.jpg' }]);
    const frame = await waitForRequest(socket, 'chat.send');
    const attachments = frame.params?.attachments as Array<Record<string, unknown>>;
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].fileName, 'first.png');
    assert.equal(attachments[1].fileName, 'second.jpg');
    socket.respondToFrame(frame, { runId: 'run-merge', status: 'started' });
    await new Promise(resolve => setTimeout(resolve, 0));
    socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-merge', sessionKey: 'main', state: 'final' } });
    await resultPromise;
    await provider.stop();
  });

  it('should send local_image attachments as base64 file content within the working directory', async () => {
    const temp = await createTempImage();
    try {
      const { provider, socket } = await startedProvider();
      const session = await provider.createSession({ contextId: 'ctx-local-image', workingDirectory: temp.dir, systemPrompt: '', onEvent: () => {} });
      const resultPromise = session.execute('describe', [{ type: 'local_image', path: temp.imagePath, displayName: 'local.png' }]);
      const frame = await waitForRequest(socket, 'chat.send');
      const attachments = frame.params?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachments[0].type, 'local_image');
      assert.equal(attachments[0].path, temp.imagePath);
      assert.equal(attachments[0].fileName, 'local.png');
      assert.equal(attachments[0].mimeType, 'image/png');
      assert.equal(attachments[0].content, Buffer.from('fake-png').toString('base64'));
      socket.respondToFrame(frame, { runId: 'run-local', status: 'started' });
      await new Promise(resolve => setTimeout(resolve, 0));
      socket.receive({ type: 'event', event: 'chat', payload: { runId: 'run-local', sessionKey: 'main', state: 'final' } });
      await resultPromise;
      await provider.stop();
    } finally {
      await temp.cleanup();
    }
  });

  it('should reject unsupported attachments before sending chat.send', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-reject', workingDirectory: '/tmp/project', systemPrompt: '', onEvent });
    const result = await session.execute('inspect', [{ type: 'file', path: '/tmp/project/file.txt', displayName: 'file.txt' }]);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /supports image attachments only/);
    assert.equal(socket.sent.some(frame => frame.method === 'chat.send'), false);
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('supports image attachments only')));
    await provider.stop();
  });

  it('should reject local_image outside the working directory before sending chat.send', async () => {
    const { provider, socket } = await startedProvider();
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({ contextId: 'ctx-boundary', workingDirectory: '/tmp/project', systemPrompt: '', onEvent });
    const result = await session.execute('inspect', [{ type: 'local_image', path: '/etc/passwd', displayName: 'passwd' }]);
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /outside working directory/);
    assert.equal(socket.sent.some(frame => frame.method === 'chat.send'), false);
    assert.ok(events.some(event => event.type === 'error' && event.content.includes('outside working directory')));
    await provider.stop();
  });
});
