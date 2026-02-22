import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseError, formatDiagnostic } from '../src/providers/diagnostics.ts';

describe('diagnoseError', () => {
  it('should detect permission denied errors', () => {
    const result = diagnoseError('copilot', 'EACCES: permission denied', '/app/project');
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('permissions'));
    assert.ok(result.suggestion!.includes('/app/project'));
  });

  it('should detect write permission errors', () => {
    const result = diagnoseError('claude', "I don't have write permissions to the directory");
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('writable'));
  });

  it('should detect CLI not found errors', () => {
    const result = diagnoseError('codex', 'spawn codex ENOENT');
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('not found'));
    assert.ok(result.suggestion!.includes('codex'));
  });

  it('should detect auth errors', () => {
    const result = diagnoseError('copilot', 'Authentication token expired');
    assert.ok(result.suggestion);
    assert.ok(result.suggestion!.includes('logged in'));
  });

  it('should return no suggestion for unknown errors', () => {
    const result = diagnoseError('copilot', 'Something completely unexpected happened');
    assert.equal(result.suggestion, undefined);
  });

  it('should redact paths when redactPaths is true', () => {
    const result = diagnoseError('copilot', 'EACCES: permission denied', '/secret/path', { redactPaths: true });
    assert.ok(result.suggestion);
    assert.ok(!result.suggestion!.includes('/secret/path'));
    assert.ok(result.suggestion!.includes('<project-directory>'));
  });

  it('should show paths when redactPaths is false', () => {
    const result = diagnoseError('copilot', 'EACCES: permission denied', '/app/project', { redactPaths: false });
    assert.ok(result.suggestion!.includes('/app/project'));
  });
});

describe('formatDiagnostic', () => {
  it('should format with suggestion', () => {
    const formatted = formatDiagnostic({ message: 'error', suggestion: 'fix it' });
    assert.ok(formatted.includes('error'));
    assert.ok(formatted.includes('💡'));
    assert.ok(formatted.includes('fix it'));
  });

  it('should format without suggestion', () => {
    const formatted = formatDiagnostic({ message: 'just an error' });
    assert.equal(formatted, 'just an error');
  });
});
