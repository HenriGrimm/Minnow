import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { writeConfigJson } from '../../server/config/store.js';
import { handleBrainRequest } from '../../server/brain/routes.js';
import { brainWorkspaceKeyFromPath } from '../../server/brain/paths.js';
import { ensureBrainLayout, saveBrainConfig } from '../../server/brain/store.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { resolveRepoKey } from '../../server/brain/code/query.js';
import { codeDbPath, closeCodeDbForTests, getCodeDb } from '../../server/brain/code/schema.js';

let scratch, first, second, moved, server, url;
before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-identity-'));
  process.env.MINNOW_HOME = path.join(scratch, 'home');
  process.env.MINNOW_SESSIONS_STORE = 'json';
  resetMinnowHomeCache();
  [first, second, moved] = ['one', 'two', 'moved'].map(name => path.join(scratch, name, 'api'));
  for (const dir of [first, second]) await fs.mkdir(dir, { recursive: true });
  await ensureBrainLayout();
  await writeConfigJson('config.json', { workspace: { recentPaths: [first, second, moved] }, brain: { embeddings: { enabled: false } } });
  server = createServer((req, res) => handleBrainRequest(req, res, new URL(req.url, 'http://local').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeCodeDbForTests();
  closeSessionsDb();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
});

async function api(method, route, body) {
  const response = await fetch(url + '/api/brain/' + route, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

test('same-named checkouts, path aliases, and legacy indexes', async () => {
  const a = brainWorkspaceKeyFromPath(first);
  const b = brainWorkspaceKeyFromPath(second);
  assert.notEqual(a, b);
  assert.equal(await runWithToolContext(() => resolveRepoKey('api'), { workspaceRoot: second }), b);
  const alias = path.join(scratch, 'alias');
  await fs.symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(brainWorkspaceKeyFromPath(alias), a);
  if (process.platform === 'win32') assert.equal(brainWorkspaceKeyFromPath(first.toUpperCase()), a);
  getCodeDb('api').exec('CREATE TABLE legacy_only (marker TEXT)');
  for (const key of [a, b]) {
    assert.notEqual(codeDbPath(key), codeDbPath('api'));
    assert.equal(getCodeDb(key).prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_only'").get(), undefined);
  }
  getCodeDb(a).exec('CREATE TABLE only_in_first (marker TEXT)');
  assert.equal(getCodeDb(b).prepare("SELECT name FROM sqlite_master WHERE name = 'only_in_first'").get(), undefined);
});

test('caller-supplied code index keys cannot open or delete an adjacent database', async () => {
  await saveBrainConfig({ code: { enabled: true } });
  const outside = path.resolve(path.dirname(codeDbPath('api')), '../adjacent.db');
  await fs.writeFile(outside, 'preserve this database');
  for (const key of ['../adjacent', '..\\adjacent', outside.replace(/\.db$/, '')]) {
    assert.throws(() => getCodeDb(key), /Invalid code index workspace key/);
    const result = await api('POST', 'code/clear', { workspaceKey: key, confirmed: true });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.equal(await fs.readFile(outside, 'utf8'), 'preserve this database');
  }
});
