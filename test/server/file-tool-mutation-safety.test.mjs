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
