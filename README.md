# @codewithdan/agent-sdk-core

Shared foundation for integrating AI coding agent SDKs (GitHub Copilot, Claude Code, OpenAI Codex) across multiple projects.

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

await session.destroy();
await provider.stop();
```

## Package Structure

```
@codewithdan/agent-sdk-core
├── types/          # Event types, provider interfaces, WS message envelope
├── providers/      # Copilot, Claude, Codex providers + detection + ProgressAggregator
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
    agentType?: 'copilot' | 'claude' | 'codex';
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

Features: streaming events, session resume, file attachments, worktree path rewriting hooks, permission deny-list, spinner filtering.

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

## Tests

```bash
npm test
```

## License

MIT
