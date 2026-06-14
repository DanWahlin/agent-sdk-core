import { readFile } from 'fs/promises';
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
  const mimeType = LOCAL_IMAGE_MIME_TYPES[extname(attachment.path).toLowerCase()];
  if (!mimeType) {
    throw new Error(`${providerLabel} rejected unsupported image attachment: ${attachment.path}`);
  }
  const data = (await readFile(attachment.path)).toString('base64');
  if (!isAttachmentSizeValid(data)) {
    throw new Error(`${providerLabel} rejected oversized image attachment.`);
  }
  return { path: attachment.path, data, mimeType };
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
  const data = (await readFile(attachment.path)).toString('base64');
  if (!isAttachmentSizeValid(data)) {
    throw new Error(`${providerLabel} rejected oversized file attachment.`);
  }
  return {
    path: attachment.path,
    data,
    mimeType: attachment.mediaType ?? 'application/octet-stream',
    displayName: attachment.displayName ?? basename(attachment.path),
  };
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
