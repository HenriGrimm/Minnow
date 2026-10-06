/**
 * LSP file URIs and spawn cwd follow the active workspace root, not the Minnow install dir.
 * Agent diagnostics honor per-request worktree overrides via pathAccessStore.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspDiagnostics, shutdownAllLsp } from '../../server/lsp/manager.js';
import { pathAccessStore } from '../../server/runtime/path-access.js';
import {
  resetDefaultWorkspaceRootForTests,
  setAppRoot,
  setWorkspaceRoot,
} from '../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('LSP workspace root', () => {
  let homeDir;
  let tempWorkspace;

  before(async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    setAppRoot(PROJECT_ROOT);
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-lsp-ws-'));
    const samplePath = path.join(tempWorkspace, 'sample.fake');
    await fs.writeFile(samplePath, 'let x = 1\n', 'utf8');

    homeDir = path.join(__dirname, '../fixtures/lsp-workspace-home');
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    invalidateLspConfigCache();
    shutdownAllLsp();
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(
      path.join(homeDir, 'lsp.json'),
      `${JSON.stringify(
        {
          enabled: true,
          lsp: {
            fake: {
              disabled: false,
              command: ['node', 'test/fixtures/fake-lsp.mjs'],
              extensions: ['.fake'],
            },
          },
        },
        null,
        2,
      )}\n`,
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

  test('diagnostics resolve files under the active workspace', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    const result = await getLspDiagnostics('sample.fake');
    assert.match(result, /';' expected/);
    assert.match(result, /fake/);
  });

  test('diagnostics resolve files under a worktree override', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') {
      return;
    }
    shutdownAllLsp();
    const result = await pathAccessStore.run(
      { workspaceRootOverride: tempWorkspace },
      () => getLspDiagnostics('sample.fake'),
    );
    assert.match(result, /';' expected/);
    assert.match(result, /fake/);
  });
});
