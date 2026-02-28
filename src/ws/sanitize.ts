/**
 * Sanitize parsed JSON to prevent prototype pollution.
 * Removes __proto__, constructor, and prototype keys recursively.
 *
 * Shared by both WS server (Node.js) and WS client (browser/Node.js).
 */
export function sanitizeJson(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeJson);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = sanitizeJson(value);
  }
  return clean;
}
