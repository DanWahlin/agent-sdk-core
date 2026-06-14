import { EventEmitter } from 'events';
import { mkdir, symlink, writeFile } from 'fs/promises';
import { PassThrough } from 'stream';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { AgentAttachment } from '../../src/types/providers.ts';

export type RpcMessage = {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export class FakeAcpProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedSignal: string | undefined;
  messages: RpcMessage[] = [];
  private buffer = '';
  private onMessage?: (message: RpcMessage, process: FakeAcpProcess) => void;

  constructor(onMessage?: (message: RpcMessage, process: FakeAcpProcess) => void) {
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

export function collectEvents(): { events: Array<{ type: string; content: string }>; onEvent: (event: { type: string; content: string }) => void } {
  const events: Array<{ type: string; content: string }> = [];
  return { events, onEvent: event => events.push(event) };
}

export function respondToInitializeRequest(
  message: RpcMessage,
  process: FakeAcpProcess,
  result: Record<string, unknown>,
): boolean {
  if (message.method !== 'initialize') return false;
  process.respond(message, result);
  return true;
}

export async function assertAcpAttachmentBlocks(
  options: {
    buildBlocks: (prompt: string, attachments: AgentAttachment[] | undefined, workingDirectory: string) => Promise<unknown[]>;
    fileName: string;
    fileContent: string;
  },
): Promise<void> {
  const imageData = Buffer.from('image').toString('base64');
  const blobData = Buffer.from('pdf').toString('base64');
  const filePath = `/tmp/project/${options.fileName}`;
  await mkdir('/tmp/project', { recursive: true });
  await writeFile(filePath, options.fileContent);

  const localImageData = Buffer.from('local image').toString('base64');
  const localImagePath = '/tmp/project/local.png';
  await writeFile(localImagePath, Buffer.from('local image'));
  const blocks = await options.buildBlocks('hello', [
    { type: 'base64_image', data: imageData, mediaType: 'image/png', displayName: 'Screenshot' },
    { type: 'local_image', path: localImagePath, displayName: 'local.png' },
    { type: 'file', path: filePath, mediaType: 'text/plain', displayName: 'context.txt' },
    { type: 'base64_blob', data: blobData, mediaType: 'application/pdf', displayName: 'spec.pdf' },
  ], '/tmp/project');

  assert.deepEqual(blocks, [
    { type: 'text', text: '[Screenshot]' },
    { type: 'image', data: imageData, mimeType: 'image/png' },
    { type: 'text', text: '[local.png]' },
    { type: 'image', data: localImageData, mimeType: 'image/png' },
    { type: 'text', text: '[context.txt]' },
    {
      type: 'resource',
      resource: {
        uri: `file://${filePath}`,
        blob: Buffer.from(options.fileContent).toString('base64'),
        mimeType: 'text/plain',
      },
    },
    { type: 'text', text: '[spec.pdf]' },
    {
      type: 'resource',
      resource: {
        uri: 'attachment://spec.pdf',
        blob: blobData,
        mimeType: 'application/pdf',
      },
    },
    { type: 'text', text: 'hello' },
  ]);
}

export async function assertRejectsOutOfBoundaryFileAttachment(
  buildBlocks: (prompt: string, attachments: AgentAttachment[] | undefined, workingDirectory: string) => Promise<unknown[]>,
): Promise<void> {
  await assert.rejects(
    () => buildBlocks('hello', [{ type: 'file', path: '/etc/passwd' }], '/tmp/project'),
    { message: /outside working directory/ },
  );
}

export async function assertRejectsSymlinkEscapes(
  buildBlocks: (prompt: string, attachments: AgentAttachment[] | undefined, workingDirectory: string) => Promise<unknown[]>,
): Promise<void> {
  await mkdir('/tmp/project', { recursive: true });
  await writeFile('/tmp/outside-secret.txt', 'outside secret');
  await writeFile('/tmp/outside-image.png', Buffer.from('outside image'));
  await symlink('/tmp/outside-secret.txt', '/tmp/project/escape.txt').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await symlink('/tmp/outside-image.png', '/tmp/project/escape.png').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });

  await assert.rejects(
    () => buildBlocks('hello', [{ type: 'file', path: '/tmp/project/escape.txt' }], '/tmp/project'),
    { message: /outside working directory|symlink/i },
  );
  await assert.rejects(
    () => buildBlocks('hello', [{ type: 'local_image', path: '/tmp/project/escape.png' }], '/tmp/project'),
    { message: /outside working directory|symlink/i },
  );
}

export async function runStreamingPromptScenario(
  options: {
    process: FakeAcpProcess;
    provider: { start(): Promise<void>; createSession(config: any): Promise<any> };
    sessionId: string;
    expectedOutput: string;
    errorLabel: string;
  },
): Promise<void> {
  await options.provider.start();
  const { events, onEvent } = collectEvents();
  const session = await options.provider.createSession({
    contextId: 'ctx-1',
    workingDirectory: '/tmp/project',
    systemPrompt: 'system prompt',
    onEvent,
  });

  const result = await session.execute('prompt');

  if (result.status !== 'complete') {
    throw new Error(`${options.errorLabel} prompt failed: ${result.error ?? 'unknown error'}`);
  }
  if (session.sessionId !== options.sessionId) {
    throw new Error(`${options.errorLabel} returned unexpected session id: ${session.sessionId}`);
  }
  if (!events.some(event => event.type === 'output' && event.content === options.expectedOutput)) {
    throw new Error(`${options.errorLabel} did not emit expected output`);
  }
  if (!events.some(event => event.type === 'complete')) {
    throw new Error(`${options.errorLabel} did not emit completion`);
  }
}

export function createResumeAcpProcess(
  options: {
    initialize: (message: RpcMessage, process: FakeAcpProcess) => boolean;
    sessionId: string;
    promptTexts: string[];
    captureResumeParams: (params: Record<string, unknown> | undefined) => void;
  },
): FakeAcpProcess {
  return new FakeAcpProcess((message, process) => {
    if (options.initialize(message, process)) return;
    if (message.method === 'session/resume') {
      options.captureResumeParams(message.params);
      process.respond(message, { sessionId: options.sessionId });
      return;
    }
    if (message.method === 'session/prompt') {
      const prompt = message.params?.prompt as Array<{ text?: string }>;
      options.promptTexts.push(prompt.map(block => block.text ?? '').join('\n'));
      process.respond(message, { stopReason: 'end_turn' });
    }
  });
}

export function createPermissionAcpProcess(
  options: {
    initialize: (message: RpcMessage, process: FakeAcpProcess) => boolean;
    sessionId: string;
    requestId: string;
    toolCall: Record<string, unknown>;
    permissionOptions: Array<Record<string, unknown>>;
    captureResponse: (message: RpcMessage) => void;
  },
): FakeAcpProcess {
  return new FakeAcpProcess((message, process) => {
    if (options.initialize(message, process)) return;
    if (message.method === 'session/new') {
      process.respond(message, { sessionId: options.sessionId });
      return;
    }
    if (message.method === 'session/prompt') {
      process.send({
        jsonrpc: '2.0',
        id: options.requestId,
        method: 'session/request_permission',
        params: {
          sessionId: options.sessionId,
          toolCall: options.toolCall,
          options: options.permissionOptions,
        },
      });
      return;
    }
    if (message.id === options.requestId && message.result) {
      options.captureResponse(message);
      const promptRequest = process.messages.find(candidate => candidate.method === 'session/prompt');
      if (!promptRequest) throw new Error('missing prompt request after permission response');
      process.respond(promptRequest, { stopReason: 'end_turn' });
    }
  });
}

export async function runPermissionScenario(
  options: {
    provider: { start(): Promise<void>; createSession(config: any): Promise<any> };
    hookDecision: 'approved' | 'denied-by-rules';
    getPermissionResponse: () => RpcMessage | undefined;
    expectedOptionId: string;
  },
): Promise<void> {
  await options.provider.start();
  const session = await options.provider.createSession({
    contextId: 'ctx-1',
    workingDirectory: '/tmp/project',
    systemPrompt: '',
    onEvent: () => {},
    hooks: {
      onPermissionRequest: () => ({ kind: options.hookDecision }),
    },
  });

  await session.execute('prompt');

  assert.deepEqual(options.getPermissionResponse()?.result, {
    outcome: { outcome: 'selected', optionId: options.expectedOptionId },
  });
}

export function createAbortAcpProcess(
  initialize: (message: RpcMessage, process: FakeAcpProcess) => boolean,
  captureCancel: () => void,
): FakeAcpProcess {
  let promptRequest: RpcMessage | undefined;
  return new FakeAcpProcess((message, process) => {
    if (initialize(message, process)) return;
    if (message.method === 'session/new') {
      process.respond(message, { sessionId: 'sess-abort' });
      return;
    }
    if (message.method === 'session/prompt') {
      promptRequest = message;
      return;
    }
    if (message.method === 'session/cancel') {
      captureCancel();
      if (!promptRequest) throw new Error('missing prompt request before cancel');
      process.respond(promptRequest, { stopReason: 'cancelled' });
    }
  });
}

export function createExitAcpProcess(
  initialize: (message: RpcMessage, process: FakeAcpProcess) => boolean,
): FakeAcpProcess {
  return new FakeAcpProcess((message, process) => {
    if (initialize(message, process)) return;
    if (message.method === 'session/new') {
      process.respond(message, { sessionId: 'sess-close' });
      return;
    }
    if (message.method === 'session/prompt') {
      process.stderr.write('boom\n');
      process.close(1);
    }
  });
}

export async function runResumeScenario(
  options: {
    provider: { start(): Promise<void>; createSession(config: any): Promise<any> };
    sessionId: string;
    expectedResumeParams: Record<string, unknown>;
    getResumeParams: () => Record<string, unknown> | undefined;
    getPromptText: () => string | undefined;
  },
): Promise<void> {
  await options.provider.start();
  const session = await options.provider.createSession({
    contextId: 'ctx-1',
    workingDirectory: '/tmp/project',
    systemPrompt: 'system prompt',
    resumeSessionId: options.sessionId,
    onEvent: () => {},
  });

  await session.execute('follow-up');

  if (session.sessionId !== options.sessionId) {
    throw new Error(`unexpected resumed session id: ${session.sessionId}`);
  }
  assert.deepEqual(options.getResumeParams(), options.expectedResumeParams);
  if (options.getPromptText() !== 'follow-up') {
    throw new Error(`unexpected prompt text: ${options.getPromptText() ?? '<missing>'}`);
  }
}

export function registerAbortAndExitTests(
  options: {
    providerLabel: string;
    createProvider: (process: FakeAcpProcess) => { start(): Promise<void>; createSession(config: any): Promise<any> };
    initialize: (message: RpcMessage, process: FakeAcpProcess) => boolean;
  },
): void {
  it('should send session/cancel and resolve the in-flight prompt as failed on abort', async () => {
    let cancelSent = false;
    const fake = createAbortAcpProcess(options.initialize, () => { cancelSent = true; });

    await runAbortScenario(options.createProvider(fake), () => cancelSent);
  });

  it('should fail pending prompts when the ACP process exits', async () => {
    const fake = createExitAcpProcess(options.initialize);

    await runProcessExitScenario(options.createProvider(fake), options.providerLabel);
  });
}

export async function runAbortScenario(
  provider: { start(): Promise<void>; createSession(config: any): Promise<any> },
  didCancel: () => boolean,
): Promise<void> {
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

  if (!didCancel()) throw new Error('cancel request was not sent');
  if (result.status !== 'failed') throw new Error(`expected failed abort result, got ${result.status}`);
  if (!/aborted/.test(result.error ?? '')) throw new Error(`expected aborted error, got ${result.error ?? '<missing>'}`);
}

export async function runProcessExitScenario(
  provider: { start(): Promise<void>; createSession(config: any): Promise<any> },
  providerLabel: string,
): Promise<void> {
  await provider.start();
  const { events, onEvent } = collectEvents();
  const session = await provider.createSession({
    contextId: 'ctx-1',
    workingDirectory: '/tmp/project',
    systemPrompt: '',
    onEvent,
  });

  const result = await session.execute('prompt');

  if (result.status !== 'failed') throw new Error(`expected failed exit result, got ${result.status}`);
  if (!result.error?.includes('connection closed') && !result.error?.includes('boom')) {
    throw new Error(`expected process exit error, got ${result.error ?? '<missing>'}`);
  }
  if (!events.some(event => event.type === 'error' && event.content.includes(`${providerLabel} ACP process failed`))) {
    throw new Error(`missing ${providerLabel} process failure event`);
  }
}
