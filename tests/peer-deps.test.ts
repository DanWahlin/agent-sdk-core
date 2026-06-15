import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { optionalPeerDependencyError } from '../src/providers/peer-deps.ts';

describe('optional peer dependency diagnostics', () => {
  it('should explain workspace-scoped peer dependency resolution failures', () => {
    const original = Object.assign(
      new Error("Cannot find package '@openai/codex-sdk' imported from /repo/node_modules/@codewithdan/agent-sdk-core/dist/providers/codex.js"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );

    const error = optionalPeerDependencyError('Codex', '@openai/codex-sdk', original);

    assert.match(error.message, /Codex provider requires optional peer dependency @openai\/codex-sdk/);
    assert.match(error.message, /not resolvable from @codewithdan\/agent-sdk-core/);
    assert.match(error.message, /same package\/workspace scope/);
    assert.match(error.message, /workspace root/);
    assert.match(error.message, /Original error:/);
  });

  it('should return the original Error for non-peer failures', () => {
    const original = new Error('authentication failed');
    const error = optionalPeerDependencyError('Copilot', '@github/copilot-sdk', original);
    assert.equal(error, original);
  });
});
