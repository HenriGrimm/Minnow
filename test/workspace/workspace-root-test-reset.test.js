/**
 * MIN-47 — `resetDefaultWorkspaceRootForTests` must repoint the in-memory
 * workspace root without touching disk, unlike `setWorkspaceRoot` which
 * persists into config.json (and would otherwise clobber a developer's real
 * profile if called from a test teardown after MINNOW_HOME is restored).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.MINNOW_TEST = '1';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ws-reset-home-'));
process.env.MINNOW_HOME = tempHome;

const {
  getDefaultWorkspaceRoot,
  isWorkspaceUserChosen,
  resetDefaultWorkspaceRootForTests,
  setWorkspaceRoot,
} = await import('../../server/workspace/root.js');

let root;
let tmpA;
let tmpB;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ws-reset-'));
  tmpA = path.join(root, 'a');
  tmpB = path.join(root, 'b');
  await fs.mkdir(tmpA, { recursive: true });
  await fs.mkdir(tmpB, { recursive: true });
});

after(async () => {
  delete process.env.MINNOW_HOME;
  delete process.env.MINNOW_TEST;
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

describe('resetDefaultWorkspaceRootForTests', () => {
  test('repoints the process default without persisting to config.json', async () => {
    resetDefaultWorkspaceRootForTests(tmpA);
    assert.equal(getDefaultWorkspaceRoot(), path.resolve(tmpA));
    assert.equal(isWorkspaceUserChosen(), false);

    const configPath = path.join(tempHome, 'config.json');
    await assert.rejects(fs.access(configPath));

    await setWorkspaceRoot(tmpB);
    assert.equal(getDefaultWorkspaceRoot(), path.resolve(tmpB));
    await fs.access(configPath);
  });
});
