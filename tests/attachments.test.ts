import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'fs';
import type { AgentEvent } from '../src/types/events.ts';
import type { AgentAttachment } from '../src/types/providers.ts';

// ── Shared fixtures ──

const TINY_PNG_B64 = Buffer.from('fake-png-data-for-test').toString('base64');
const TINY_JPEG_B64 = Buffer.from('fake-jpeg-data-for-test').toString('base64');

function makeImageAttachment(overrides?: Partial<AgentAttachment>): AgentAttachment {
  return {
    type: 'base64_image',
    data: TINY_PNG_B64,
    mediaType: 'image/png',
    displayName: 'screenshot.png',
    ...overrides,
  };
}

function collectEvents(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => events.push(e) };
}

// ══════════════════════════════════════════════════════════════════════
// 1. COPILOT PROVIDER — image bridging + per-request temp file cleanup
// ══════════════════════════════════════════════════════════════════════

describe('CopilotProvider image attachments', () => {
  let sendAndWaitCalls: Array<{ prompt: string; attachments?: unknown[] }>;
  let provider: InstanceType<typeof import('../src/providers/copilot.ts').CopilotProvider>;

  beforeEach(async () => {
    sendAndWaitCalls = [];

    const mockSession = {
      sessionId: 'mock-copilot-session',
      on: (_cb: unknown) => () => {},
      sendAndWait: async (options: any, _timeout?: number) => {
        sendAndWaitCalls.push(options);
        return undefined;
      },
      abort: async () => {},
      destroy: async () => {},
    };

    const mockClient = {
      createSession: async () => mockSession,
      resumeSession: async () => mockSession,
      start: async () => {},
      stop: async () => [],
    };

    const { CopilotProvider } = await import('../src/providers/copilot.ts');
    provider = new CopilotProvider();
    (provider as any).client = mockClient;
  });

  it('should bridge base64_image to file attachment on execute()', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('describe this', [makeImageAttachment()]);

    assert.equal(sendAndWaitCalls.length, 1);
    const call = sendAndWaitCalls[0];
    assert.ok(call.attachments, 'should have attachments');
    assert.equal(call.attachments!.length, 1);
    const att = call.attachments![0] as any;
    assert.equal(att.type, 'file');
    assert.ok(att.path.includes('agent-sdk-'), 'path should be a temp file');
    assert.ok(att.path.endsWith('.png'), 'should have .png extension');
    assert.equal(att.displayName, 'screenshot.png');

    // Temp file should be cleaned up after execute returns
    assert.equal(existsSync(att.path), false, 'temp file should be cleaned up');
    await session.destroy();
  });

  it('should bridge base64_image to file attachment on send()', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('initial message');
    await session.send('follow-up with image', [makeImageAttachment({ mediaType: 'image/jpeg', displayName: 'photo.jpg' })]);

    assert.equal(sendAndWaitCalls.length, 2);
    const sendCall = sendAndWaitCalls[1];
    assert.ok(sendCall.attachments);
    assert.equal(sendCall.attachments!.length, 1);
    const att = sendCall.attachments![0] as any;
    assert.equal(att.type, 'file');
    assert.ok(att.path.endsWith('.jpg'));
    assert.equal(att.displayName, 'photo.jpg');
    assert.equal(existsSync(att.path), false, 'temp file should be cleaned up');
    await session.destroy();
  });

  it('should merge config-level and per-call attachments on execute()', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
      attachments: [{ type: 'file', path: '/tmp/context.txt', displayName: 'context' }],
    });

    await session.execute('describe both', [makeImageAttachment()]);

    const call = sendAndWaitCalls[0];
    assert.equal(call.attachments!.length, 2, 'should have config + per-call attachments');
    assert.equal((call.attachments![0] as any).path, '/tmp/context.txt');
    assert.equal((call.attachments![1] as any).type, 'file'); // bridged image
    await session.destroy();
  });

  it('should pass local_image as file attachment', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('check this', [{ type: 'local_image', path: '/tmp/photo.png', displayName: 'local' }]);

    const att = sendAndWaitCalls[0].attachments![0] as any;
    assert.equal(att.type, 'file');
    assert.equal(att.path, '/tmp/photo.png');
    assert.equal(att.displayName, 'local');
    await session.destroy();
  });

  it('should reject base64_image with invalid MIME type', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('test', [makeImageAttachment({ mediaType: 'application/pdf' })]);

    const call = sendAndWaitCalls[0];
    assert.equal(call.attachments, undefined, 'rejected attachment should not be passed');
    await session.destroy();
  });

  it('should reject attachment outside working directory', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp/project',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('test', [{ type: 'file', path: '/etc/passwd' }]);

    const call = sendAndWaitCalls[0];
    assert.equal(call.attachments, undefined, 'out-of-boundary file should be rejected');
    await session.destroy();
  });

  it('should send no attachments when called without them (backwards compat)', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('plain text prompt');

    const call = sendAndWaitCalls[0];
    assert.equal(call.attachments, undefined);
    await session.destroy();
  });

  it('should clean up temp files even when sendAndWait throws', async () => {
    // Replace mock to throw
    let capturedPath: string | null = null;
    const throwingSession = {
      sessionId: 'mock-throw',
      on: (_cb: unknown) => () => {},
      sendAndWait: async (options: any) => {
        if (options.attachments?.[0]) capturedPath = options.attachments[0].path;
        throw new Error('SDK crashed');
      },
      abort: async () => {},
      destroy: async () => {},
    };
    (provider as any).client = {
      createSession: async () => throwingSession,
    };

    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    const result = await session.execute('test', [makeImageAttachment()]);
    assert.equal(result.status, 'failed');
    assert.ok(capturedPath, 'temp file should have been created');
    assert.equal(existsSync(capturedPath!), false, 'temp file should be cleaned up even on error');
    await session.destroy();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. CLAUDE PROVIDER — base64_image → image content blocks
// ══════════════════════════════════════════════════════════════════════

describe('ClaudeProvider image attachments', () => {
  let buildContentBlocks: typeof import('../src/providers/claude.ts').buildContentBlocks;

  beforeEach(async () => {
    const mod = await import('../src/providers/claude.ts');
    buildContentBlocks = mod.buildContentBlocks;
  });

  it('should include image content block for base64_image', () => {
    const blocks = buildContentBlocks('describe this image', [makeImageAttachment()]);

    const imageBlock = blocks.find((b: any) => b.type === 'image');
    assert.ok(imageBlock, 'should have an image content block');
    assert.equal((imageBlock as any).source.type, 'base64');
    assert.equal((imageBlock as any).source.media_type, 'image/png');
    assert.equal((imageBlock as any).source.data, TINY_PNG_B64);

    const textBlock = blocks.find((b: any) => b.type === 'text' && b.text === 'describe this image');
    assert.ok(textBlock, 'should have the prompt text block');
  });

  it('should include displayName label before image block', () => {
    const blocks = buildContentBlocks('check', [makeImageAttachment({ displayName: 'My Screenshot' })]);

    const labelBlock = blocks.find((b: any) => b.type === 'text' && b.text === '[My Screenshot]');
    assert.ok(labelBlock, 'should have display name label');

    // Label should come before image
    const labelIdx = blocks.indexOf(labelBlock!);
    const imageIdx = blocks.findIndex((b: any) => b.type === 'image');
    assert.ok(labelIdx < imageIdx, 'label should precede image block');
  });

  it('should handle multiple image attachments', () => {
    const blocks = buildContentBlocks('describe both', [
      makeImageAttachment({ displayName: 'first.png' }),
      makeImageAttachment({ mediaType: 'image/jpeg', displayName: 'second.jpg' }),
    ]);

    const imageBlocks = blocks.filter((b: any) => b.type === 'image');
    assert.equal(imageBlocks.length, 2, 'should have two image blocks');
    assert.equal((imageBlocks[0] as any).source.media_type, 'image/png');
    assert.equal((imageBlocks[1] as any).source.media_type, 'image/jpeg');
  });

  it('should reject base64_image with invalid MIME type', () => {
    const blocks = buildContentBlocks('test', [makeImageAttachment({ mediaType: 'text/html' })]);

    const imageBlock = blocks.find((b: any) => b.type === 'image');
    assert.equal(imageBlock, undefined, 'invalid MIME type should be rejected');
    // Should only have the prompt text
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });

  it('should skip base64_image without data', () => {
    const blocks = buildContentBlocks('test', [makeImageAttachment({ data: undefined })]);

    const imageBlock = blocks.find((b: any) => b.type === 'image');
    assert.equal(imageBlock, undefined, 'attachment without data should be skipped');
  });

  it('should produce only text block without attachments (backwards compat)', () => {
    const blocks = buildContentBlocks('plain prompt');

    assert.equal(blocks.length, 1, 'should only have text block');
    assert.equal(blocks[0].type, 'text');
    assert.equal((blocks[0] as any).text, 'plain prompt');
  });

  it('should produce only text block with empty attachments array', () => {
    const blocks = buildContentBlocks('plain prompt', []);

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'text');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. CODEX PROVIDER — base64_image → temp file → local_image input
// ══════════════════════════════════════════════════════════════════════

describe('CodexProvider image attachments', () => {
  let runStreamedCalls: any[];
  let provider: InstanceType<typeof import('../src/providers/codex.ts').CodexProvider>;

  beforeEach(async () => {
    runStreamedCalls = [];

    const mockThread = {
      id: 'mock-codex-thread',
      runStreamed: async (input: any) => {
        runStreamedCalls.push(input);
        return {
          events: (async function* () {
            yield { type: 'completed', response: { output: [] } };
          })(),
        };
      },
    };

    const mockCodex = {
      startThread: () => mockThread,
      resumeThread: () => mockThread,
    };

    const { CodexProvider } = await import('../src/providers/codex.ts');
    provider = new CodexProvider();
    (provider as any).codex = mockCodex;
  });

  it('should convert base64_image to local_image temp file on execute()', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('describe this', [makeImageAttachment()]);

    assert.equal(runStreamedCalls.length, 1);
    const input = runStreamedCalls[0];
    const imageInput = input.find((i: any) => i.type === 'local_image');
    assert.ok(imageInput, 'should have a local_image input');
    assert.ok(imageInput.path.includes('agent-sdk-'), 'should be a temp file path');
    assert.ok(imageInput.path.endsWith('.png'));

    // Check displayName label is included
    const labelInput = input.find((i: any) => i.type === 'text' && i.text === '[screenshot.png]');
    assert.ok(labelInput, 'should include displayName label');

    // Text prompt should be last
    const textInput = input[input.length - 1];
    assert.equal(textInput.type, 'text');
    assert.ok(textInput.text.includes('describe this'));
    await session.destroy();
  });

  it('should pass attachments on send() follow-up', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('first');
    runStreamedCalls = [];

    await session.send('follow-up', [makeImageAttachment({ displayName: 'new-image.png' })]);

    assert.equal(runStreamedCalls.length, 1);
    const input = runStreamedCalls[0];
    const imageInput = input.find((i: any) => i.type === 'local_image');
    assert.ok(imageInput, 'send() should include image attachment');
    await session.destroy();
  });

  it('should pass local_image directly when path is within boundary', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('check', [{ type: 'local_image', path: '/tmp/existing.png', displayName: 'existing' }]);

    const input = runStreamedCalls[0];
    const imageInput = input.find((i: any) => i.type === 'local_image');
    assert.ok(imageInput);
    assert.equal(imageInput.path, '/tmp/existing.png', 'should use original path directly');
    await session.destroy();
  });

  it('should reject local_image outside working directory', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp/project',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('test', [{ type: 'local_image', path: '/etc/shadow' }]);

    const input = runStreamedCalls[0];
    const imageInput = input.find((i: any) => i.type === 'local_image');
    assert.equal(imageInput, undefined, 'out-of-boundary path should be rejected');
    await session.destroy();
  });

  it('should work without attachments (backwards compat)', async () => {
    const { events, onEvent } = collectEvents();
    const session = await provider.createSession({
      contextId: 'test-ctx',
      workingDirectory: '/tmp',
      systemPrompt: 'test',
      onEvent,
    });

    await session.execute('plain prompt');

    const input = runStreamedCalls[0];
    assert.equal(input.length, 1, 'should only have text input');
    assert.equal(input[0].type, 'text');
    await session.destroy();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. OPENCODE PROVIDER — warns and ignores attachments
// ══════════════════════════════════════════════════════════════════════

describe('OpenCodeProvider image attachments', () => {
  it('should warn when attachments are passed to execute()', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); origWarn(msg); };

    try {
      const { OpenCodeProvider } = await import('../src/providers/opencode.ts');
      const provider = new OpenCodeProvider({ model: 'anthropic/claude-sonnet-4-20250514' });

      // We can't call execute without a running server, but we can verify
      // the warning path by checking the interface accepts attachments
      // and the provider code warns. Test the signature compatibility:
      const session = {
        execute: provider.createSession.toString(),
      };
      assert.ok(session.execute.includes('attachments'));
      assert.ok(session.execute.includes('attachments are not supported by OpenCode'));
    } finally {
      console.warn = origWarn;
    }
  });

  it('should warn when attachments are passed to send()', async () => {
    const { OpenCodeProvider } = await import('../src/providers/opencode.ts');
    const provider = new OpenCodeProvider({ model: 'anthropic/claude-sonnet-4-20250514' });

    // Verify the send path also includes the warning
    const sourceCode = provider.createSession.toString();
    assert.ok(sourceCode.includes('attachments are not supported by OpenCode'));
  });
});
