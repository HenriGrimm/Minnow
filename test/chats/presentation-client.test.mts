import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { applySharedChatFrame, createEmptyChatObject, findChatById, getSessionDirtyTrackingForTests, loadSessionsFromStorage, resetSessionPersistenceForTests,
  saveSessionsNow, setSessionStateForTests, touchChat, waitForSessionSaveForTests } from '../../src/state/sessions.ts';

const originalFetch = globalThis.fetch;
const shellFields = { name: 'Saved title', groupId: null, pinnedAt: null, composerDraft: null };
afterEach(() => { globalThis.fetch = originalFetch; resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests(null); });

function setup() {
  const chat = createEmptyChatObject('model'); chat.id = 'managed'; chat.chatCommandVersion = 1;
  chat.name = 'Saved title'; chat.history = [{ role: 'user', content: 'Canonical input' }];
  setSessionStateForTests({ ...defaultSessionState(), chats: [chat], activeId: chat.id }); setStorageModeForTests('server');
  applySharedChatFrame(chat.id, { ...shellFields, agentPresentationRevision: 2 });
  return chat;
}

test('canonical frames and attention revisions preserve a dirty draft and use its independent metadata receipt', async () => {
  const chat = setup(), writes: any[] = [];
  chat.composerDraft = 'Unsent text'; touchChat(chat);
  applySharedChatFrame(chat.id, { name: 'Saved title', agentPresentationRevision: 2, unread: false,
    agentExecution: { executionId: 'execution', status: 'running' } }, { start: 1, length: 2, messages: [{ role: 'assistant', content: 'Committed output' }] });
  assert.equal(chat.composerDraft, 'Unsent text'); assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), '/api/config/sessions'); const body = JSON.parse(String(options?.body)); writes.push(body);
    return Response.json({ ok: true, revision: 42 + writes.length, chatPresentationRevisions: { managed: 2 + writes.length } });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
  assert.deepEqual(writes[0].chatBasePresentationRevisions, { managed: 2 });
  assert.equal(writes[0].chats[0].composerDraft, 'Unsent text');
  chat.composerDraft = 'Second edit'; touchChat(chat); saveSessionsNow(); await waitForSessionSaveForTests();
  assert.deepEqual(writes[1].chatBasePresentationRevisions, { managed: 3 });
  assert.equal(chat.history[1].content, 'Committed output');
});

test('another viewer metadata update never rebases a locally dirty draft onto the newer presentation counter', async () => {
  const chat = setup(); chat.name = 'Local title'; chat.composerDraft = 'Keep unsaved text'; touchChat(chat);
  applySharedChatFrame(chat.id, { name: 'Other viewer title', pinnedAt: 1000, agentPresentationRevision: 3 });
  assert.equal(chat.name, 'Local title'); assert.equal(chat.pinnedAt, undefined);
  let writes = 0;
  globalThis.fetch = async (_url, options) => {
    writes++; const body = JSON.parse(String(options?.body)); assert.equal(body.chatBasePresentationRevisions.managed, 2);
    return Response.json({ error: 'Presentation changed in another window', revision: 44, conflictingChatIds: ['managed'] }, { status: 409 });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
  assert.equal(writes, 1); assert.equal(chat.composerDraft, 'Keep unsaved text');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
});

test('a clean observer accepts a configured title and its matching metadata base before drafting', async () => {
  const chat = setup();
  applySharedChatFrame(chat.id, { ...shellFields, name: 'Renamed in another viewer', agentPresentationRevision: 3 });
  assert.equal(chat.name, 'Renamed in another viewer');
  chat.composerDraft = 'Draft after observing rename'; touchChat(chat);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.chatBasePresentationRevisions.managed, 3); assert.equal(body.chats[0].name, 'Renamed in another viewer');
    return Response.json({ ok: true, revision: 45, chatPresentationRevisions: { managed: 4 } });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
});

test('a new canonical child captures its metadata base only with complete shell fields', async () => {
  const chat = setup();
  applySharedChatFrame(chat.id, { agentPresentationRevision: 8, unread: true });
  chat.composerDraft = 'Draft'; touchChat(chat);
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).chatBasePresentationRevisions.managed, 2);
    return Response.json({ ok: true, revision: 45, chatPresentationRevisions: { managed: 3 } });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
});

test('a newer frame with another viewer draft cannot silently authorize overwriting that draft', async () => {
  const chat = setup(); chat.composerDraft = 'Previously saved local draft';
  applySharedChatFrame(chat.id, { ...shellFields, composerDraft: 'Other viewer draft', agentPresentationRevision: 3 });
  assert.equal(chat.composerDraft, 'Previously saved local draft');
  chat.composerDraft = 'Keep this unsaved revision'; touchChat(chat);
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).chatBasePresentationRevisions.managed, 2);
    return Response.json({ error: 'Presentation changed in another window', revision: 45, conflictingChatIds: ['managed'] }, { status: 409 });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
  assert.equal(chat.composerDraft, 'Keep this unsaved revision');
});

test('lazy boot retains the protected presentation counter independently of the newer canonical revision', async () => {
  const saved = setup(); resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests('server');
  const writes: any[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/sessions/history/')) return Response.json({ chatId: saved.id, history: saved.history });
    if (!options?.method || options.method === 'GET') return Response.json({ ...defaultSessionState(), revision: 99,
      activeId: saved.id, chats: [{ ...saved, messageCount: 1, history: undefined }],
      chatRevisions: { managed: 98 }, chatPresentationRevisions: { managed: 7 } });
    const body = JSON.parse(String(options.body)); writes.push(body);
    return Response.json({ ok: true, revision: 100, chatPresentationRevisions: { managed: 8 } });
  };
  await loadSessionsFromStorage({ force: true });
  const chat = findChatById(saved.id)!; chat.composerDraft = 'Persisted from boot'; touchChat(chat);
  saveSessionsNow(); await waitForSessionSaveForTests();
  assert.equal(writes.length, 1); assert.equal(writes[0].chatBaseRevisions.managed, 98);
  assert.equal(writes[0].chatBasePresentationRevisions.managed, 7);
});

test('the first managed wake frame preserves a raw parent metadata edit without borrowing a new base', async () => {
  const chat = createEmptyChatObject('model'); chat.id = 'raw-parent'; chat.name = 'Local renamed parent'; chat.composerDraft = 'Keep my unsent draft';
  setSessionStateForTests({ ...defaultSessionState(), chats: [chat], activeId: chat.id }); setStorageModeForTests('server'); touchChat(chat);
  applySharedChatFrame(chat.id, { ...shellFields, name: 'Server parent', chatCommandVersion: 1, agentPresentationRevision: 0 },
    { start: 0, length: 1, messages: [{ role: 'assistant', content: 'A child result arrived.' }] });
  assert.equal(chat.name, 'Local renamed parent'); assert.equal(chat.composerDraft, 'Keep my unsent draft');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(chat.id));
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body)); assert.equal(body.chatBasePresentationRevisions, undefined);
    assert.equal(body.chats[0].name, 'Local renamed parent');
    return Response.json({ ok: true, revision: 3, chatPresentationRevisions: { [chat.id]: 1 } });
  };
  saveSessionsNow(); await waitForSessionSaveForTests();
});
