/**
 * Bundled typescript-language-server starts and accepts LSP initialize.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspCompletions, getLspCallHierarchy, getLspDocumentSymbols, getLspWorkspaceSymbols, shutdownAllLsp } from '../../server/lsp/manager.js';
import {
  resetDefaultWorkspaceRootForTests,
  setAppRoot,
  setWorkspaceRoot,
} from '../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('typescript LSP integration', () => {
  let homeDir;
  let tempWorkspace;

  before(async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    setAppRoot(PROJECT_ROOT);
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ts-lsp-'));
    await fs.writeFile(
      path.join(tempWorkspace, 'sample.ts'),
      'const greeting = "hi"\nconsole.\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tempWorkspace, 'symbols.ts'),
      'export function exportedHelper() { return 1; }\nexport const EXPORTED_CONST = 42;\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tempWorkspace, 'calls.ts'),
      [
        "import { exportedHelper } from './symbols';",
        'export function caller() {',
        '  exportedHelper();',
        '}',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(tempWorkspace, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'ESNext', target: 'ES2020' } }, null, 2),
      'utf8',
    );

    homeDir = path.join(__dirname, '../fixtures/lsp-typescript-home');
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    shutdownAllLsp();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, 'lsp.json'),
      `${JSON.stringify({ enabled: true, lsp: { typescript: { disabled: false } } }, null, 2)}\n`,
      'utf8',
    );
    await setWorkspaceRoot(tempWorkspace);
  });

  after(async () => {
    shutdownAllLsp();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    resetDefaultWorkspaceRootForTests(PROJECT_ROOT);
    if (tempWorkspace) {
      await fs.rm(tempWorkspace, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  });

  test('completion works without workspace-local typescript', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    const { items, error } = await getLspCompletions('sample.ts', 1, 8);
    assert.ifError(error ? new Error(error) : null);
    assert.ok(items.length > 0, 'expected completion items from bundled typescript');
  });

  test('documentSymbol returns exported function and constant', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    const { symbols, error } = await getLspDocumentSymbols('symbols.ts');
    assert.ifError(error ? new Error(error) : null);
    const fn = symbols.find((s) => s.name === 'exportedHelper');
    const constant = symbols.find((s) => s.name === 'EXPORTED_CONST');
    assert.ok(fn, 'expected exportedHelper symbol');
    assert.equal(fn.kind, 12);
    assert.ok(constant, 'expected EXPORTED_CONST symbol');
    assert.equal(constant.kind, 14);
  });

  test('workspace symbol search finds exported helper', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    const { symbols, error } = await getLspWorkspaceSymbols('exportedHelper');
    assert.ifError(error ? new Error(error) : null);
    const hit = symbols.find((s) => s.name === 'exportedHelper');
    assert.ok(hit, 'workspace search should find exportedHelper');
    assert.match(hit.path, /symbols\.ts$/);
  });

  test('call hierarchy reports outgoing call from caller', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    const { item, outgoingCalls, error } = await getLspCallHierarchy('calls.ts', 1, 16);
    assert.ifError(error ? new Error(error) : null);
    assert.ok(item, 'expected call hierarchy item at caller');
    assert.equal(item.name, 'caller');
    assert.ok(
      outgoingCalls.some((c) => c.to?.name === 'exportedHelper'),
      'caller should have outgoing call to exportedHelper',
    );
  });
});
