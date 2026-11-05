import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertReleaseOutputReady, cleanRelease, prepareReleaseOutput } from '../../scripts/clean-release.mjs';

test('packaging and cleanup leave a running unpacked app and sibling files intact', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-package-check-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'release', 'pkg');
  const directory = path.join(pkg, 'win-unpacked');
  const other = path.join(pkg, 'win-unpacked-archive');
  await Promise.all([directory, other].map(dir => fs.mkdir(dir, { recursive: true })));
  const isWindows = process.platform === 'win32';
  const program = path.join(directory, isWindows ? 'Minnow.exe' : 'Minnow');
  await fs.copyFile(isWindows ? process.env.ComSpec : '/bin/sleep', program);
  if (!isWindows) await fs.chmod(program, 0o755);
  const sibling = path.join(other, path.basename(program));
  await fs.copyFile(program, sibling);
  const start = (exe) => spawn(exe, isWindows ? ['/d', '/q'] : ['120'], { windowsHide: true, stdio: 'pipe' });
  const child = start(program);
  const unrelated = start(sibling);
  const children = [child, unrelated];
  try {
    await Promise.all(children.map(proc => once(proc, 'spawn')));
    assert.throws(() => assertReleaseOutputReady(root), /running from .*win-unpacked\. Close/);
    assert.throws(() => prepareReleaseOutput(root), /running from .*win-unpacked\. Close/);
    assert.throws(() => cleanRelease(root), /running from .*win-unpacked\. Close/);
    assert.equal(child.exitCode, null);
    assert.equal(unrelated.exitCode, null);
    const closed = once(child, 'close');
    child.kill();
    await closed;
    assert.doesNotThrow(() => assertReleaseOutputReady(root));
    await fs.access(program); // The read-only preflight leaves the previous output for the builder.
    prepareReleaseOutput(root);
    cleanRelease(root);
    await assert.rejects(fs.access(program), { code: 'ENOENT' });
    await fs.access(sibling);
    assert.equal(unrelated.exitCode, null);
  } finally {
    await Promise.all(children.filter(proc => proc.exitCode === null && proc.signalCode === null).map(async proc => {
      const closed = once(proc, 'close');
      proc.kill();
      await closed;
    }));
  }
});

test('cleanup refuses a release/pkg link into another directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-package-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'other', 'win-unpacked');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(root, 'release'));
  await fs.symlink(path.dirname(outside), path.join(root, 'release', 'pkg'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanRelease(root), /Expected a real release directory/);
  await fs.access(outside);
});
