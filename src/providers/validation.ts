import { resolve } from 'path';

/** Maximum base64 attachment size (10MB encoded ≈ 7.5MB decoded) */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** Allowed image MIME types and their file extensions */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

/**
 * Validate that a resolved path is within a boundary directory.
 * Prevents path traversal attacks.
 */
export function isPathWithinBoundary(filePath: string, boundary: string): boolean {
  const resolvedPath = resolve(filePath);
  const resolvedBoundary = resolve(boundary);
  return resolvedPath === resolvedBoundary || resolvedPath.startsWith(resolvedBoundary + '/');
}

/**
 * Validate and sanitize a MIME type, returning the safe file extension.
 * Returns null if the MIME type is not in the whitelist.
 */
export function getSafeExtension(mediaType: string): string | null {
  const normalized = mediaType.toLowerCase().trim().split(';')[0];
  return ALLOWED_IMAGE_TYPES[normalized] ?? null;
}

/**
 * Validate attachment size. Returns true if within limits.
 */
export function isAttachmentSizeValid(base64Data: string): boolean {
  return base64Data.length <= MAX_ATTACHMENT_SIZE;
}

/**
 * Validate a config's working directory is an absolute path.
 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:\\/.test(p);
}
