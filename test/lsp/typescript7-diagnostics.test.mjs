/** TypeScript 7 projects still need the bundled TS 5 tsserver for LSP. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspDiagnostics, shutdownAllLsp } from '../../server/lsp/manager.js';
import { setAppRoot, setWorkspaceRoot } from '../../server/workspace/root.js';

const APP_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('TypeScript 7 workspace diagnostics', () => {
  let home;
  let workspace;

  before(async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ts7-lsp-home-'));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ts7-lsp-workspace-'));
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    setAppRoot(APP_ROOT);
    await fs.writeFile(path.join(home, 'lsp.json'), JSON.stringify({ enabled: true, lsp: { typescript: { disabled: false } } }));
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'ts7-fixture', private: true }));
    await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'src', 'sample.ts'), 'export const count: number = "wrong";\n');
    const target = path.join(workspace, 'node_modules', 'typescript');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const source = path.join(APP_ROOT, 'node_modules', 'typescript');
    try {
      await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      await fs.cp(source, target, { recursive: true });
    }
    await setWorkspaceRoot(workspace);
  });

  after(async () => {
    shutdownAllLsp();
    await setWorkspaceRoot(APP_ROOT);
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    if (home) await fs.rm(home, { recursive: true, force: true });
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test('reports a type error instead of failing initialization', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;
    const result = await getLspDiagnostics('src/sample.ts');
    assert.match(result, /Type 'string' is not assignable to type 'number'/);
    assert.doesNotMatch(result, /Could not find a valid TypeScript installation/);
  });
});
