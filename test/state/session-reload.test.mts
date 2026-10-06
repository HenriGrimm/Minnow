import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { streamingChatIds } from '../../src/app-state.ts';
import {
  createEmptyChatObject, ensureChatHistoryLoaded, loadSessionsFromStorage,
  prepareSessionsForReload, resetSessionPersistenceForTests, saveSessionsNow,
  scheduleSaveSessions, sessionState, setSessionStateForTests, touchChat,
  getSessionDirtyTrackingForTests, waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';
import type { Chat } from '../../src/types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  streamingChatIds.clear();
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  setStorageModeForTests('localStorage');
  globalThis.fetch = originalFetch;
});

test('reload saves oversized recent chats and edits during an in-flight save before hydration', async () => {
  setStorageModeForTests('server');
  const state = defaultSessionState();
  setSessionStateForTests(state);
  const recent = createEmptyChatObject('m', '/workspace');
  recent.history.push({ role: 'user', content: 'Recent request '.repeat(10_000) });
  state.chats.unshift(recent);
  state.activeId = recent.id;
  touchChat(recent);
  scheduleSaveSessions();
  streamingChatIds.add(recent.id);
  const disk = new Map<string, Chat>();
  let finishFirst!: () => void;
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (init?.method === 'PATCH' || init?.method === 'PUT') {
      writes++;
      assert.notEqual(init.keepalive, true, 'reload uses ordinary uncapped requests');
      const body = JSON.parse(String(init.body));
      if (writes === 1) {
        assert.ok(String(init.body).length > 65_536, 'reproduce a body too big for unload');
        await new Promise<void>((resolve) => { finishFirst = resolve; });
      }
      for (const chat of body.chats ?? []) disk.set(chat.id, chat);
      return Response.json({ ok: true, revision: writes });
    }
    if (url.includes('/history/')) {
      const id = url.split('/history/')[1]!.split('?')[0]!;
      return Response.json({ chatId: id, history: disk.get(id)?.history ?? [] });
    }
    return Response.json({ version: state.version, activeId: recent.id, revision: writes,
      chats: [...disk.values()].map(({ history, ...chat }) => ({ ...chat, messageCount: history.length })) });
  }) as typeof fetch;
  saveSessionsNow();
  const later = createEmptyChatObject('m', '/workspace');
  later.history.push({ role: 'user', content: 'Created while saving' });
  state.chats.unshift(later);
  touchChat(later);
  recent.history.push({ role: 'assistant', content: 'Newest reply' });
  touchChat(recent);
  let ready = false;
  const preparation = prepareSessionsForReload().then((saved) => { ready = true; return saved; });
  await Promise.resolve();
  assert.equal(ready, false, 'cannot reload while the first save is outstanding');
  finishFirst();
  assert.equal(await preparation, true);
  assert.equal(writes, 2, 'mid-flight edits require a follow-up acknowledged save');
  assert.equal(disk.get(recent.id)?.resumeInterrupted, true);
  await loadSessionsFromStorage({ force: true });
  await ensureChatHistoryLoaded(later.id);
  assert.equal(sessionState!.chats.find((chat) => chat.id === recent.id)?.history.at(-1)?.content, 'Newest reply');
  assert.equal(sessionState!.chats.find((chat) => chat.id === later.id)?.history[0]?.content, 'Created while saving');
});

test('reload bypasses save backoff but cancels if persistence still fails', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setStorageModeForTests('server');
  const state = defaultSessionState();
  setSessionStateForTests(state);
  touchChat(state.chats[0]!);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: 'offline' }, { status: 503 });
  };
  saveSessionsNow();
  await waitForSessionSaveForTests();
  assert.equal(requests, 1);
  assert.equal(await prepareSessionsForReload(), false);
  assert.equal(requests, 2, 'explicit reload retries immediately despite save backoff');
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [state.chats[0]!.id]);
});
