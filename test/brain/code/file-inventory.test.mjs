import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { workspaceFileInventory, filterIndexableFiles } from '../../../server/brain/code/file-inventory.js';
import { getCodeDb, closeCodeDbForTests } from '../../../server/brain/code/schema.js';
import { brainWorkspaceKeyFromPath } from '../../../server/brain/paths.js';
import { resetMinnowHomeCache } from '../../../server/config/home.js';
import { DEFAULT_BRAIN_CODE_CONFIG } from '../../../server/brain/code/config.js';
import { listIndexableFiles } from '../../../server/brain/code/indexer.js';
import { handleCodeIndexRequest } from '../../../server/brain/code/routes.js';
import { runWithToolContext } from '../../../server/runtime/path-access.js';

let scratch;
const previousHome = process.env.MINNOW_HOME;
before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-file-inventory-'));
  process.env.MINNOW_HOME = path.join(scratch, 'home');
  resetMinnowHomeCache();
});
after(async () => {
  closeCodeDbForTests();
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(scratch, { recursive: true, force: true });
});

test('catalog includes non-code and hidden files, skips heavy folders, and is shared with indexing', async () => {
  const root = path.join(scratch, 'catalog');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/app.ts'), 'export const value = 1;');
  await fs.writeFile(path.join(root, 'README.md'), '# Project');
  await fs.writeFile(path.join(root, '.env.example'), 'EXAMPLE=1');
  await fs.writeFile(path.join(root, 'node_modules/large.js'), 'ignored');
  const files = await workspaceFileInventory(root);
  assert.deepEqual(files, ['.env.example', 'README.md', 'src/app.ts']);
  assert.deepEqual(filterIndexableFiles(files, DEFAULT_BRAIN_CODE_CONFIG.includeGlobs,
    DEFAULT_BRAIN_CODE_CONFIG.excludeGlobs), ['src/app.ts']);
  assert.deepEqual(await listIndexableFiles(root, DEFAULT_BRAIN_CODE_CONFIG.includeGlobs,
    DEFAULT_BRAIN_CODE_CONFIG.excludeGlobs), ['src/app.ts']);
  const db = getCodeDb(brainWorkspaceKeyFromPath(root));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspace_files').get().n, 3);
  // Still available from the persisted catalog after handles are closed.
  closeCodeDbForTests();
  await fs.rename(root, `${root}-moved`);
  assert.deepEqual(await workspaceFileInventory(root), files);
  await fs.rename(`${root}-moved`, root);
  await fs.unlink(path.join(root, 'README.md'));
  await fs.writeFile(path.join(root, 'new.json'), '{}');
  const refreshed = await workspaceFileInventory(root, { refresh: true });
  assert.equal(refreshed.includes('README.md'), false);
  assert.equal(refreshed.includes('new.json'), true);
});

test('equal folder names in different workspaces do not share file results', async () => {
  const a = path.join(scratch, 'a', 'same');
  const b = path.join(scratch, 'b', 'same');
  await fs.mkdir(a, { recursive: true });
  await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(a, 'a.txt'), 'a');
  await fs.writeFile(path.join(b, 'b.txt'), 'b');
  const results = await Promise.all([workspaceFileInventory(a), workspaceFileInventory(b)]);
  assert.deepEqual(results, [['a.txt'], ['b.txt']]);
  assert.deepEqual(await workspaceFileInventory(a), ['a.txt']);
  assert.deepEqual(await workspaceFileInventory(b), ['b.txt']);
});

test('file API scopes to a subtree and rejects escaping paths', async () => {
  const root = path.join(scratch, 'api');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/app.ts'), 'export {};');
  await fs.writeFile(path.join(root, 'README.md'), 'docs');
  async function request(query) {
    let payload;
    const response = { statusCode: 0, setHeader() {}, end(body) { payload = JSON.parse(body); } };
    await runWithToolContext(() => handleCodeIndexRequest(
      { method: 'GET', url: `/api/brain/code/files?${query}` }, response, '/api/brain/code/files',
    ), { workspaceRoot: root });
    return { status: response.statusCode, payload };
  }
  assert.deepEqual(await request('path=src'), { status: 200, payload: { files: ['src/app.ts'] } });
  assert.notEqual((await request('path=..')).status, 200);
});
