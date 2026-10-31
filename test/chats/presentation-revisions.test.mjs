import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getSessionsDb, closeSessionsDb } from '../../server/config/sessions-db.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createConfigMiddleware } from '../../server/config/middleware.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatContext } from '../../server/chats/context.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatPresentation } from '../../server/chats/presentation.js';
import { createChatMiddleware } from '../../server/chats/middleware.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
import { readChatPresentationRevision, readChatPresentationRevisions } from '../../server/chats/presentation-revision.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-presentation-cas-')), prior = process.env.MINNOW_HOME;
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  process.env.MINNOW_HOME = path.join(root, 'home'); resetMinnowHomeCache();
  const db = getSessionsDb(), repository = createChatRepository({ db });
  repository.createChat({ id: 'managed', name: 'Managed', workspacePath: workspace, providerId: 'provider', modelId: 'model' });
  repository.createChat({ id: 'ordinary', name: 'Ordinary', workspacePath: workspace });
  // A legacy renderer-created root has no protected ownership marker.
  db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('ordinary');
  repository.ensureManagedChat('managed', { profile: { profileId: 'profile', profileVersion: 1, snapshot: { prompt: 'Private captured prompt' } } });
  const context = createChatContext({ repository, validateRoot: async () => {}, runGit: async () => ({ code: 1, stdout: '' }),
    resolvePolicyInput: async (_chat, _scope, registry) => ({ modeId: 'build', toolPermissions: {}, toolEffects: {},
      workspaceIds: registry.entries.map(row => row.workspaceId), capabilities: ['chat.read', 'chat.send', 'request.respond'] }) });
  const presentation = createChatPresentation({ repository }), service = createChatCommandService({ repository, context });
  const runtime = { repository, context, presentation, service };
  const chatMiddleware = createChatMiddleware({ getRuntime: () => runtime }), configMiddleware = createConfigMiddleware();
  const server = http.createServer((req, res) => {
    req.minnowAuth = { kind: 'host' };
    runWithViewWorkspace(workspace, () => chatMiddleware(req, res, () => configMiddleware(req, res, () => { res.statusCode = 404; res.end('{}'); })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  async function canonicalReply(id = 'execution') {
    const fence = repository.claimExecution({ chatId: 'managed', executionId: id, ownerId: 'host' });
    repository.appendMessage('managed', { role: 'assistant', content: 'Canonical reply ' + id }, { fence, messageId: 'message-' + id });
    repository.updateExecution(id, { status: 'completed' }, { fence }); repository.releaseLease('managed', fence);
    const cursor = repository.getActivity('managed').agentActivityCursor;
    assert.equal((await request('/api/chats/managed/ack', 'POST', cursor)).status, 200);
  }
  t.after(async () => {
    await service.dispose(); presentation.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); closeSessionsDb();
    if (prior === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = prior;
    resetMinnowHomeCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { db, repository, request, canonicalReply, counter: () => readChatPresentationRevision(db, 'managed') };
}
function patch(chat, revision = 0, extra = {}) {
  return { chats: [{ id: 'managed', name: 'Managed', groupId: '', ...chat }], chatBasePresentationRevisions: { managed: revision }, ...extra };
}

test('legacy approval admission, answer and expiry do not invalidate transcript and draft autosaves', async t => {
  const f = await fixture(t);
  let snapshot = (await f.request('/api/config/sessions')).body;
  const approval = id => ({ version: 1, requestId: id, chatId: 'ordinary', executionId: 'renderer-turn',
    toolCallId: id, kind: 'approval', state: 'pending', title: 'Allow tool?', presentation: {}, createdAt: 1000 });
  const save = async (text, method = 'PATCH') => {
    const chat = { ...snapshot.chats.find(chat => chat.id === 'ordinary'), composerDraft: text,
      history: [{ role: 'user', content: 'Delegating work' }, { role: 'assistant', content: text }] };
    const body = method === 'PATCH' ? { chats: [chat] } : { ...snapshot, chats: [chat] };
    const result = await f.request('/api/config/sessions', method, { ...body, chatBaseRevisions: snapshot.chatRevisions });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const saved = (await f.request('/api/config/sessions')).body;
    assert.equal(saved.chats.find(chat => chat.id === 'ordinary').composerDraft, text);
    assert.equal(f.repository.readTranscript('ordinary').messages.at(-1).content, text);
    assert.equal(f.repository.getChat('ordinary').chatCommandVersion, undefined);
    snapshot = saved;
  };
  f.repository.saveLegacyRequest(approval('pending-approval'), { assertOwner: () => true });
  const changed = (await f.request(`/api/config/sessions/summaries?sinceRevision=${snapshot.revision}`)).body;
  assert.ok(changed.chats.some(chat => chat.id === 'ordinary'), 'request changes remain visible to delta polling');
  await save('Unsent draft during approval');
  f.repository.respondToRequest('pending-approval', { answerCommandId: 'answer', answer: { decision: 'allow_once' } });
  await save('Draft after answer', 'PUT');
  f.repository.saveLegacyRequest(approval('expired-approval'), { assertOwner: () => true });
  f.repository.settleRequest('expired-approval', { state: 'expired' });
  await save('Draft after expiry');
  assert.equal(f.repository.getRequest('pending-approval').state, 'answered');
  assert.equal(f.repository.getRequest('expired-approval').state, 'expired');
});

test('request-only revision rebasing cannot bypass a competing save, deletion or managed takeover', async t => {
  const f = await fixture(t), before = (await f.request('/api/config/sessions')).body;
  const request = id => f.repository.saveLegacyRequest({ version: 1, requestId: id, chatId: 'ordinary', executionId: 'renderer-turn',
    toolCallId: id, kind: 'approval', state: 'pending', title: 'Allow?', presentation: {}, createdAt: 1000 }, { assertOwner: () => true });
  const stale = { chats: [{ id: 'ordinary', name: 'Stale', composerDraft: 'Must remain local' }], chatBaseRevisions: before.chatRevisions };
  request('first-request');
  const deletion = await f.request('/api/config/sessions', 'PATCH', { deleteChatIds: ['ordinary'], chatBaseRevisions: before.chatRevisions });
  assert.equal(deletion.status, 409, 'deletion still requires the exact observed revision');
  const winner = await f.request('/api/config/sessions', 'PATCH', { chats: [{ id: 'ordinary', name: 'Winner', composerDraft: 'Other draft' }], chatBaseRevisions: before.chatRevisions });
  assert.equal(winner.status, 200, JSON.stringify(winner.body));
  request('second-request');
  assert.equal((await f.request('/api/config/sessions', 'PATCH', stale)).status, 409);
  assert.equal(f.repository.getChat('ordinary').composerDraft, 'Other draft');
  const current = (await f.request('/api/config/sessions')).body;
  f.repository.ensureManagedChat('ordinary');
  assert.equal((await f.request('/api/config/sessions', 'PATCH', { ...stale, chatBaseRevisions: current.chatRevisions })).status, 409);
});

test('real HTTP ACK and canonical output do not invalidate a captured draft presentation revision', async t => {
  const f = await fixture(t), first = (await f.request('/api/config/sessions')).body;
  assert.equal(first.chatPresentationRevisions.managed, 0); assert.equal(first.chatPresentationRevisions.ordinary, undefined);
  await f.canonicalReply();
  const saved = await f.request('/api/config/sessions', 'PATCH', patch({ composerDraft: 'Keep this draft' }, 0,
    { baseRevision: first.revision, chatBaseRevisions: first.chatRevisions }));
  assert.equal(saved.status, 200); assert.equal(saved.body.chatPresentationRevisions.managed, 1);
  assert.equal(f.repository.getChat('managed').composerDraft, 'Keep this draft');
  assert.equal(f.repository.readTranscript('managed').messages[0].content, 'Canonical reply execution');
  const frame = await f.request('/api/chats/managed');
  assert.equal(frame.status, 200, JSON.stringify(frame.body));
  assert.equal(frame.body.frame.fields.agentPresentationRevision, 1);
  const summaries = (await f.request('/api/config/sessions/summaries')).body;
  assert.equal(summaries.chatPresentationRevisions.managed, 1);
  assert.equal(summaries.chats.find(chat => chat.id === 'managed').agentPresentationRevision, 1);
  const old = await f.request('/api/config/sessions', 'PATCH', { chats: [{ id: 'managed', name: 'Old writer' }], chatBaseRevisions: first.chatRevisions });
  assert.equal(old.status, 409); assert.equal(f.repository.getChat('managed').name, 'Managed');
});

test('two metadata writers and authoritative configuration share the same presentation fence', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', patch({ name: 'Window A', composerDraft: 'A' }))).status, 200);
  const stale = await f.request('/api/config/sessions', 'PATCH', patch({ name: 'Window B', composerDraft: 'B' }));
  assert.equal(stale.status, 409); assert.deepEqual(stale.body.conflictingChatIds, ['managed']);
  assert.deepEqual(stale.body.presentationConflict, { chatId: 'managed', expectedRevision: 0, currentRevision: 1 });
  assert.equal(stale.body.chatPresentationRevisions.managed, 1); assert.equal(f.repository.getChat('managed').composerDraft, 'A');
  f.repository.configureChat('managed', { name: 'Authoritative rename' });
  assert.equal(f.counter(), 2);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', patch({ composerDraft: 'Old snapshot' }, 1))).status, 409);
  assert.equal(f.repository.getChat('managed').name, 'Authoritative rename');
  f.repository.configureChat('managed', { name: 'Authoritative rename' }); assert.equal(f.counter(), 2);
  f.repository.configureChat('managed', { providerId: 'provider', modelId: 'new-model' }); assert.equal(f.counter(), 2);
});

test('mixed active-chat scalars require global rebase without changing the captured presentation base', async t => {
  const f = await fixture(t), first = (await f.request('/api/config/sessions')).body;
  await f.canonicalReply();
  const body = patch({ composerDraft: 'Draft and active selection' }, 0, { baseRevision: first.revision,
    chatBaseRevisions: first.chatRevisions, scalars: { activeId: 'managed' } });
  const conflict = await f.request('/api/config/sessions', 'PATCH', body); assert.equal(conflict.status, 409);
  assert.equal(conflict.body.presentationConflict, undefined); assert.equal(f.counter(), 0);
  const saved = await f.request('/api/config/sessions', 'PATCH', { ...body, baseRevision: conflict.body.revision });
  assert.equal(saved.status, 200); assert.equal(f.counter(), 1);
  const second = (await f.request('/api/config/sessions')).body;
  await f.canonicalReply('later');
  const pending = patch({ composerDraft: 'Never overwrite rename' }, 1, { baseRevision: second.revision, scalars: { activeId: 'ordinary' } });
  const rebase = await f.request('/api/config/sessions', 'PATCH', pending); assert.equal(rebase.status, 409);
  f.repository.configureChat('managed', { name: 'Changed by another window' });
  assert.equal((await f.request('/api/config/sessions', 'PATCH', { ...pending, baseRevision: (await f.request('/api/config/sessions')).body.revision })).status, 409);
  assert.equal(f.repository.getChat('managed').name, 'Changed by another window');
});

test('pin, unpin and clearing sent drafts use actual fields; no-op and transcript metadata leave the counter unchanged', async t => {
  const f = await fixture(t);
  const pin = patch({ pinnedAt: 1234, composerDraft: 'Draft' });
  assert.equal((await f.request('/api/config/sessions', 'PATCH', pin)).status, 200); assert.equal(f.counter(), 1);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', { ...pin, chatBasePresentationRevisions: { managed: 1 } })).status, 200); assert.equal(f.counter(), 1);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', patch({}, 1))).status, 200);
  let chat = f.repository.getChat('managed'); assert.equal(chat.pinnedAt, undefined); assert.equal(chat.composerDraft, undefined); assert.equal(f.counter(), 2);
  f.repository.configureChat('managed', { pinned: true }); chat = f.repository.getChat('managed');
  assert.ok(chat.pinnedAt > 0); assert.equal(chat.pinned, undefined); assert.equal(f.counter(), 3);
  f.repository.configureChat('managed', { pinned: true }); assert.equal(f.repository.getChat('managed').pinnedAt, chat.pinnedAt); assert.equal(f.counter(), 3);
  f.repository.configureChat('managed', { pinned: false }); assert.equal(f.counter(), 4); assert.equal(f.repository.getChat('managed').pinnedAt, undefined);
  const fence = f.repository.claimExecution({ chatId: 'managed', executionId: 'metadata', ownerId: 'host' });
  f.repository.setTranscriptMeta('managed', { reasoningEffort: 'high', todos: [] }, { fence }); assert.equal(f.counter(), 4);
  assert.throws(() => f.repository.setTranscriptMeta('managed', { presentationRevision: 0 }, { fence }), { code: 'invalid_request' });
  f.repository.updateExecution('metadata', { status: 'completed' }, { fence }); f.repository.releaseLease('managed', fence);
  for (const invalid of [-1, '123', null]) assert.equal((await f.request('/api/config/sessions', 'PATCH', patch({ pinnedAt: invalid }, 4))).status, 400);
});

test('presentation CAS is atomic, cannot forge authority, and never substitutes for deletion or ordinary-chat CAS', async t => {
  const f = await fixture(t), before = (await f.request('/api/config/sessions')).body;
  const forged = patch({ agentPresentationRevision: 999, presentationRevision: 999, providerId: 'evil', modelId: 'evil', modeId: 'build',
    contextDocumentsInjection: { secret: true }, history: [{ role: 'assistant', content: 'Forged history' }], profileReference: { profileId: 'evil', profileVersion: 1 } });
  assert.equal((await f.request('/api/config/sessions', 'PATCH', forged)).status, 200); assert.equal(f.counter(), 0);
  assert.equal(f.repository.getChat('managed').modelId, 'model'); assert.equal(f.repository.getLatestProfile('managed').snapshot.prompt, 'Private captured prompt');
  assert.deepEqual(f.repository.readTranscript('managed').messages, []); assert.equal(f.repository.readTranscript('managed').meta.contextDocumentsInjection, undefined);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', { chats: [{ id: 'ordinary', name: 'Forged counter' }], chatBasePresentationRevisions: { ordinary: 0 } })).status, 400);
  assert.equal((await f.request('/api/config/sessions', 'PATCH', { ...patch({}), chatBasePresentationRevisions: { managed: 999 } })).status, 409);
  await f.canonicalReply();
  const deletion = await f.request('/api/config/sessions', 'PATCH', { deleteChatIds: ['managed'], chatBaseRevisions: before.chatRevisions,
    chatBasePresentationRevisions: { managed: 0 } }); assert.equal(deletion.status, 409);
  const current = (await f.request('/api/config/sessions')).body;
  f.db.exec("CREATE TRIGGER fail_presentation_revision BEFORE UPDATE ON chat_revisions WHEN NEW.chat_id='managed' BEGIN SELECT RAISE(ABORT,'injected metadata rollback'); END");
  const failed = await f.request('/api/config/sessions', 'PATCH', patch({ name: 'Must roll back', composerDraft: 'No partial commit' }));
  assert.equal(failed.status, 500); assert.equal(f.counter(), 0); assert.equal(f.repository.getChat('managed').name, 'Managed');
  assert.equal((await f.request('/api/config/sessions')).body.revision, current.revision);
  f.db.exec('DROP TRIGGER fail_presentation_revision');
});

test('PUT echoes the committed presentation counter while preserving full-state global concurrency', async t => {
  const f = await fixture(t), initial = (await f.request('/api/config/sessions')).body;
  const body = { ...initial, chats: initial.chats.map(chat => chat.id === 'managed' ? { ...chat, composerDraft: 'PUT draft' } : chat),
    baseRevision: initial.revision, chatBaseRevisions: initial.chatRevisions, chatBasePresentationRevisions: initial.chatPresentationRevisions };
  const saved = await f.request('/api/config/sessions', 'PUT', body);
  assert.equal(saved.status, 200); assert.equal(saved.body.chatPresentationRevisions.managed, 1);
  assert.equal(f.repository.getChat('managed').composerDraft, 'PUT draft');
  assert.equal((await f.request('/api/config/sessions', 'PUT', body)).status, 409);
});

test('a newly discovered managed chat without a presentation base still requires its exact canonical revision', async t => {
  const f = await fixture(t);
  f.repository.createChat({ id: 'new-managed', name: 'New managed' });
  const first = (await f.request('/api/config/sessions')).body;
  const chats = [{ id: 'managed', name: 'Managed', composerDraft: 'A' }, { id: 'new-managed', name: 'New managed', composerDraft: 'B' }];
  const saved = await f.request('/api/config/sessions', 'PATCH', { chats, chatBaseRevisions: first.chatRevisions,
    chatBasePresentationRevisions: { managed: 0 } });
  assert.equal(saved.status, 200); assert.equal(saved.body.chatPresentationRevisions.managed, 1);
  assert.equal(saved.body.chatPresentationRevisions['new-managed'], 1);
  const current = (await f.request('/api/config/sessions')).body;
  const fence = f.repository.claimExecution({ chatId: 'new-managed', executionId: 'new-managed-output', ownerId: 'host' });
  f.repository.appendMessage('new-managed', { role: 'assistant', content: 'A newer canonical revision' }, { fence, messageId: 'new-output' });
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('new-managed', fence);
  const rejected = await f.request('/api/config/sessions', 'PATCH', { chats: chats.map(chat => ({ ...chat, composerDraft: 'Stale edit' })),
    chatBaseRevisions: current.chatRevisions, chatBasePresentationRevisions: { managed: 1 } });
  assert.equal(rejected.status, 409); assert.deepEqual(rejected.body.conflictingChatIds, ['new-managed']);
  assert.equal(f.repository.getChat('managed').composerDraft, 'A');
});

test('presentation receipts perform only unique keyed reads and preserve missing, null and unsafe-key semantics', async t => {
  const f = await fixture(t);
  f.repository.createChat({ id: '__proto__', name: 'Prototype-safe identity' });
  f.repository.createChat({ id: 'invalid-counter', name: 'Unrelated corrupted metadata' });
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.presentationRevision',?) WHERE chat_id=?").run(1.5, 'invalid-counter');
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.presentationRevision',NULL) WHERE chat_id=?").run('__proto__');
  const reads = []; let prepared = 0;
  const keyedDb = { prepare(sql) {
    prepared++;
    const statement = f.db.prepare(sql);
    return { get(chatId) { reads.push(chatId); return statement.get(chatId); } };
  } };
  assert.deepEqual(readChatPresentationRevisions(keyedDb, []), {}); assert.equal(prepared, 0);
  const receipt = readChatPresentationRevisions(keyedDb, ['managed', 'managed', 'ordinary', '__proto__']);
  assert.equal(prepared, 1); assert.deepEqual(reads, ['managed', 'ordinary', '__proto__']);
  assert.deepEqual(Object.keys(receipt), ['managed', '__proto__']);
  assert.equal(receipt.managed, 0); assert.equal(receipt.__proto__, 0);
  assert.equal(Object.getPrototypeOf(receipt), Object.prototype);
  assert.throws(() => readChatPresentationRevisions(keyedDb, ['invalid-counter']), { code: 'recovery_required' });
});


test('archive configuration is durable, projected and fenced against stale presentation saves', async t => {
  const f = await fixture(t);
  const originalHistory = f.repository.readTranscript('managed').messages;
  const archived = await f.request('/api/chats/managed/configuration', 'PATCH', {
    archived: true, expectedProfileVersion: 1, clientRequestId: 'archive-managed',
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const stamp = f.repository.getChat('managed').archivedAt;
  assert.ok(stamp > 0);
  assert.equal(f.counter(), 1);
  const frame = await f.request('/api/chats/managed');
  assert.equal(frame.body.frame.fields.archivedAt, stamp);
  const summaries = (await f.request('/api/config/sessions/summaries')).body;
  assert.equal(summaries.chats.find(chat => chat.id === 'managed').archivedAt, stamp);
  const stale = await f.request('/api/config/sessions', 'PATCH', patch({ composerDraft: 'Old view' }, 0));
  assert.equal(stale.status, 409);
  assert.equal(f.repository.getChat('managed').archivedAt, stamp);
  const preserved = await f.request('/api/config/sessions', 'PATCH', patch({ archivedAt: stamp, composerDraft: 'New view' }, 1));
  assert.equal(preserved.status, 200, JSON.stringify(preserved.body));
  assert.equal(f.repository.getChat('managed').archivedAt, stamp);
  const restored = await f.request('/api/chats/managed/configuration', 'PATCH', {
    archived: false, expectedProfileVersion: 1, clientRequestId: 'restore-managed',
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(f.repository.getChat('managed').archivedAt, undefined);
  assert.deepEqual(f.repository.readTranscript('managed').messages, originalHistory);
  const invalid = await f.request('/api/chats/managed/configuration', 'PATCH', {
    archived: 'yes', expectedProfileVersion: 1, clientRequestId: 'invalid-archive',
  });
  assert.equal(invalid.status, 400);
});
