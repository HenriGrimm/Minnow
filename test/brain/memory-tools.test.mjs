/**
 * Project memory tools (memory_search / memory_read / memory_save / memory_forget)
 * through the server tool dispatcher, including every error path, plus the
 * remaining manage_brain confirmation gate.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { handleBrainRequest, initBrainApi } from '../../server/brain/routes.js';
import { shutdownAllLsp } from '../../server/lsp/manager.js';
import { createPage, readPage } from '../../server/brain/store.js';
import { clearMemoryProjectCache, resolveMemoryProject } from '../../server/brain/memory/scope.js';
import { listMemories } from '../../server/brain/memory/store.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const call = async (name, args, options) => (await executeServerTool(name, args, options)).result;
const idOf = text => text.match(/id: ([0-9a-f-]{36})/)?.[1];
const revisionOf = text => text.match(/revision: ([a-f0-9]{64})/)?.[1];

describe('memory tools', () => {
  let homeDir;
  let workspaceDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-tools-'));
    workspaceDir = path.join(homeDir, 'fixture-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: workspaceDir });
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await initBrainApi();
    const config = (await readConfigJson('config.json')) ?? {};
    config.memory = { ...(config.memory ?? {}), enabled: true, embeddings: { enabled: false } };
    config.brain = { ...(config.brain ?? {}), embeddings: { enabled: false } };
    await writeConfigJson('config.json', config);
    await setWorkspaceRoot(workspaceDir);
  });

  after(async () => {
    shutdownAllLsp();
    closeCodeDbForTests();
    closeSessionsDb();
    clearMemoryProjectCache();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('save, search, read and update round-trip in the project scope', async () => {
    const saved = await call('memory_save', {
      title: 'Release builds sign with the CI keychain',
      body: 'Local builds are unsigned; signing happens only in the release workflow.',
      kind: 'constraint',
      evidence: '.github/workflows/release.yml',
    }, { activityChatId: 'chat-123' });
    assert.match(saved, /^Saved project memory for fixture-workspace: "Release builds sign with the CI keychain"/);
    const id = idOf(saved);
    assert.ok(id);

    const search = await call('memory_search', { query: 'keychain signing' });
    assert.match(search, /1 matching memory/);
    assert.ok(search.includes(id));
    assert.match(search, /constraint · project/);

    const read = await call('memory_read', { id });
    assert.match(read, /^# Release builds sign with the CI keychain/);
    assert.match(read, /kind: constraint/);
    assert.match(read, /scope: project \(fixture-workspace\)/);
    assert.match(read, /evidence: \.github\/workflows\/release\.yml/);
    const revision = revisionOf(read);
    assert.ok(revision);

    const updated = await call('memory_save', {
      id, expectedRevision: revision,
      title: 'Release builds sign with the CI keychain',
      body: 'Only the release workflow signs builds; local builds stay unsigned.',
      kind: 'constraint',
    });
    assert.match(updated, /^Updated project memory/);
    const stale = await call('memory_save', {
      id, expectedRevision: revision, title: 'x', body: 'y', kind: 'constraint',
    });
    assert.match(stale, /^Error: Memory .* changed since you read it/);
    const missingRevision = await call('memory_save', { id, title: 'x', body: 'y', kind: 'constraint' });
    assert.match(missingRevision, /^Error: expectedRevision is required/);

    const rows = await listMemories({ project: await resolveMemoryProject(workspaceDir) });
    const stored = await readPage(rows.find(row => row.id === id).path);
    assert.equal(stored.meta.sourceChatId, 'chat-123');
  });

  it('refuses duplicates and names the existing memory', async () => {
    const out = await call('memory_save', {
      title: 'Release builds sign with the CI keychain', body: 'again', kind: 'constraint',
    });
    assert.match(out, /^Error: A project memory with this title already exists \(id [0-9a-f-]{36}\)/);
  });

  it('user scope memories are labelled and searchable', async () => {
    const out = await call('memory_save', {
      title: 'User wants answers before explanations', body: 'Lead with the answer.', kind: 'preference', scope: 'user',
    });
    assert.match(out, /^Saved user memory/);
    assert.match(await call('memory_search', { query: 'answers explanations', kind: 'preference' }), /preference · user/);
  });

  it('reports every validation error without writing', async () => {
    assert.match(await call('memory_search', {}), /^Error: query is required/);
    assert.match(await call('memory_search', { query: 'x', kind: 'todo' }), /^Error: kind must be one of/);
    assert.equal(await call('memory_search', { query: 'zqxj flurble' }), 'No matching memories.');
    assert.match(await call('memory_read', {}), /^Error: id is required/);
    assert.match(await call('memory_read', { id: '00000000-0000-4000-8000-000000000000' }), /^Error: No memory with id/);
    assert.match(await call('memory_save', { body: 'b', kind: 'gotcha' }), /^Error: title is required/);
    assert.match(await call('memory_save', { title: 't', kind: 'gotcha' }), /^Error: body is required/);
    assert.match(await call('memory_save', { title: 't', body: 'b', kind: 'note' }), /^Error: kind must be one of/);
    assert.match(await call('memory_save', { title: 't', body: 'b'.repeat(1201), kind: 'gotcha' }), /limit is 1200/);
    assert.match(await call('memory_save', { title: 't'.repeat(101), body: 'b', kind: 'gotcha' }), /limit is 100/);
    assert.match(await call('memory_save', { title: 't', body: 'b', kind: 'gotcha', evidence: 'e'.repeat(301) }), /limit is 300/);
    assert.match(await call('memory_save', { title: 'API', body: 'The password is hunter2', kind: 'gotcha' }), /credential/);
    assert.match(await call('memory_save', { title: 't', body: 'b', kind: 'gotcha', scope: 'team' }), /scope must be/);
    assert.match(await call('memory_save', { title: 't', body: 'b', kind: 'gotcha', expectedRevision: 'a'.repeat(64) }), /needs the id/);
    assert.match(await call('memory_save', { title: 't', body: 'b', kind: 'gotcha', supersedes: ['nope'] }), /unknown memory id/);
    assert.match(await call('memory_forget', { id: 'x' }), /^Error: reason is required/);
    assert.match(await call('memory_forget', { id: '00000000-0000-4000-8000-000000000000', reason: 'gone' }), /^Error: No memory with id/);
  });

  it('legacy wiki pages are never visible to memory tools', async () => {
    const legacy = await createPage({ relPath: 'facts/keychain-legacy.md', title: 'Keychain legacy', body: 'keychain keychain', skipVectorSync: true });
    assert.ok(!(await call('memory_search', { query: 'keychain legacy' })).includes(legacy.meta.id));
    assert.match(await call('memory_read', { id: legacy.meta.id }), /^Error: No memory with id/);
    assert.match(await call('memory_forget', { id: legacy.meta.id, reason: 'x' }), /^Error: No memory with id/);
    assert.equal((await readPage('facts/keychain-legacy.md')).meta.id, legacy.meta.id);
  });

  it('forget removes the memory from search', async () => {
    const saved = await call('memory_save', { title: 'Port 4100 is reserved for the mock API', body: 'Pin it.', kind: 'gotcha' });
    const id = idOf(saved);
    assert.match(await call('memory_forget', { id, reason: 'mock API removed' }), /^Forgot project memory "Port 4100 is reserved for the mock API".*Reason: mock API removed/);
    assert.equal(await call('memory_search', { query: 'mock API port 4100' }), 'No matching memories.');
  });

  it('the old wiki tools are no longer dispatched', async () => {
    for (const name of ['save_memory', 'brain_search', 'brain_read_page', 'brain_list', 'brain_write_page', 'brain_append_log', 'brain_ingest_source']) {
      assert.equal(await call(name, { query: 'x' }), `Not implemented: ${name}`);
    }
  });

  it('turning agent memory off disables every memory tool', async () => {
    const config = await readConfigJson('config.json');
    await writeConfigJson('config.json', { ...config, memory: { ...config.memory, enabled: false } });
    try {
      for (const [name, args] of [['memory_search', { query: 'x' }], ['memory_read', { id: 'x' }], ['memory_save', { title: 't', body: 'b', kind: 'gotcha' }], ['memory_forget', { id: 'x', reason: 'r' }]]) {
        assert.match(await call(name, args), /^Error: Agent memory is turned off/);
      }
    } finally {
      await writeConfigJson('config.json', config);
    }
  });

  it('manage_brain still requires confirmation for destructive actions', async () => {
    await createPage({ relPath: 'facts/confirm-test.md', title: 'Confirm test', body: 'temp', skipVectorSync: true });
    assert.match(await call('manage_brain', { action: 'clear_code_index' }), /requires confirmation/);
    assert.match(await call('manage_brain', { action: 'delete_page', path: 'facts/confirm-test.md', confirmed: 'true' }), /unknown action/);
    assert.equal((await readPage('facts/confirm-test.md')).body.trim(), 'temp');
  });

  it('Brain app routes list, edit and forget memories with revision checks', async () => {
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!(await handleBrainRequest(req, res, pathname))) { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const saved = await call('memory_save', { title: 'Docs deploy from the docs branch', body: 'Not main.', kind: 'decision' });
      const id = idOf(saved);
      const listing = await (await fetch(`${base}/api/brain/memories?workspaceRoot=${encodeURIComponent(workspaceDir)}`)).json();
      assert.equal(listing.project.label, 'fixture-workspace');
      assert.equal(listing.limits.projectCap, undefined);
      const row = listing.memories.find(memory => memory.id === id);
      assert.equal(row.scope, 'project');
      assert.ok(listing.memories.every(memory => memory.scope === 'project' || memory.scope === 'user'));

      const put = (body) => fetch(`${base}/api/brain/memories/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: workspaceDir, ...body }),
      });
      const edited = await put({ expectedRevision: row.revision, title: 'Docs deploy from the gh-pages branch', body: 'Not main or docs.', kind: 'decision' });
      assert.equal(edited.status, 200);
      const editedJson = await edited.json();
      assert.equal(editedJson.source, 'user');
      const stale = await put({ expectedRevision: row.revision, title: 'x', body: 'y', kind: 'decision' });
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, 'stale');
      assert.match(await call('memory_search', { query: 'gh-pages docs deploy' }), new RegExp(id));

      const wrongRevision = await fetch(`${base}/api/brain/memories/${id}?workspaceRoot=${encodeURIComponent(workspaceDir)}&expectedRevision=${row.revision}`, { method: 'DELETE' });
      assert.equal(wrongRevision.status, 409);
      const gone = await fetch(`${base}/api/brain/memories/${id}?workspaceRoot=${encodeURIComponent(workspaceDir)}&expectedRevision=${editedJson.revision}`, { method: 'DELETE' });
      assert.equal(gone.status, 200);
      assert.equal(await call('memory_search', { query: 'gh-pages docs deploy' }), 'No matching memories.');
      const missing = await fetch(`${base}/api/brain/memories/${id}?workspaceRoot=${encodeURIComponent(workspaceDir)}`, { method: 'DELETE' });
      assert.equal(missing.status, 404);

      const post = (body) => fetch(`${base}/api/brain/memories`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: workspaceDir, ...body }),
      });
      const added = await post({ scope: 'user', title: 'Prefer pnpm in new repos', body: 'Faster installs.', kind: 'preference' });
      assert.equal(added.status, 201);
      const addedJson = await added.json();
      assert.equal(addedJson.scope, 'user');
      assert.equal(addedJson.source, 'user');
      const duplicate = await post({ scope: 'user', title: 'Prefer pnpm in new repos', body: 'Faster installs.', kind: 'preference' });
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json()).conflictId, addedJson.id);
      const invalid = await post({ scope: 'project', title: '', body: 'x', kind: 'decision' });
      assert.equal(invalid.status, 400);
      await fetch(`${base}/api/brain/memories/${addedJson.id}?workspaceRoot=${encodeURIComponent(workspaceDir)}&expectedRevision=${addedJson.revision}`, { method: 'DELETE' });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
