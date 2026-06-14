import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HermesProvider,
  buildAcpPromptBlocks,
  createHermesEnvironment,
} from '../src/providers/hermes.ts';
import {
  createPermissionAcpProcess,
  createResumeAcpProcess,
  FakeAcpProcess,
  assertAcpAttachmentBlocks,
  assertRejectsOutOfBoundaryFileAttachment,
  collectEvents,
  registerAbortAndExitTests,
  respondToInitializeRequest,
  runPermissionScenario,
  runResumeScenario,
  runStreamingPromptScenario,
} from './helpers/acp.ts';
import type { RpcMessage } from './helpers/acp.ts';

function createStartedProvider(fake: FakeAcpProcess): HermesProvider {
  return new HermesProvider({
    command: 'hermes',
    model: 'configured default',
    spawn: () => fake as never,
  });
}

function respondToInitialize(message: RpcMessage, process: FakeAcpProcess): boolean {
  return respondToInitializeRequest(message, process, {
    protocolVersion: 1,
    agentInfo: { name: 'hermes-agent', version: '0.14.0' },
    agentCapabilities: {},
  });
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
    const fake = new FakeAcpProcess((message, process) => {
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
      API_KEY: 'redacted-api-key-fixture',
      DATABASE_URL: 'postgres://redacted-fixture',
      HERMES_HOME: '/tmp/hermes',
    });

    assert.equal(env.API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.HERMES_HOME, '/tmp/hermes');
  });

  it('should build text, image, file, and blob ACP prompt blocks', async () => {
    await assertAcpAttachmentBlocks({
      buildBlocks: buildAcpPromptBlocks,
      fileName: 'context.txt',
      fileContent: 'file context',
    });
  });

  it('should reject file attachments outside the working directory', async () => {
    await assertRejectsOutOfBoundaryFileAttachment(buildAcpPromptBlocks);
  });
});

describe('HermesProvider ACP sessions', () => {
  it('should create a session, execute a prompt, and map streaming updates', async () => {
    const fake = new FakeAcpProcess((message, process) => {
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

    await runStreamingPromptScenario({
      process: fake,
      provider: createStartedProvider(fake),
      sessionId: 'sess-123',
      expectedOutput: 'done',
      errorLabel: 'Hermes',
    });
  });

  it('should resume a session and avoid duplicating the system prompt', async () => {
    const promptTexts: string[] = [];
    let resumeParams: Record<string, unknown> | undefined;
    const fake = createResumeAcpProcess({
      initialize: respondToInitialize,
      sessionId: 'sess-existing',
      promptTexts,
      captureResumeParams: params => { resumeParams = params; },
    });

    await runResumeScenario({
      provider: createStartedProvider(fake),
      sessionId: 'sess-existing',
      expectedResumeParams: {
        sessionId: 'sess-existing',
        cwd: '/tmp/project',
        mcpServers: [],
      },
      getResumeParams: () => resumeParams,
      getPromptText: () => promptTexts[0],
    });
  });

  it('should prefer allow_once for approved permission requests', async () => {
    let permissionResponse: RpcMessage | undefined;
    const fake = createPermissionAcpProcess({
      initialize: respondToInitialize,
      sessionId: 'sess-perm',
      requestId: 'perm-1',
      toolCall: { toolCallId: 'tc-1', kind: 'execute', title: 'Run shell', rawInput: { command: 'npm test' } },
      permissionOptions: [
        { kind: 'allow_always', name: 'Always', optionId: 'always' },
        { kind: 'allow_once', name: 'Once', optionId: 'once' },
      ],
      captureResponse: message => { permissionResponse = message; },
    });

    await runPermissionScenario({
      provider: createStartedProvider(fake),
      hookDecision: 'approved',
      getPermissionResponse: () => permissionResponse,
      expectedOptionId: 'once',
    });
  });

  it('should prefer reject_once for denied permission requests', async () => {
    let permissionResponse: RpcMessage | undefined;
    const fake = createPermissionAcpProcess({
      initialize: respondToInitialize,
      sessionId: 'sess-deny',
      requestId: 'perm-2',
      toolCall: { toolCallId: 'tc-1', kind: 'execute', title: 'Run shell' },
      permissionOptions: [
        { kind: 'reject_always', name: 'Never', optionId: 'never' },
        { kind: 'reject_once', name: 'No', optionId: 'no' },
      ],
      captureResponse: message => { permissionResponse = message; },
    });

    await runPermissionScenario({
      provider: createStartedProvider(fake),
      hookDecision: 'denied-by-rules',
      getPermissionResponse: () => permissionResponse,
      expectedOptionId: 'no',
    });
  });

  registerAbortAndExitTests({
    providerLabel: 'Hermes',
    createProvider: createStartedProvider,
    initialize: respondToInitialize,
  });
});
