# AGENTS.md

## Project Overview

`@codewithdan/agent-sdk-core` — shared foundation for AI coding agent SDK integration. Provides unified providers, event types, and WebSocket utilities used by three consumer projects: copilot-kanban-agent, agentmic, and zingit.

## Architecture

```
agent-sdk-core/
├── src/
│   ├── index.ts              # Barrel export
│   ├── types/
│   │   ├── events.ts         # AgentEvent, AgentEventType (10 kinds), AgentEventMetadata
│   │   ├── agents.ts         # AgentType, AgentStatus, AgentInfo
│   │   ├── messages.ts       # WSMessage<T> generic envelope
│   │   └── providers.ts      # AgentProvider, AgentSession, AgentSessionConfig interfaces
│   ├── providers/
│   │   ├── copilot.ts        # CopilotProvider — @github/copilot-sdk wrapper
│   │   ├── claude.ts         # ClaudeProvider — @anthropic-ai/claude-agent-sdk wrapper
│   │   ├── codex.ts          # CodexProvider — @openai/codex-sdk wrapper
│   │   ├── detection.ts      # detectAgents() — CLI availability check
│   │   └── progress.ts       # ProgressAggregator — TTS-friendly event summarizer
│   └── ws/
│       ├── server.ts         # createWSServer(), createHeartbeat(), broadcast()
│       └── client.ts         # WSClient — reconnect, backoff, message queue
└── tests/
    ├── types.test.ts         # Event types, WSMessage, AgentSessionConfig tests
    └── ws-client.test.ts     # WSClient unit tests
```

## Key Design Decisions

- **Generic `contextId`** — not `taskId` or `runId`. Each consumer maps to its own domain concept.
- **Generic `WSMessage<T>`** — typed envelope. Each consumer defines its own message vocabulary.
- **10 granular event types** — superset covering all three consumer needs: `thinking`, `output`, `command`, `command_output`, `file_read`, `file_write`, `file_edit`, `tool_call`, `test_result`, `error`, `complete`.
- **All SDK features opt-in** — resume, attachments, hooks, ProgressAggregator are optional.
- **Peer dependencies** — SDKs are optional peer deps. Install only the agents you use.

## Consumer Projects

| Project | Integration | What it adds on top |
|---------|-------------|---------------------|
| **copilot-kanban-agent** | Imports providers directly into `agent-manager.ts` | Multi-task orchestration, LRU event cache, DB persistence, broadcast |
| **agentmic** | `core-adapter.ts` wraps providers into `ProviderAdapter` interface | TTS summarization, voice routing, OpenClaw provider |
| **zingit** | `CoreProviderAdapter` wraps providers into zingit `Agent` interface | Session state, git checkpoints, image capture |

## Build & Test

```bash
npm install
npm run build    # tsc -b → dist/
npm test         # node --test (14 tests)
```

## Code Patterns

- **Provider pattern**: `AgentProvider` creates `AgentSession`s via `createSession()`. Each session has `execute()`, `send()`, `abort()`, `destroy()`.
- **Event callback**: Providers call `config.onEvent(event)` for every SDK event, mapping to unified `AgentEvent`.
- **Tool classification**: `classifyToolKind()` maps SDK tool names to granular event types (`file_read`, `file_write`, `command`, etc.).
- **ProgressAggregator**: Batches events over interval, groups by kind, produces TTS summaries ("Reading 3 files", "All tests passing").
- **WSClient**: Exponential backoff (1s→30s), FIFO message queue (max 10), auto-cleanup on last unsubscribe.
