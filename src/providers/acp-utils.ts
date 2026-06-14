import type {
  ContentBlock,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { AgentEventType } from '../types/events.js';
import type { AgentAttachment, AgentSessionConfig } from '../types/providers.js';
import { emitAgentEvent } from './events.js';
import {
  readFileAttachment,
  readLocalImageAttachment,
  requireBase64BlobAttachment,
  requireBase64ImageAttachment,
} from './attachments.js';

export async function buildAcpPromptBlocks(
  providerLabel: string,
  prompt: string,
  attachments: AgentAttachment[] | undefined,
  workingDirectory: string,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.displayName) {
      blocks.push({ type: 'text', text: `[${attachment.displayName}]` });
    }

    if (attachment.type === 'base64_image') {
      const image = requireBase64ImageAttachment(attachment, providerLabel);
      blocks.push({ type: 'image', data: image.data, mimeType: image.mediaType });
      continue;
    }

    if (attachment.type === 'local_image') {
      const image = await readLocalImageAttachment(attachment, workingDirectory, providerLabel);
      blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      continue;
    }

    if (attachment.type === 'base64_blob') {
      const blob = requireBase64BlobAttachment(attachment, providerLabel);
      blocks.push({
        type: 'resource',
        resource: {
          uri: `attachment://${encodeURIComponent(blob.displayName)}`,
          blob: blob.data,
          mimeType: blob.mediaType,
        },
      });
      continue;
    }

    if (attachment.type === 'file') {
      const file = await readFileAttachment(attachment, workingDirectory, providerLabel);
      blocks.push({
        type: 'resource',
        resource: {
          uri: `file://${file.path}`,
          blob: file.data,
          mimeType: file.mimeType,
        },
      });
      continue;
    }

    throw new Error(`${providerLabel} ACP supports file, blob, and image attachments only.`);
  }
  blocks.push({ type: 'text', text: prompt });
  return blocks;
}

export function emitAcpToolUpdate(
  config: AgentSessionConfig,
  update: ToolCallUpdate,
  providerLabel: string,
): void {
  const kind = update.kind;
  const title = update.title ?? `${providerLabel} tool call`;
  const rawInput = update.rawInput;
  const rawOutput = update.rawOutput;
  const file = update.locations?.map(location => location.path).find(Boolean);
  const eventType = mapAcpToolKindToEventType(kind);
  const content = rawOutput !== undefined
    ? stringifyToolValue(rawOutput)
    : rawInput !== undefined
      ? `${title}: ${stringifyToolValue(rawInput)}`
      : title;

  emitAgentEvent(config, eventType, content, {
    command: kind === 'execute' ? extractCommand(rawInput) ?? title : title,
    file,
  });
}

export function emitAcpPlanUpdate(
  config: AgentSessionConfig,
  update: { entries?: Array<{ status?: string; content?: string }> },
): void {
  const entries = update.entries ?? [];
  const content = entries
    .map(entry => {
      const status = entry.status ?? 'pending';
      const text = entry.content ?? '';
      return text ? `${status}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
  if (content) emitAgentEvent(config, 'thinking', content);
}

function mapAcpToolKindToEventType(kind: ToolKind | null | undefined): AgentEventType {
  switch (kind) {
    case 'read':
    case 'search':
    case 'fetch':
      return 'file_read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write';
    case 'execute':
      return 'command';
    case 'think':
      return 'thinking';
    default:
      return 'tool_call';
  }
}

export function mapAcpToolKindToPermissionKind(kind: ToolKind | null | undefined): string {
  switch (kind) {
    case 'execute':
      return 'shell';
    case 'edit':
    case 'delete':
    case 'move':
      return 'write';
    case 'fetch':
      return 'url';
    case 'read':
    case 'search':
      return 'read';
    default:
      return kind ?? 'other';
  }
}

function extractCommand(input: unknown): string | undefined {
  return isObject(input)
    ? getStringProperty(input, 'command') ?? getStringProperty(input, 'cmd')
    : undefined;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getStringProperty(value: unknown, key: string): string | undefined {
  return isObject(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
