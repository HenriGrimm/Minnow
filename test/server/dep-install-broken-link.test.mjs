/**
 * refreshDependencies must never install *through* a dep link it failed to remove:
 * on Windows a live handle in node_modules leaves the junction in place, and the
 * install then writes into the main workspace's node_modules instead of the worktree.
 *
 * Module-mocked (registered under the `tsx-mocks` runner via test/server/**\/*.test.mjs)
 * because an unremovable link cannot be staged portably on a real filesystem.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { ECOSYSTEM_ENTRIES } from '../../server/worktree/dep-symlinks.js';
import { resolveUnixLoginShell } from '../../server/terminal/one-shot-spawn.js';

const DEP_SYMLINKS = '../../server/worktree/dep-symlinks.js';
const PROCESS_RUNNER = '../../server/process-runner.js';

/**
 * Fresh instance of dep-install per case: the module caches its `dep-symlinks`
 * bindings at link time, so a cached import would keep the previous test's mock.
 */
function loadDepInstall(tag) {
  return import(`../../server/worktree/dep-install.js?case=${tag}`);
}

async function makeNodeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-install-'));
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"dep-install-test"}\n', 'utf8');
  return root;
}

describe('refreshDependencies + unremovable dep link', () => {
  test('skips the install and reports why when materializeDepDirs fails', async (t) => {
    const spawned = [];
    t.mock.module(DEP_SYMLINKS, {
      namedExports: {
        ECOSYSTEM_ENTRIES,
        materializeDepDirs: async () => ({ removed: [], failed: ['node_modules'] }),
      },
    });
    t.mock.module(PROCESS_RUNNER, {
      namedExports: {
        runProcess: async (command, args, options) => {
          spawned.push({ command, args, shell: options.shell });
          return { code: 0, stdout: '', stderr: '' };
        },
        COMMAND_TIMEOUT_MS: 30_000,
        formatProcessOutput: () => '',
      },
    });

    const { refreshDependencies } = await loadDepInstall('unremovable');
    const root = await makeNodeProject();

    const res = await refreshDependencies(root, ['package.json']);

    assert.deepEqual(spawned, [], 'must not run the installer through a surviving link');
    assert.deepEqual(res.ran, []);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0], /node_modules/);
    assert.match(res.failed[0], /refusing to install through it/);

    await fs.rm(root, { recursive: true, force: true });
  });

  test('runs the install when the link was removed', async (t) => {
    const spawned = [];
    t.mock.module(DEP_SYMLINKS, {
      namedExports: {
        ECOSYSTEM_ENTRIES,
        materializeDepDirs: async () => ({ removed: ['node_modules'], failed: [] }),
      },
    });
    t.mock.module(PROCESS_RUNNER, {
      namedExports: {
        runProcess: async (command, args, options) => {
          spawned.push({ command, args, shell: options.shell });
          return { code: 0, stdout: '', stderr: '' };
        },
        COMMAND_TIMEOUT_MS: 30_000,
        formatProcessOutput: () => '',
      },
    });

    const { refreshDependencies } = await loadDepInstall('removed');
    const root = await makeNodeProject();

    const res = await refreshDependencies(root, ['package.json']);

    const login = resolveUnixLoginShell(process.platform);
    assert.deepEqual(spawned, [process.platform === 'win32'
      ? { command: 'npm', args: ['install'], shell: true }
      : { command: login.shell, args: [...login.loginArgs, '-c', 'exec "$@"', 'minnow-dep-install', 'npm', 'install'], shell: false }]);
    assert.deepEqual(res.ran, ['npm install']);
    assert.deepEqual(res.failed, []);

    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('refreshDependencies failure details', () => {
  for (const [name, result, expected] of [
    ['stderr', { code: 1, stderr: 'npm error ERESOLVE dependency conflict', stdout: '' }, /exit 1: npm error ERESOLVE/],
    ['stdout', { code: 2, stderr: '', stdout: 'install hook failed' }, /exit 2: install hook failed/],
    ['spawn', new Error('spawn npm ENOENT'), /spawn npm ENOENT/],
    ['timeout', new Error('Command timed out after 10s'), /timed out after 10s/],
    ['long-output', { code: 1, stderr: 'x'.repeat(5000) + 'failure at end', stdout: '' }, /failure at end/],
  ]) {
    test(`reports ${name} errors without losing the command`, async (t) => {
      t.mock.module(DEP_SYMLINKS, {
        namedExports: { ECOSYSTEM_ENTRIES, materializeDepDirs: async () => ({ removed: [], failed: [] }) },
      });
      t.mock.module(PROCESS_RUNNER, {
        namedExports: {
          runProcess: async () => { if (result instanceof Error) throw result; return result; },
          COMMAND_TIMEOUT_MS: 30_000,
          formatProcessOutput: () => '',
        },
      });
      const { refreshDependencies } = await loadDepInstall(name);
      const root = await makeNodeProject();
      try {
        const res = await refreshDependencies(root, ['package.json']);
        assert.deepEqual(res.ran, []);
        assert.equal(res.failed.length, 1);
        assert.match(res.failed[0], /^npm install /);
        assert.match(res.failed[0], expected);
        assert.ok(res.failed[0].length < 2100);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  test('unexpected setup errors fail closed', async (t) => {
    t.mock.module(DEP_SYMLINKS, {
      namedExports: {
        ECOSYSTEM_ENTRIES: [{ manifests: ['package.json'], resolveInstall: async () => { throw new Error('cannot read package manager'); } }],
        materializeDepDirs: async () => ({ removed: [], failed: [] }),
      },
    });
    const { refreshDependencies } = await loadDepInstall('unexpected');
    const root = await makeNodeProject();
    try {
      const res = await refreshDependencies(root, ['package.json']);
      assert.deepEqual(res.ran, []);
      assert.match(res.failed[0], /cannot read package manager/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
