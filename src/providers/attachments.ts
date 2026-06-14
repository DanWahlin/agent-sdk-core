import { lstat, readFile, realpath } from 'fs/promises';
import { basename, extname } from 'path';
import type { AgentAttachment } from '../types/providers.js';
import { getSafeExtension, isAttachmentSizeValid, isPathWithinBoundary } from './validation.js';

const LOCAL_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function requireBase64ImageAttachment(
  attachment: AgentAttachment,
  providerLabel: string,
): { data: string; mediaType: string } {
  if (!attachment.data || !attachment.mediaType) {
    throw new Error(`${providerLabel} base64_image attachments require data and mediaType.`);
  }
  if (!getSafeExtension(attachment.mediaType)) {
    throw new Error(`${providerLabel} rejected unsupported image MIME type: ${attachment.mediaType}`);
  }
  if (!isAttachmentSizeValid(attachment.data)) {
    throw new Error(`${providerLabel} rejected oversized image attachment.`);
  }
  return { data: attachment.data, mediaType: attachment.mediaType };
}

export async function readLocalImageAttachment(
  attachment: AgentAttachment,
  workingDirectory: string,
  providerLabel: string,
): Promise<{ path: string; data: string; mimeType: string }> {
  if (!attachment.path) {
    throw new Error(`${providerLabel} local_image attachments require a path.`);
  }
  if (!isPathWithinBoundary(attachment.path, workingDirectory)) {
    throw new Error(`${providerLabel} blocked image attachment outside working directory: ${attachment.path}`);
  }
  const safePath = await resolveSafeAttachmentPath(attachment.path, workingDirectory, providerLabel, 'image');
  const mimeType = LOCAL_IMAGE_MIME_TYPES[extname(safePath).toLowerCase()];
  if (!mimeType) {
    throw new Error(`${providerLabel} rejected unsupported image attachment: ${attachment.path}`);
  }
  const data = (await readFile(safePath)).toString('base64');
  if (!isAttachmentSizeValid(data)) {
    throw new Error(`${providerLabel} rejected oversized image attachment.`);
  }
  return { path: safePath, data, mimeType };
}

export async function readFileAttachment(
  attachment: AgentAttachment,
  workingDirectory: string,
  providerLabel: string,
): Promise<{ path: string; data: string; mimeType: string; displayName: string }> {
  if (!attachment.path) {
    throw new Error(`${providerLabel} file attachments require a path.`);
  }
  if (!isPathWithinBoundary(attachment.path, workingDirectory)) {
    throw new Error(`${providerLabel} blocked file attachment outside working directory: ${attachment.path}`);
  }
  const safePath = await resolveSafeAttachmentPath(attachment.path, workingDirectory, providerLabel, 'file');
  const data = (await readFile(safePath)).toString('base64');
  if (!isAttachmentSizeValid(data)) {
    throw new Error(`${providerLabel} rejected oversized file attachment.`);
  }
  return {
    path: safePath,
    data,
    mimeType: attachment.mediaType ?? 'application/octet-stream',
    displayName: attachment.displayName ?? basename(attachment.path),
  };
}

export async function resolveSafeAttachmentPath(
  filePath: string,
  workingDirectory: string,
  providerLabel: string,
  attachmentKind: 'file' | 'image',
): Promise<string> {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${providerLabel} blocked ${attachmentKind} attachment symlink outside working directory: ${filePath}`);
  }

  const [realFilePath, realWorkingDirectory] = await Promise.all([
    realpath(filePath),
    realpath(workingDirectory),
  ]);
  if (!isPathWithinBoundary(realFilePath, realWorkingDirectory)) {
    throw new Error(`${providerLabel} blocked ${attachmentKind} attachment outside working directory: ${filePath}`);
  }
  return realFilePath;
}
export function requireBase64BlobAttachment(
  attachment: AgentAttachment,
  providerLabel: string,
): { data: string; mediaType: string; displayName: string } {
  if (!attachment.data || !attachment.mediaType) {
    throw new Error(`${providerLabel} base64_blob attachments require data and mediaType.`);
  }
  if (!isAttachmentSizeValid(attachment.data)) {
    throw new Error(`${providerLabel} rejected oversized blob attachment.`);
  }
  return {
    data: attachment.data,
    mediaType: attachment.mediaType,
    displayName: attachment.displayName ?? 'attachment',
  };
}
