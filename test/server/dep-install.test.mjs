/**
 * Post-merge dependency refresh (manifest/lockfile triggered installs).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { refreshDependencies } from '../../server/worktree/dep-install.js';

/** Windows CI may still hold temp dir handles briefly after timed-out installs. */
const RM_OPTS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

describe('dep-install', () => {
  let tmpDir;

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, RM_OPTS);
    }
  });

  test('finds package tooling through the login shell with a GUI PATH', { skip: process.platform === 'win32' }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-login-'));
    const saved = Object.fromEntries(['PATH', 'SHELL', 'HOME', 'ZDOTDIR'].map(key => [key, process.env[key]]));
    try {
      const bin = path.join(root, 'bin');
      const project = path.join(root, 'project with spaces');
      await fs.mkdir(bin);
      await fs.mkdir(project);
      await fs.writeFile(path.join(project, 'package.json'), '{"name":"login-path-test"}');
      await fs.writeFile(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > installed.txt\n', { mode: 0o755 });
      const profile = `export PATH='${bin.replaceAll("'", "'\\''")}':/usr/bin:/bin\n`;
      await fs.writeFile(path.join(root, '.zprofile'), profile);
      await fs.writeFile(path.join(root, '.bash_profile'), profile);
      process.env.PATH = '/usr/bin:/bin';
      process.env.SHELL = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
      process.env.HOME = root;
      process.env.ZDOTDIR = root;
      const result = await refreshDependencies(project, ['package.json'], { timeout: 10_000 });
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.ran, ['npm install']);
      assert.equal(await fs.readFile(path.join(project, 'installed.txt'), 'utf8'), 'install\n');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await fs.rm(root, RM_OPTS);
    }
  });

  test('refreshDependencies runs node install when a manifest/lockfile changed', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-install-'));
    await fs.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'dep-install-test', version: '1.0.0', dependencies: {} }),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpDir, 'package-lock.json'),
      JSON.stringify({
        name: 'dep-install-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'dep-install-test', version: '1.0.0' } },
      }),
      'utf8',
    );

    const result = await refreshDependencies(tmpDir, ['package-lock.json'], { timeout: 120_000 });
    assert.ok(Array.isArray(result.ran));
    assert.ok(Array.isArray(result.failed));
    const attempted = [...result.ran, ...result.failed];
    assert.ok(attempted.some((cmd) => /^npm install/.test(cmd)), `expected npm install attempt, got ${attempted}`);
  });

  test('refreshDependencies skips install when only unrelated files changed', async () => {
    const result = await refreshDependencies(tmpDir, ['README.md'], { timeout: 5_000 });
    assert.deepEqual(result.ran, []);
    assert.deepEqual(result.failed, []);
  });

  test('refreshDependencies never throws when install tooling is unavailable', async () => {
    const isolated = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-install-missing-'));
    await fs.writeFile(path.join(isolated, 'go.mod'), 'module example.com/test\n\ngo 1.22\n', 'utf8');
    await fs.writeFile(path.join(isolated, 'go.sum'), '', 'utf8');

    const result = await refreshDependencies(isolated, ['go.sum'], { timeout: 5_000 });
    assert.ok(Array.isArray(result.ran));
    assert.ok(Array.isArray(result.failed));

    await fs.rm(isolated, RM_OPTS);
  });

  test('refreshDependencies materializes seed junction before install', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-dep-install-mat-'));
    const mainNm = path.join(root, 'main-nm');
    await fs.mkdir(mainNm, { recursive: true });
    await fs.writeFile(path.join(mainNm, 'keep.txt'), 'safe\n', 'utf8');

    const wt = path.join(root, 'wt');
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(
      path.join(wt, 'package.json'),
      JSON.stringify({ name: 'materialize-test', version: '1.0.0', dependencies: {} }),
      'utf8',
    );
    await fs.writeFile(
      path.join(wt, 'package-lock.json'),
      JSON.stringify({
        name: 'materialize-test',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'materialize-test', version: '1.0.0' } },
      }),
      'utf8',
    );

    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(mainNm, path.join(wt, 'node_modules'), symlinkType);

    await refreshDependencies(wt, ['package-lock.json'], { timeout: 120_000 });

    // Materialize removes the seed junction; install may or may not recreate node_modules.
    let stillJunction = false;
    try {
      const st = await fs.lstat(path.join(wt, 'node_modules'));
      stillJunction = st.isSymbolicLink();
    } catch {
      /* absent when install did not run or failed */
    }
    assert.equal(stillJunction, false, 'node_modules must not remain a junction after refresh');

    const keep = await fs.readFile(path.join(mainNm, 'keep.txt'), 'utf8');
    assert.equal(keep, 'safe\n');

    await fs.rm(root, RM_OPTS);
  });
});
