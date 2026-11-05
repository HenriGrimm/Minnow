import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { setTestHome, rmTestHome } from '../config/test-helpers.js';

let home;
let workspace;
before(async () => {
  home = setTestHome(process.env, 'minnow-file-mutation');
  workspace = path.join(home, 'project');
  await fs.mkdir(workspace, { recursive: true });
});
after(async () => { await rmTestHome(home); });

const call = (name, args) => executeServerTool(name, args, { workspaceRoot: workspace, filesystemAccessCeiling: 'workspace' });

test('exclusive file creation keeps the winning bytes across a collision', async () => {
  const name = 'new-file.txt';
  const create = content => call('save_file', { path: name, content, create_only: true });
  const values = ['first', 'second'];
  const results = await Promise.all(values.map(create));
  const winner = results.findIndex(r => !r.result.startsWith('Error:'));
  assert.notEqual(winner, -1);
  assert.match(results[1 - winner].result, /already exists/);
  assert.equal(await fs.readFile(path.join(workspace, name), 'utf8'), values[winner]);
  assert.match((await create('')).result, /already exists/);
  assert.doesNotMatch((await call('save_file', { path: name, content: 'updated' })).result, /^Error:/);
  assert.equal(await fs.readFile(path.join(workspace, name), 'utf8'), 'updated');
});

test('delete refuses the active root and its aliases while allowing a child directory', async () => {
  const marker = path.join(workspace, 'keep.txt');
  await fs.writeFile(marker, 'keep');
  await fs.mkdir(path.join(workspace, 'child'));
  const alias = path.join(workspace, 'alias');
  await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['.', 'child/..', 'alias']) {
    assert.match((await call('delete_path', { path: name })).result, /Cannot delete the workspace root/);
    assert.equal(await fs.readFile(marker, 'utf8'), 'keep');
  }
  assert.match((await call('list_directory', { path: '.' })).result, /keep.txt/);
  assert.doesNotMatch((await call('delete_path', { path: 'child' })).result, /^Error/);
  await assert.rejects(fs.stat(path.join(workspace, 'child')), { code: 'ENOENT' });
});

test('two simultaneous no-replace moves retain both input payloads', async () => {
  const names = ['move-a.txt', 'move-b.txt'];
  await Promise.all(names.map(name => fs.writeFile(path.join(workspace, name), name)));
  const dest = 'combined.txt';
  const results = await Promise.all(names.map(source => call('move_file', { source, destination: dest, no_replace: true })));
  const winner = results.findIndex(r => !r.result.startsWith('Error:'));
  assert.notEqual(winner, -1);
  const losingName = names[1 - winner];
  assert.match(results[1 - winner].result, /^Error:/);
  assert.equal(await fs.readFile(path.join(workspace, dest), 'utf8'), names[winner]);
  assert.equal(await fs.readFile(path.join(workspace, losingName), 'utf8'), losingName);
  assert.match((await call('copy_file', { source: losingName, destination: dest, no_replace: true })).result, /^Error:/);
  assert.equal(await fs.readFile(path.join(workspace, dest), 'utf8'), names[winner]);
});

test('exclusive directory move refuses an existing empty directory', async () => {
  for (const name of ['from-dir', 'to-dir']) await fs.mkdir(path.join(workspace, name));
  await fs.writeFile(path.join(workspace, 'from-dir', 'keep.txt'), 'data');
  const move = destination => call('move_file', { source: 'from-dir', destination, no_replace: true });
  assert.match((await move('to-dir')).result, /^Error:/);
  assert.doesNotMatch((await move('new-dir')).result, /^Error:/);
  assert.equal(await fs.readFile(path.join(workspace, 'new-dir', 'keep.txt'), 'utf8'), 'data');
});

test('exclusive cross-volume file move keeps its source if the copy fails', async t => {
  const source = path.join(workspace, 'cross-device.txt');
  await fs.writeFile(source, 'original');
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Cross-device'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); });
  assert.match((await call('move_file', { source, destination: 'other-volume.txt', no_replace: true })).result, /Disk full/);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
});

test('patch and replacement serialize the entire read-modify-write cycle', async t => {
  const name = 'parallel.txt';
  const target = path.join(workspace, name);
  await fs.writeFile(target, 'one\r\ntwo\r\n');
  const originalRead = fs.readFile.bind(fs);
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let reads = 0;
  t.mock.method(fs, 'readFile', async (file, ...options) => {
    const bytes = await originalRead(file, ...options);
    if (file === target && ++reads === 1) {
      first.resolve();
      // Without a shared lock the second operation reads the same old bytes.
      await Promise.race([second.promise, new Promise(resolve => setTimeout(resolve, 500))]);
    } else if (file === target) {
      second.resolve();
    }
    return bytes;
  });
  const replace = (before, after) => call('replace_text_in_file', {
    path: name, search: before, replace: after, expected_count: 1,
  });
  const saving = replace('one', 'first');
  await first.promise;
  const patch = '*** Begin Patch\n*** Update File: parallel.txt\n@@\n-two\n+second\n*** End Patch';
  const changed = await Promise.all([saving, call('apply_patch', { patch })]);
  assert.ok(changed.every(row => !row.result.startsWith('Error:')));
  assert.equal(await originalRead(target, 'utf8'), 'first\r\nsecond\r\n');
  const overlap = await Promise.all([replace('first', 'A'), replace('first', 'B')]);
  assert.equal(overlap.filter(row => row.result.startsWith('Replaced 1 occurrence')).length, 1);
  assert.match(await originalRead(target, 'utf8'), /^[AB]\r\nsecond\r\n$/);
});
