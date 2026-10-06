/**
 * MIN-616 — get_lsp_diagnostics on vite.config.ts must pick up @types/node
 * and tsconfig.node.json instead of caching a stale "Cannot find name 'process'".
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { invalidateLspConfigCache } from '../../server/lsp/config-loader.js';
import { getLspDiagnostics, shutdownAllLsp } from '../../server/lsp/manager.js';
import {
  resetDefaultWorkspaceRootForTests,
  setAppRoot,
  setWorkspaceRoot,
} from '../../server/workspace/root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const TYPES_NODE = path.join(PROJECT_ROOT, 'node_modules/@types/node');
const TSC_BIN = path.join(PROJECT_ROOT, 'node_modules/typescript/bin/tsc');

const VITE_CONFIG = `export default {
  server: {
    port: Number(process.env.VITE_PORT) || 5173,
  },
};
`;

async function linkNodeTypes(workspaceRoot) {
  const dest = path.join(workspaceRoot, 'node_modules', '@types', 'node');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(TYPES_NODE, dest, linkType);
  } catch {
    // Junctions can fail on some Windows CI images; copy is slower but works.
    await fs.cp(TYPES_NODE, dest, { recursive: true });
  }
}

async function writeViteScaffold(root) {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'vite.config.ts'), VITE_CONFIG, 'utf8');
  await fs.writeFile(path.join(root, 'src', 'main.ts'), "export const app = 'ok';\n", 'utf8');
  await fs.writeFile(
    path.join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'tsconfig.app.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2020',
          lib: ['ES2020', 'DOM'],
          module: 'ESNext',
          skipLibCheck: true,
          moduleResolution: 'bundler',
          noEmit: true,
          strict: true,
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'tsconfig.node.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2023'],
          module: 'ESNext',
          types: ['node'],
          skipLibCheck: true,
          moduleResolution: 'bundler',
          noEmit: true,
          strict: true,
        },
        include: ['vite.config.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function runTsc(root, project) {
  const result = spawnSync(process.execPath, [TSC_BIN, '--noEmit', '-p', project], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('Vite config LSP diagnostics (MIN-616)', () => {
  let homeDir;
  let tempWorkspace;

  before(async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;
    setAppRoot(PROJECT_ROOT);
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-vite-lsp-'));
    await writeViteScaffold(tempWorkspace);

    homeDir = path.join(__dirname, '../fixtures/lsp-vite-config-home');
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

  test('clears stale process diagnostic after @types/node is installed', async () => {
    if (process.env.MINNOW_LSP_ENABLED === 'false') return;

    shutdownAllLsp();
    const before = await getLspDiagnostics('vite.config.ts');
    assert.match(before, /Cannot find name 'process'/);

    // Ground truth without Node types: tsc -p tsconfig.node.json fails (missing
    // @types/node, or `process` itself depending on the TypeScript version).
    const tscBefore = runTsc(tempWorkspace, 'tsconfig.node.json');
    assert.notEqual(tscBefore.status, 0);
    assert.match(
      tscBefore.out,
      /Cannot find (?:name 'process'|type definition file for 'node')/,
    );

    await linkNodeTypes(tempWorkspace);

    // Same vite.config.ts bytes — snapshot + tsserver must not keep the old error.
    const after = await getLspDiagnostics('vite.config.ts');
    assert.doesNotMatch(after, /Cannot find name 'process'/);
    assert.match(after, /No LSP diagnostics for vite\.config\.ts/);

    const tscAfter = runTsc(tempWorkspace, 'tsconfig.node.json');
    assert.equal(tscAfter.status, 0, tscAfter.out);
  });
});
