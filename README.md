# Agent SDK Core

<p align="center">
  <img src="images/logo.png" alt="agent-sdk-core logo" width="400">
</p>

## What is agent-sdk-core?

A shared TypeScript package that provides a unified interface for working with AI coding agent SDKs — GitHub Copilot, Claude Code, OpenAI Codex, OpenCode, Hermes Agent, and OpenClaw. Instead of writing separate integration code for each SDK in every project, this package gives you one consistent API for creating agent sessions, streaming events, and managing connections.

## Why use it?

Each AI coding agent SDK has its own API patterns:
- **Copilot** uses event subscriptions with `session.on(callback)` + `sendAndWait()`
- **Claude Code** uses async generators with `for await (const msg of query(...))`
- **Codex** uses threaded streams with `thread.runStreamed()`
- **OpenCode** uses an HTTP client/server model with REST sessions + SSE event streaming
- **Hermes Agent** uses the Agent Client Protocol over a spawned Hermes ACP process
- **OpenClaw** uses Gateway WebSocket protocol v4 with chat events

This package normalizes all providers into a single `AgentProvider` / `AgentSession` interface with a unified `AgentEvent` stream. You write your event handling once, and it works with any agent.

It also provides optional utilities that most agent-powered apps need: WebSocket server/client helpers with heartbeat and reconnection, a progress aggregator for TTS-friendly summaries, and agent CLI detection.

Currently used by three projects: [copilot-kanban-agent](https://github.com/DanWahlin/copilot-kanban-board), agentmic, and zingit.

## Features

- **Unified Provider Interface** — Single `AgentProvider`/`AgentSession` API that works across Copilot, Claude Code, Codex, OpenCode, Hermes, and OpenClaw
- **Rich Event Stream** — 10 granular `AgentEvent` types (thinking, output, command, command_output, file_read, file_write, file_edit, tool_call, test_result, error, complete) with metadata for files, diffs, commands, and test results
- **Session Resume** — Continue previous agent sessions via `resumeSessionId` (Copilot `resumeSession()`, Codex `resumeThread()`, Claude `resume` option, OpenCode `session.get()`)
- **Image/Attachment Support** — Pass screenshots, inline binary payloads, and files via a unified `AgentAttachment` type on both `execute()` and `send()` calls — each provider handles the SDK-specific format (Copilot: native `blob` attachments for base64 image/binary data, Claude: native image blocks, Codex: local_image input). Config-level attachments merge with per-call attachments.
- **Middleware Hooks** — Inject `onPreToolUse` (e.g., worktree path rewriting) and `onPermissionRequest` (e.g., tool deny-lists) without modifying provider code
- **Agent Detection** — `detectAgents()` checks which CLI tools are installed and available on the system
- **Progress Aggregator** — Batches events over a configurable interval and produces TTS-friendly summaries ("Reading 3 files", "All 5 tests passing")
- **WebSocket Server Utilities** — `createWSServer()` factory with heartbeat ping/pong, `broadcast()` to all clients, configurable path and payload limits
- **WebSocket Client** — `WSClient` class with exponential backoff reconnection, offline message queue, listener-based pub/sub with auto-cleanup
- **Generic WSMessage Envelope** — `WSMessage<T>` typed generic that each consumer extends with its own message vocabulary
- **Tool Classification** — Shared `classifyToolKind()` maps SDK tool names to granular event types across all providers
- **Peer Dependencies** — SDKs are optional peer deps — install only the agents you use

## How to use it

1. **Install the package** and whichever SDK peer dependencies you need (`@github/copilot-sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`, `ws` for OpenClaw)
2. **Detect available agents** — call `detectAgents()` at startup to discover which CLIs are installed on the system
3. **Create a provider** — instantiate `CopilotProvider`, `ClaudeProvider`, `CodexProvider`, `OpenCodeProvider`, `HermesProvider`, or `OpenClawProvider` with optional config, then call `provider.start()`
4. **Create a session** — call `provider.createSession()` with a `contextId`, `workingDirectory`, `systemPrompt`, and an `onEvent` callback that receives the unified `AgentEvent` stream
5. **Execute a prompt** — call `session.execute(prompt)` which streams events through your callback as the agent works (thinking, file reads/writes, commands, output, etc.)
6. **Handle events** — your `onEvent` callback receives typed `AgentEvent` objects that you route to your UI — render them in a panel, accumulate as text, broadcast via WebSocket, whatever your app needs
7. **Optionally send follow-ups** — call `session.send(message)` to continue the conversation without creating a new session. Both `execute()` and `send()` accept an optional `attachments` parameter for per-message images/files.
8. **Optionally use ProgressAggregator** — feed events into it to get batched TTS-friendly summaries like "Modified 3 files, all tests passing"
9. **Optionally use WSClient/createWSServer** — set up WebSocket infrastructure with built-in heartbeat, reconnection, and message queuing
10. **Clean up** — call `session.destroy()` then `provider.stop()` when done

## Installation

```bash
npm install @codewithdan/agent-sdk-core
```

Providers are individually optional — install only the SDKs you use:

```bash
# For Copilot
npm install @github/copilot-sdk

# For Claude Code
npm install @anthropic-ai/claude-agent-sdk

# For Codex
npm install @openai/codex-sdk

# For OpenCode
npm install @opencode-ai/sdk

# For OpenClaw Gateway WebSocket support
npm install ws
```

## Quick Start

```typescript
import { CopilotProvider, detectAgents } from '@codewithdan/agent-sdk-core';

// Check which agents are available
const agents = await detectAgents();
console.log(agents); // [{ name: 'copilot', available: true, ... }, ...]

// Create and use a provider
const provider = new CopilotProvider();
await provider.start();

const session = await provider.createSession({
  contextId: 'my-task-1',
  workingDirectory: '/path/to/project',
  systemPrompt: 'You are a helpful coding assistant.',
  onEvent: (event) => {
    console.log(event.type, event.content);
    // thinking, output, command, file_read, file_write, error, complete, ...
  },
});

const result = await session.execute('Fix the failing tests');
console.log(result.status); // 'complete' or 'failed'

// Send follow-up with an image attachment
await session.send('Now fix this CSS issue too', [
  { type: 'base64_image', data: screenshotBase64, mediaType: 'image/png', displayName: 'bug-screenshot.png' },
]);

await session.destroy();
await provider.stop();
```

## Package Structure

```
@codewithdan/agent-sdk-core
├── types/          # Event types, provider interfaces, WS message envelope
├── providers/      # Copilot, Claude, Codex, OpenCode, Hermes, OpenClaw providers + detection + ProgressAggregator
└── ws/             # WebSocket server and client utilities
```

### Subpath Imports

```typescript
// Everything
import { CopilotProvider, AgentEvent, WSClient } from '@codewithdan/agent-sdk-core';

// Types only (no runtime code)
import type { AgentEvent, WSMessage } from '@codewithdan/agent-sdk-core/types';

// Providers only
import { ClaudeProvider } from '@codewithdan/agent-sdk-core/providers';

// WebSocket utilities only
import { WSClient, createWSServer } from '@codewithdan/agent-sdk-core/ws';
```

## Event Types

Providers emit `AgentEvent` objects with 10 granular event types:

| Type | Description |
|------|-------------|
| `thinking` | Agent reasoning / intent |
| `output` | General text output |
| `command` | Command or tool started |
| `command_output` | Command execution result |
| `file_read` | Agent read a file |
| `file_write` | Agent wrote/modified a file |
| `file_edit` | Alias — consumers that don't distinguish read/write |
| `tool_call` | Generic tool invocation |
| `test_result` | Test execution results |
| `error` | Error occurred |
| `complete` | Agent finished |

Each event includes:

```typescript
interface AgentEvent {
  id: string;           // UUID
  contextId: string;    // Consumer-defined (taskId, runId, etc.)
  type: AgentEventType;
  content: string;
  timestamp: number;
  metadata?: {
    file?: string;
    command?: string;
    diff?: string;
    agentType?: 'copilot' | 'claude' | 'codex' | 'opencode' | 'hermes' | 'openclaw';
    duration?: number;
    error?: string;
    testsPassing?: number;
    testsFailing?: number;
  };
}
```

## Providers

### CopilotProvider

```typescript
const provider = new CopilotProvider({
  model: 'claude-opus-4-20250514',  // optional, defaults to env COPILOT_MODEL
  deniedTools: 'dangerous_tool',     // optional, comma-separated deny list
});
```

Features: streaming events, session resume, native blob attachments for inline base64 image/binary payloads, file path attachments, worktree path rewriting hooks, permission deny-list, spinner filtering.

### ClaudeProvider

```typescript
const provider = new ClaudeProvider({
  model: 'claude-opus-4-20250514',  // optional, defaults to env CLAUDE_MODEL
});
```

Features: async generator streaming, multimodal image support (base64), query lock for concurrency, session resume.

### CodexProvider

```typescript
const provider = new CodexProvider({
  model: 'gpt-5.2-codex',  // optional, defaults to env CODEX_MODEL
});
```

Features: thread-based sessions, thread resume, local image input, structured file change events, AbortController.

### OpenCodeProvider

```typescript
const provider = new OpenCodeProvider({
  model: 'anthropic/claude-sonnet-4-20250514',  // optional, defaults to env OPENCODE_MODEL
  baseUrl: 'http://localhost:4096',              // optional, connect to existing server
  hostname: '127.0.0.1',                         // optional, for embedded server
  port: 4096,                                    // optional, for embedded server
});
```

The `model` option uses a `providerID/modelID` format (e.g., `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`). This matches OpenCode's native model identifier format.

**Modes:**
- **Embedded server** (default) — `start()` launches an OpenCode server process and connects a client to it. Best for self-contained usage.
- **Connect to existing** — pass `baseUrl` to connect to an already-running `opencode serve` instance. Useful for shared or long-lived servers.

Features: HTTP client/server architecture, REST session management, real-time SSE event streaming, session resume, system prompt injection, structured error reporting.

### HermesProvider

```typescript
const provider = new HermesProvider({
  command: 'hermes',      // optional, defaults to env HERMES_COMMAND or "hermes"
  acceptHooks: true,      // optional, auto-approve Hermes shell hooks for headless ACP startup
});
```

Features: Agent Client Protocol integration, session resume, image attachments, permission hooks, safe environment forwarding, process cleanup.

### OpenClawProvider

```typescript
const provider = new OpenClawProvider({
  url: 'ws://127.0.0.1:18789',  // optional, defaults to env OPENCLAW_GATEWAY_URL
  sessionKey: 'agentmic',       // optional, defaults to env OPENCLAW_SESSION_KEY or "main"
});
```

Features: Gateway WebSocket protocol v4, token/password/device auth, chat streaming, session resume via `resumeSessionId`, `chat.abort`, `chat.history`, image attachments, defensive runId adoption for older streams, and replacement-delta metadata (`event.metadata.replace`). OpenClaw emits conservative text/error/complete events and does not fabricate tool/file/command events unless the Gateway stream exposes them.

### Session Config

All providers accept the same `AgentSessionConfig`:

```typescript
const session = await provider.createSession({
  contextId: 'unique-id',           // Required
  workingDirectory: '/path',         // Required
  systemPrompt: 'instructions',     // Required
  onEvent: (event) => {},           // Required — receives AgentEvent stream
  repoPath: '/original/repo',       // Optional — for worktree rewriting
  resumeSessionId: 'prev-session',  // Optional — resume prior session
  attachments: [{                   // Optional — images/files
    type: 'base64_image',
    data: '...',
    mediaType: 'image/png',
  }],
  hooks: {                          // Optional — middleware injection
    onPreToolUse: (input) => input,
    onPermissionRequest: (req) => ({ kind: 'approved' }),
  },
});
```

For Copilot-specific inline binary payloads, you can also pass `type: 'base64_blob'` with any valid MIME type (for example `application/pdf` or `application/octet-stream`). Other providers continue to support their existing attachment formats and may ignore unsupported inline binary types.

## ProgressAggregator

Batches events into human-readable summaries for TTS or status displays:

```typescript
import { ProgressAggregator } from '@codewithdan/agent-sdk-core';

const aggregator = new ProgressAggregator((summary, events) => {
  console.log(summary);
  // "Reading 3 files, Running npm test"
  // "Modified 2 files: App.tsx, index.ts"
  // "Finished. 2 files modified. All 5 tests passing."
}, 12000); // flush every 12s

// Feed events as they arrive
session.onEvent = (event) => aggregator.push(event);

// When done
aggregator.stop(); // flushes remaining events
```

## WebSocket Utilities

### Server

```typescript
import { createWSServer, broadcast } from '@codewithdan/agent-sdk-core';

const { wss, cleanup } = createWSServer({
  server: httpServer,     // or: port: 3000
  path: '/ws',
  maxPayload: 10 * 1024 * 1024,
  heartbeatInterval: 30000,
  onMessage: (ws, data) => { /* route messages */ },
});

// Broadcast to all connected clients
broadcast(wss, { type: 'agent_event', payload: event });
```

### Client

```typescript
import { WSClient } from '@codewithdan/agent-sdk-core';

const client = new WSClient({
  url: 'ws://localhost:3001/ws',
  maxAttempts: 10,       // exponential backoff reconnection
  maxBackoffMs: 30000,
  maxQueueSize: 10,      // offline message buffer
});

const unsubscribe = client.subscribe((msg) => {
  console.log(msg.type, msg.payload);
});

client.send({ type: 'chat', payload: { text: 'hello' } });

// Later
unsubscribe(); // auto-disconnects when no subscribers
```

## Generic WSMessage Envelope

```typescript
interface WSMessage<T = unknown> {
  type: string;     // each app defines its own message types
  payload: T;
  timestamp?: number;
}
```

## Environment Variables

| Variable | Default | Used by |
|----------|---------|---------|
| `COPILOT_MODEL` | `claude-opus-4-20250514` | CopilotProvider |
| `COPILOT_DENIED_TOOLS` | _(none)_ | CopilotProvider |
| `CLAUDE_MODEL` | `claude-opus-4-20250514` | ClaudeProvider |
| `CODEX_MODEL` | `gpt-5.2-codex` | CodexProvider |
| `OPENCODE_MODEL` | `anthropic/claude-sonnet-4-20250514` | OpenCodeProvider |
| `HERMES_COMMAND` | `hermes` | HermesProvider |
| `HERMES_*` | _(none)_ | HermesProvider safe forwarded env |
| `OPENCLAW_GATEWAY_URL` | `ws://127.0.0.1:18789` | OpenClawProvider |
| `OPENCLAW_TOKEN` / `OPENCLAW_GATEWAY_TOKEN` | _(none)_ | OpenClawProvider token auth |
| `OPENCLAW_PASSWORD` | _(none)_ | OpenClawProvider password auth |
| `OPENCLAW_DEVICE_ID` / `OPENCLAW_DEVICE_PUBLIC_KEY` / `OPENCLAW_DEVICE_PRIVATE_KEY` / `OPENCLAW_DEVICE_TOKEN` | _(none)_ | OpenClawProvider signed device auth |
| `OPENCLAW_SESSION_KEY` | `main` | OpenClawProvider |
| `OPENCLAW_AGENT_ID` | _(none)_ | OpenClawProvider |

Model environment variables can also be set via the provider constructor's `model` option. The constructor value takes precedence over the environment variable. For OpenCode, the model must be in `providerID/modelID` format (e.g., `anthropic/claude-sonnet-4-20250514` or `openai/gpt-4o`).

## Tests

```bash
npm test          # unit tests (types, event mapping, WS, validation, diagnostics, attachments, providers)
npm run test:e2e  # live e2e tests against configured providers (requires CLIs/services installed)
```

The e2e suite exercises live provider flows such as streaming events, multiple concurrent sessions, session resume, abort, follow-up messages, and clean shutdown where supported.

## License

MIT
