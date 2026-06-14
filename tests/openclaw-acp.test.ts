import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenClawProvider,
  buildOpenClawAcpPromptBlocks,
  createOpenClawEnvironment,
} from '../src/providers/openclaw.ts';
import {
  createResumeAcpProcess,
  FakeAcpProcess,
  assertAcpAttachmentBlocks,
  assertRejectsOutOfBoundaryFileAttachment,
  assertRejectsSymlinkEscapes,
  collectEvents,
  registerAbortAndExitTests,
  respondToInitializeRequest,
  runResumeScenario,
  runStreamingPromptScenario,
} from './helpers/acp.ts';
import type { RpcMessage } from './helpers/acp.ts';

function createStartedProvider(fake: FakeAcpProcess): OpenClawProvider {
  return new OpenClawProvider({ spawn: () => fake as never });
}

function respondToInitialize(message: RpcMessage, process: FakeAcpProcess): boolean {
  return respondToInitializeRequest(message, process, {
    protocolVersion: 1,
    agentInfo: { name: 'openclaw', version: '2026.6.2' },
    agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } },
  });
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
    const fake = new FakeAcpProcess((message, process) => {
      respondToInitialize(message, process);
    });
    const provider = new OpenClawProvider({
      command: 'openclaw',
      gatewayUrl: 'ws://127.0.0.1:18789',
      gatewayToken: 'redacted-token-fixture',
      sessionKey: 'agent:main:main',
      resetSession: true,
      provenanceMode: 'meta',
      verbose: true,
      env: { API_KEY: 'redacted-api-key-fixture', OPENCLAW_HOME: '/tmp/openclaw' },
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
    assert.equal(spawnCall?.args.includes('redacted-token-fixture'), false);
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_TOKEN, 'redacted-token-fixture');
    assert.equal(spawnCall?.env?.OPENCLAW_HOME, '/tmp/openclaw');
    assert.equal(spawnCall?.env?.API_KEY, undefined);
    assert.equal(fake.messages[0].method, 'initialize');
  });

  it('should keep legacy Gateway option names compatible without exposing secrets in args', async () => {
    let spawnCall: { args: string[]; env?: NodeJS.ProcessEnv } | undefined;
    const fake = new FakeAcpProcess((message, process) => {
      respondToInitialize(message, process);
    });
    const provider = new OpenClawProvider({
      url: 'ws://127.0.0.1:18789',
      token: 'redacted-legacy-token-fixture',
      password: 'redacted-legacy-password-fixture',
      spawn: (_command, args, options) => {
        spawnCall = { args, env: options.env };
        return fake as never;
      },
    });

    await provider.start();

    assert.deepEqual(spawnCall?.args, ['acp', '--url', 'ws://127.0.0.1:18789']);
    assert.equal(spawnCall?.args.includes('redacted-legacy-token-fixture'), false);
    assert.equal(spawnCall?.args.includes('redacted-legacy-password-fixture'), false);
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_TOKEN, 'redacted-legacy-token-fixture');
    assert.equal(spawnCall?.env?.OPENCLAW_GATEWAY_PASSWORD, 'redacted-legacy-password-fixture');
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
      API_KEY: 'redacted-api-key-fixture',
      DATABASE_URL: 'postgres://redacted-fixture',
      OPENCLAW_HOME: '/tmp/openclaw',
    });

    assert.equal(env.API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.OPENCLAW_HOME, '/tmp/openclaw');
  });

  it('should build text, image, file, and blob ACP prompt blocks', async () => {
    await assertAcpAttachmentBlocks({
      buildBlocks: buildOpenClawAcpPromptBlocks,
      fileName: 'openclaw-context.txt',
      fileContent: 'openclaw file context',
    });
  });

  it('should reject file attachments outside the working directory', async () => {
    await assertRejectsOutOfBoundaryFileAttachment(buildOpenClawAcpPromptBlocks);
  });

  it('should reject symlink attachments that escape the working directory', async () => {
    await assertRejectsSymlinkEscapes(buildOpenClawAcpPromptBlocks);
  });
});

describe('OpenClawProvider ACP sessions', () => {
  it('should create a session, execute a prompt, and map streaming updates', async () => {
    const fake = new FakeAcpProcess((message, process) => {
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

    await runStreamingPromptScenario({
      process: fake,
      provider: createStartedProvider(fake),
      sessionId: 'openclaw-sess-123',
      expectedOutput: 'done',
      errorLabel: 'OpenClaw',
    });
  });

  it('should resume a session without duplicating the system prompt', async () => {
    const promptTexts: string[] = [];
    let resumeParams: Record<string, unknown> | undefined;
    const fake = createResumeAcpProcess({
      initialize: respondToInitialize,
      sessionId: 'existing-acp-session',
      promptTexts,
      captureResumeParams: params => { resumeParams = params; },
    });

    await runResumeScenario({
      provider: createStartedProvider(fake),
      sessionId: 'existing-acp-session',
      expectedResumeParams: {
        sessionId: 'existing-acp-session',
        cwd: '/tmp/project',
        mcpServers: [],
      },
      getResumeParams: () => resumeParams,
      getPromptText: () => promptTexts[0],
    });
  });

  registerAbortAndExitTests({
    providerLabel: 'OpenClaw',
    createProvider: createStartedProvider,
    initialize: respondToInitialize,
  });
});
