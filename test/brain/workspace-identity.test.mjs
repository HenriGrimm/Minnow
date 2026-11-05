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
import { brainWorkspaceKeyFromPath, resolvePagePath } from '../../server/brain/paths.js';
import { ensureBrainLayout, createPage, readPage } from '../../server/brain/store.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';
import { resolveRepoKey } from '../../server/brain/code/query.js';
import { codeDbPath, closeCodeDbForTests, getCodeDb } from '../../server/brain/code/schema.js';
import { resolveLegacyOwners } from '../../server/brain/workspace-ownership.js';
import { deleteChatArchive, reconcileOrphanArchives } from '../../server/brain/archive.js';

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

async function recalled(root, scope) {
  const { data, status } = await api('POST', 'retrieve', { workspaceRoot: root, query: 'topic', limit: 20, includeHits: true, scope });
  assert.equal(status, 200, JSON.stringify(data));
  return data.hits.map(hit => hit.path).sort();
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

test('existing home retains global pages and needs explicit ownership for handwritten pages', async () => {
  const a = brainWorkspaceKeyFromPath(first);
  const global = await createPage({ relPath: 'facts/common.md', body: 'topic common', title: 'topic common' });
  const legacy = await createPage({ relPath: 'workspaces/api/notes/topic.md', body: 'topic legacy', title: 'topic legacy' });
  const scoped = await createPage({ relPath: 'workspaces/' + a + '/notes/topic.md', title: 'topic new', body: 'topic new' });
  const abs = await resolvePagePath(legacy.path);
  const original = (await fs.readFile(abs, 'utf8')).replace('title:', '# hand edited\nextra: keep-me\ntitle:');
  await fs.writeFile(abs, original);

  const inventory = await api('GET', 'page?' + new URLSearchParams({ path: legacy.path, workspaceRoot: first }));
  assert.equal(inventory.data.workspace.ambiguous, true);
  assert.equal(inventory.data.workspace.ownerKey, null);
  assert.equal(await fs.readFile(abs, 'utf8'), original);
  assert.deepEqual(await recalled(second), [global.path]);
  assert.deepEqual(await recalled(first), [global.path, scoped.path].sort());

  const assign = { path: legacy.path, workspaceRoot: first, expectedRevision: inventory.data.revision };
  assert.equal((await api('PUT', 'workspace-assignment', assign)).status, 200);
  assert.equal((await api('PUT', 'workspace-assignment', { ...assign, workspaceRoot: second })).status, 409);
  assert.deepEqual(await recalled(first), [global.path, legacy.path, scoped.path].sort());
  assert.deepEqual(await recalled(second), [global.path]);
  assert.match(await fs.readFile(abs, 'utf8'), /# hand edited\nextra: keep-me/);
  assert.equal(await fs.readFile(abs + '.bak', 'utf8'), original);

  await fs.mkdir(path.dirname(moved), { recursive: true });
  await fs.rename(first, moved);
  assert.notEqual(brainWorkspaceKeyFromPath(moved), a);
  assert.deepEqual(await recalled(moved), [global.path]);
  const { revision } = await readPage(legacy.path);
  assert.equal((await api('PUT', 'workspace-assignment', { ...assign, workspaceRoot: moved, expectedRevision: revision })).status, 200);
  assert.deepEqual(await recalled(moved), [global.path, legacy.path].sort());
});

test('trusted chat evidence and reviewed archive assignments preserve physical paths', async () => {
  const chat = 'archived-chat';
  const legacy = await createPage({ relPath: 'workspaces/api/archive/' + chat + '/turns-0000-0001.md',
    source: 'archive', chatId: chat, sourceTurnIndices: [0, 1], title: 'topic archived', body: 'topic archived' });
  const summary = await createPage({ relPath: 'workspaces/api/summaries/chat-' + chat + '.md',
    chatId: chat, title: 'topic summary', body: 'topic summary' });
  await writeConfigJson('sessions/state.json', { version: 1, chats: [{ id: chat, name: 'Source', workspacePath: second, history: [] }] });
  assert.deepEqual(await reconcileOrphanArchives(new Set(['another-chat'])), { swept: 0 });
  const archiveScope = { chatId: chat };
  assert.deepEqual(await recalled(second, archiveScope), [legacy.path]);
  assert.deepEqual(await recalled(moved, archiveScope), []);
  assert.ok((await recalled(second)).includes(summary.path));
  assert.equal((await readPage(legacy.path)).meta.assignedWorkspace, undefined);
  const [unproven] = await resolveLegacyOwners([legacy.meta], () => path.join(scratch, 'different-name'));
  assert.equal(unproven.assignedWorkspace, undefined);
  const { data } = await api('PUT', 'workspace-assignment', { path: legacy.path, workspaceRoot: moved, expectedRevision: legacy.revision });
  assert.equal(data.meta.id, legacy.meta.id);
  assert.deepEqual(await recalled(second, archiveScope), []);
  assert.deepEqual(await recalled(moved, archiveScope), [legacy.path]);
  assert.equal((await deleteChatArchive(chat, brainWorkspaceKeyFromPath(second))).removed, 0);
  assert.equal((await readPage(legacy.path)).meta.id, legacy.meta.id);
  assert.equal((await deleteChatArchive(chat, brainWorkspaceKeyFromPath(moved))).removed, 1);
  assert.equal((await readPage(summary.path)).meta.id, summary.meta.id);
});
