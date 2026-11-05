import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { getSessionsDb, closeSessionsDb } from '../../server/config/sessions-db.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createConfigMiddleware } from '../../server/config/middleware.js';
import { patchSessionState, readWholeSessionState } from '../../server/config/sessions-repo.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { setAgentConversationsCapabilityForTests } from '../../src/config/agent-conversations-enabled.ts';
import { applySharedChatAttention, findChatById, loadSessionsFromStorage, resetSessionPersistenceForTests,
  saveSessionsNow, setSessionStateForTests, touchChat, waitForSessionSaveForTests } from '../../src/state/sessions.ts';
import { persistComposerDraftOnChat } from '../../src/ui/composer-draft.ts';
import { resetSubAgentOrchestrator, setSubAgentApiFetchForTests, setSubAgentOpenStreamForTests, spawnSubAgent } from '../../src/agents/orchestrator.ts';
import { streamingChatIds } from '../../src/app-state.ts';

const PARENT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const realFetch = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage });

async function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-legacy-autosave-')), prior = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = root; resetMinnowHomeCache();
  const repository = createChatRepository({ db: getSessionsDb() });
  for (const id of [PARENT, OTHER]) {
    repository.createChat({ id, name: id === PARENT ? 'Parent' : 'Other', workspacePath: root, providerId: 'provider', modelId: 'model', modeId: 'build' });
    getSessionsDb().prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run(id);
  }
  patchSessionState({ scalars: { activeId: PARENT } });
  const middleware = createConfigMiddleware();
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  globalThis.fetch = (input, init) => realFetch(new URL(String(input), base), init);
  resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests('server');
  setAgentConversationsCapabilityForTests({ version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true, reason: 'development_opt_in' });
  setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
  sessionStorage.setItem(`minnow.chatTurnOwner.${PARENT}`, 'renderer-owner');
  t.after(async () => {
    resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests(null); streamingChatIds.clear();
    resetSubAgentOrchestrator(); setSubAgentApiFetchForTests(null); setSubAgentOpenStreamForTests(null);
    setAgentConversationsCapabilityForTests(); sessionStorage.clear(); globalThis.fetch = realFetch;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeSessionsDb();
    if (prior === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = prior;
    resetMinnowHomeCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  await loadSessionsFromStorage({ force: true });
  return { repository, parent: findChatById(PARENT)!, other: findChatById(OTHER)! };
}

test('approval updates during a renderer turn preserve mid-save drafts and allow the next delegation', async t => {
  const { repository, parent } = await fixture(t);
  streamingChatIds.add(PARENT);
  parent.history.push({ role: 'user', content: 'Delegate a review' });
  persistComposerDraftOnChat(parent, 'First unsent draft'); touchChat(parent);
  const request = repository.saveLegacyRequest({ version: 1, requestId: 'approval', chatId: PARENT,
    executionId: 'renderer-owner', toolCallId: 'tool-call', kind: 'approval', state: 'pending',
    title: 'Allow chat tool?', presentation: {}, createdAt: 1000 }, { assertOwner: () => true });
  applySharedChatAttention(PARENT, { agentRequestSummary: [{ requestId: request.requestId, kind: request.kind }] });
  const fetchServer = globalThis.fetch;
  let release!: () => void, received!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), committed = new Promise<void>(resolve => { received = resolve; });
  let held = false;
  globalThis.fetch = async (input, init) => {
    const response = await fetchServer(input, init);
    if (!held && init?.method === 'PATCH' && response.ok) { held = true; received(); await gate; }
    return response;
  };
  saveSessionsNow();
  await Promise.race([committed, waitForSessionSaveForTests().then(() => { assert.fail('the approval must permit autosave'); })]);
  persistComposerDraftOnChat(parent, 'New draft typed while the save was in flight'); touchChat(parent);
  release(); await waitForSessionSaveForTests();
  assert.equal(repository.getChat(PARENT).composerDraft, parent.composerDraft);
  repository.respondToRequest('approval', { answerCommandId: 'allow', answer: { decision: 'allow_once' } });
  parent.history.push({ role: 'assistant', content: 'Starting the review' }); touchChat(parent);
  let spawned = 0;
  setSubAgentApiFetchForTests(async (_url, init) => {
    if (init?.method === 'POST') {
      spawned++; assert.equal(repository.getChat(PARENT).composerDraft, parent.composerDraft);
      assert.equal(repository.readTranscript(PARENT)!.messages.at(-1).content, 'Starting the review');
    }
    return Response.json({ runId: 'review-run', status: 'queued' });
  });
  assert.equal((await spawnSubAgent({ type: 'explore', task: 'Review', parentChatId: PARENT })).status, 'queued');
  assert.equal(spawned, 1);
  assert.equal(parent.composerDraft, 'New draft typed while the save was in flight');
  assert.equal(repository.getChat(PARENT).chatCommandVersion, undefined);
  await loadSessionsFromStorage({ force: true });
  assert.equal(findChatById(PARENT)!.composerDraft, parent.composerDraft, 'the unsent draft survives reload');
});

test('delegation recovers competing drafts and starts only after its parent is saved', async t => {
  const { repository, parent, other } = await fixture(t);
  patchSessionState({ chats: [{ id: OTHER, name: 'Renamed elsewhere', composerDraft: 'Other window draft' }] });
  other.name = 'Local conflicting title'; other.composerDraft = 'Preserve unrelated unsent text'; touchChat(other);
  saveSessionsNow(); await waitForSessionSaveForTests();
  parent.history.push({ role: 'user', content: 'Delegate' }); parent.composerDraft = 'Parent draft'; touchChat(parent);
  const savedDraftsAtSpawn: string[] = [];
  setSubAgentApiFetchForTests(async (_url, init) => {
    if (init?.method === 'POST') savedDraftsAtSpawn.push(repository.getChat(PARENT).composerDraft);
    return Response.json({ runId: 'review-run', status: 'queued' });
  });
  await spawnSubAgent({ type: 'explore', task: 'Review', parentChatId: PARENT });
  assert.equal(repository.getChat(OTHER).composerDraft, 'Preserve unrelated unsent text');
  patchSessionState({ chats: [{ id: PARENT, name: 'Parent changed elsewhere', composerDraft: 'Competing parent draft' }] });
  parent.composerDraft = 'New local parent draft'; touchChat(parent);
  await spawnSubAgent({ type: 'explore', task: 'Another review', parentChatId: PARENT });
  const archivedDrafts = readWholeSessionState().chats.filter(chat => chat.archivedAt && chat.subAgentAutoResumeBlocked)
    .map(chat => chat.composerDraft).sort();
  assert.deepEqual(archivedDrafts, ['Competing parent draft', 'Other window draft']);
  assert.deepEqual(savedDraftsAtSpawn, ['Parent draft', 'New local parent draft']);

  const fetchServer = globalThis.fetch;
  globalThis.fetch = (url, init) => init?.method === 'PATCH'
    ? Promise.resolve(new Response(null, { status: 503 }))
    : fetchServer(url, init);
  parent.composerDraft = 'Still unsaved'; touchChat(parent);
  await assert.rejects(spawnSubAgent({ type: 'explore', task: 'Retry later', parentChatId: PARENT }), /Could not save the delegating conversation/);
  assert.equal(savedDraftsAtSpawn.length, 2);
  assert.equal(repository.getChat(PARENT).composerDraft, 'New local parent draft');
  assert.equal(parent.composerDraft, 'Still unsaved');
});
