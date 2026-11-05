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
