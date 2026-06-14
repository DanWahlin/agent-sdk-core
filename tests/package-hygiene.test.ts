import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';

const optionalPeerImports = [
  { file: 'src/providers/copilot.ts', module: '@github/copilot-sdk' },
  { file: 'src/providers/claude.ts', module: '@anthropic-ai/claude-agent-sdk' },
  { file: 'src/providers/codex.ts', module: '@openai/codex-sdk' },
  { file: 'src/providers/opencode.ts', module: '@opencode-ai/sdk' },
  { file: 'src/providers/openclaw-gateway.ts', module: 'ws' },
];

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function importStatements(source: string): string[] {
  const statements: string[] = [];
  let current: string[] | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (!current && line.startsWith('import ')) {
      current = [line];
      if (line.trim().endsWith(';')) {
        statements.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    if (current) {
      current.push(line);
      if (line.trim().endsWith(';')) {
        statements.push(current.join('\n'));
        current = null;
      }
    }
  }
  return statements;
}

function runtimeStaticImports(source: string, moduleName: string): string[] {
  return importStatements(source)
    .map(statement => statement.trim())
    .filter(statement => statement.includes(`from '${moduleName}'`) || statement.includes(`from "${moduleName}"`))
    .filter(statement => !statement.startsWith('import type '));
}

describe('package hygiene', () => {
  it('should not statically import optional peer dependency runtime modules from provider files', async () => {
    for (const { file, module } of optionalPeerImports) {
      const source = await readFile(file, 'utf8');
      assert.deepEqual(
        runtimeStaticImports(source, module),
        [],
        `${file} should lazy-load optional peer ${module} so root imports stay usable without every provider installed`,
      );
    }
  });

  it('should publish the built dist surface without shipping src internals', async () => {
    const pkg = await readJson('package.json');
    assert.deepEqual(pkg.files, ['dist']);
  });


  it('should expose provider and websocket option types from public barrels', async () => {
    const root = await import('../src/index.ts');
    const providers = await import('../src/providers/index.ts');
    const ws = await import('../src/ws/index.ts');

    assert.equal(typeof root.OpenClawProvider, 'function');
    assert.equal(typeof providers.OpenClawGatewayProvider, 'function');
    assert.equal(typeof ws.WSClient, 'function');
  });

  it('should keep type modules independent of the root barrel', async () => {
    const providers = await readFile('src/types/providers.ts', 'utf8');
    assert.equal(providers.includes('../index.js'), false);
  });
});
