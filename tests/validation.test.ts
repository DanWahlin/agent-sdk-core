import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPathWithinBoundary, getSafeExtension, isAttachmentSizeValid, isAbsolutePath, MAX_ATTACHMENT_SIZE } from '../src/providers/validation.ts';

describe('isPathWithinBoundary', () => {
  it('should accept paths within boundary', () => {
    assert.equal(isPathWithinBoundary('/app/project/src/file.ts', '/app/project'), true);
    assert.equal(isPathWithinBoundary('/app/project', '/app/project'), true);
    assert.equal(isPathWithinBoundary('/app/project/deep/nested/file.ts', '/app/project'), true);
  });

  it('should reject paths outside boundary', () => {
    assert.equal(isPathWithinBoundary('/etc/passwd', '/app/project'), false);
    assert.equal(isPathWithinBoundary('/app/other-project/file.ts', '/app/project'), false);
  });

  it('should reject path traversal attacks', () => {
    assert.equal(isPathWithinBoundary('/app/project/../../etc/passwd', '/app/project'), false);
    assert.equal(isPathWithinBoundary('/app/project/../../../tmp/evil', '/app/project'), false);
    assert.equal(isPathWithinBoundary('/app/project/src/../../other/file', '/app/project'), false);
  });

  it('should handle tricky path prefixes', () => {
    // /app/project-evil should NOT be within /app/project
    assert.equal(isPathWithinBoundary('/app/project-evil/file.ts', '/app/project'), false);
  });
});

describe('getSafeExtension', () => {
  it('should accept valid image MIME types', () => {
    assert.equal(getSafeExtension('image/png'), 'png');
    assert.equal(getSafeExtension('image/jpeg'), 'jpg');
    assert.equal(getSafeExtension('image/gif'), 'gif');
    assert.equal(getSafeExtension('image/webp'), 'webp');
    assert.equal(getSafeExtension('image/svg+xml'), 'svg');
  });

  it('should reject non-image MIME types', () => {
    assert.equal(getSafeExtension('text/javascript'), null);
    assert.equal(getSafeExtension('application/json'), null);
    assert.equal(getSafeExtension('text/html'), null);
  });

  it('should reject path traversal in MIME types', () => {
    assert.equal(getSafeExtension('image/../../../tmp/evil'), null);
    // MIME params like "; path=..." are stripped — only the base type matters
    // image/png with extra params is still valid (we use whitelisted extension)
    assert.equal(getSafeExtension('image/png; path=../etc/passwd'), 'png');
  });

  it('should handle case insensitivity and whitespace', () => {
    assert.equal(getSafeExtension('IMAGE/PNG'), 'png');
    assert.equal(getSafeExtension(' image/jpeg '), 'jpg');
    assert.equal(getSafeExtension('image/png;charset=utf-8'), 'png');
  });

  it('should reject empty/malformed input', () => {
    assert.equal(getSafeExtension(''), null);
    assert.equal(getSafeExtension('notamimetype'), null);
  });
});

describe('isAttachmentSizeValid', () => {
  it('should accept small attachments', () => {
    assert.equal(isAttachmentSizeValid('abc123'), true);
    assert.equal(isAttachmentSizeValid(''), true);
  });

  it('should reject oversized attachments', () => {
    const huge = 'A'.repeat(MAX_ATTACHMENT_SIZE + 1);
    assert.equal(isAttachmentSizeValid(huge), false);
  });

  it('should accept attachments at exactly the limit', () => {
    const exact = 'A'.repeat(MAX_ATTACHMENT_SIZE);
    assert.equal(isAttachmentSizeValid(exact), true);
  });
});

describe('isAbsolutePath', () => {
  it('should accept absolute Unix paths', () => {
    assert.equal(isAbsolutePath('/app/project'), true);
    assert.equal(isAbsolutePath('/'), true);
  });

  it('should accept absolute Windows paths', () => {
    assert.equal(isAbsolutePath('C:\\Users\\project'), true);
    assert.equal(isAbsolutePath('D:\\'), true);
  });

  it('should reject relative paths', () => {
    assert.equal(isAbsolutePath('src/file.ts'), false);
    assert.equal(isAbsolutePath('../etc/passwd'), false);
    assert.equal(isAbsolutePath('./file'), false);
  });
});
