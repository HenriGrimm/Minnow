/**
 * Symlink-safe workspace boundary checks (MIN-19).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  isResolvedPathUnderRoot,
  realpathForBoundaryCheck,
} from '../../server/workspace/safe-path.js';

describe('realpathForBoundaryCheck', () => {
  /** @type {string} */
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-safe-path-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('resolves existing files through realpath', async () => {
    const file = path.join(tmpDir, 'hello.txt');
    await fs.writeFile(file, 'ok');
    const real = realpathForBoundaryCheck(file);
    assert.equal(real, await fs.realpath(file));
  });

  test('walks up for missing leaf paths (create operations)', async () => {
    const missing = path.join(tmpDir, 'new', 'nested', 'file.txt');
    const real = realpathForBoundaryCheck(missing);
    const expectedParent = realpathForBoundaryCheck(path.join(tmpDir, 'new', 'nested'));
    assert.equal(real, path.join(expectedParent, 'file.txt'));
  });
});

describe('isResolvedPathUnderRoot', () => {
  /** @type {string} */
  let workspace;
  /** @type {string} */
  let outsideDir;

  before(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-safe-path-root-'));
    workspace = path.join(base, 'workspace');
    outsideDir = path.join(base, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'outside');
  });

  after(async () => {
    await fs.rm(path.dirname(workspace), { recursive: true, force: true });
  });

  test('allows normal paths under workspace', async () => {
    const inner = path.join(workspace, 'src', 'app.ts');
    await fs.mkdir(path.dirname(inner), { recursive: true });
    await fs.writeFile(inner, 'code');
    assert.equal(isResolvedPathUnderRoot(inner, workspace), true);
  });

  test('allows non-existent create paths under workspace', () => {
    const planned = path.join(workspace, 'new-dir', 'file.txt');
    assert.equal(isResolvedPathUnderRoot(planned, workspace), true);
  });

  test('blocks symlink that points outside workspace', async () => {
    const link = path.join(workspace, 'escape-link');
    await fs.symlink(path.join(outsideDir, 'secret.txt'), link);
    assert.equal(isResolvedPathUnderRoot(link, workspace), false);
  });

  test('blocks traversal that only passes string prefix check via symlink dir', async () => {
    const linkDir = path.join(workspace, 'outside-via-dir');
    await fs.symlink(outsideDir, linkDir);
    const viaLink = path.join(linkDir, 'secret.txt');
    assert.equal(isResolvedPathUnderRoot(viaLink, workspace), false);
  });

  test('rejects paths that resolve outside without symlinks', () => {
    const escaped = path.resolve(workspace, '..', 'outside', 'secret.txt');
    assert.equal(isResolvedPathUnderRoot(escaped, workspace), false);
  });
});
