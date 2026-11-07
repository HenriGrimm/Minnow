import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { patchSessions, putSessions, putSessionsKeepalive, flushSessionsOnShutdown } from '../../src/config/api-client.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import {
  buildSessionsPatchDelta, captureDirtyTrackingShadowForTests, createEmptyChatObject,
  getDirtyTrackingShadowSizeForTests, getSessionDirtyTrackingForTests,
  markGroupDeleted, markGroupDirty, markSessionScalarsDirty, removeChatById,
  resetSessionPersistenceForTests, saveSessionsNow, setDirtyTrackingVerifierForcedForTests,
  setSessionStateForTests, touchChat, waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';
import { longChatHistory } from '../fixtures/long-chat-history.mjs';
import type { Chat, ChatGroup } from '../../src/types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests('localStorage');
});
function fixture() {
  const state = defaultSessionState();
  state.chats = ['a', 'b', 'c'].map(id => ({ ...createEmptyChatObject('model'), id, name: id, updatedAt: 1 }));
  state.groups = ['a', 'b'].map(id => ({ id, name: id, sortOrder: 0 } as ChatGroup));
  state.activeId = 'a';
  setSessionStateForTests(state); setStorageModeForTests('server');
  return state;
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

test('managed metadata saves never read transcript/run bodies at 10/100/2500 messages', async t => {
  const observations = [];
  for (const count of [10, 100, 2500]) {
    const state = fixture(), chat = state.chats[0];
    chat.chatCommandVersion = 1;
    const history = longChatHistory(count);
    const historyBytes = Buffer.byteLength(JSON.stringify(history));
    let bodyReads = 0;
    for (const key of ['history', 'runs', 'subAgentRuns', 'tokenLedger', 'runnerTiming']) {
      Object.defineProperty(chat, key, { configurable: true, enumerable: true,
        get() { bodyReads++; throw new Error(`Save accessed canonical ${key}`); } });
    }
    const bodies: string[] = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(String(init?.body)); return Response.json({ ok: true, revision: bodies.length });
    };
    // Even DEV cannot serialize a long canonical body.
    setDirtyTrackingVerifierForcedForTests(true); captureDirtyTrackingShadowForTests();
    const times = [];
    for (let iteration = 0; iteration < 30; iteration++) {
      chat.composerDraft = 'Draft'; touchChat(chat); chat.updatedAt = 1;
      const start = performance.now(); saveSessionsNow();
      const synchronousMs = performance.now() - start;
      if (iteration >= 5) times.push(synchronousMs);
      await waitForSessionSaveForTests();
    }
    assert.equal(bodyReads, 0);
    const saved = JSON.parse(bodies[0]).chats[0];
    assert.deepEqual(Object.keys(saved).sort(), ['composerDraft', 'id', 'name', 'updatedAt']);
    assert.equal(saved.composerDraft, 'Draft');
    times.sort((a, b) => a - b);
    observations.push({ messages: count, historyBytes, saveBytes: Buffer.byteLength(bodies[0]),
      p50SynchronousMs: +times[12].toFixed(3), p95SynchronousMs: +times[23].toFixed(3) });
    resetSessionPersistenceForTests();
  }
  assert.equal(new Set(observations.map(row => row.saveBytes)).size, 1);
  t.diagnostic(JSON.stringify({ kind: 'synthetic-node-save-probe-not-renderer-profile', observations }));
});

test('production no-op saves do not capture diagnostic hashes, including legacy histories', async () => {
  const state = fixture();
  Object.defineProperty(state.chats[0], 'history', { get() { throw new Error('Production hashed history'); } });
  captureDirtyTrackingShadowForTests(); saveSessionsNow(); await waitForSessionSaveForTests();
  assert.equal(getDirtyTrackingShadowSizeForTests(), 0);
});

test('an in-flight save acknowledges A while new edits to B, groups and scalars stay dirty', async () => {
  const state = fixture(), blocked = gate(), bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) await blocked.promise;
    return Response.json({ ok: true, revision: bodies.length });
  };
  touchChat(state.chats[0]); markGroupDirty('a'); markSessionScalarsDirty();
  saveSessionsNow();
  state.chats[1].composerDraft = 'New B'; touchChat(state.chats[1]);
  markGroupDirty('b'); state.sidebarCollapsed = true; markSessionScalarsDirty();
  blocked.release(); await waitForSessionSaveForTests();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].chats.map((chat: Chat) => chat.id), ['b']);
  assert.deepEqual(bodies[1].groups.map((group: ChatGroup) => group.id), ['b']);
  assert.equal(bodies[1].scalars.sidebarCollapsed, true);
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
});

test('a same-entity edit or deletion during a save is not erased by its older receipt', async () => {
  const state = fixture(), blocked = gate(), bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) await blocked.promise;
    return Response.json({ ok: true, revision: bodies.length });
  };
  touchChat(state.chats[0]); touchChat(state.chats[1]); markGroupDirty('a');
  saveSessionsNow();
  state.chats[0].composerDraft = 'Edited in flight'; touchChat(state.chats[0]);
  removeChatById('b', 'model'); markGroupDeleted('a');
  blocked.release(); await waitForSessionSaveForTests();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].chats.map((chat: Chat) => chat.id), ['a']);
  assert.equal(bodies[1].chats[0].composerDraft, 'Edited in flight');
  assert.deepEqual(bodies[1].deleteChatIds, ['b']);
  assert.deepEqual(bodies[1].deleteGroupIds, ['a']);
  assert.equal(bodies[1].groups, undefined);
});

test('conflict rebasing retries a stable snapshot without reserializing legacy messages', async () => {
  const state = fixture(), chat = state.chats[0], blocked = gate(), bodies: any[] = [];
  let serializations = 0;
  chat.history = [{ role: 'user', content: 'Original', toJSON() {
    serializations++; return { role: 'user', content: this.content };
  } } as any];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) {
      await blocked.promise;
      return Response.json({ revision: 9 }, { status: 409 });
    }
    return Response.json({ ok: true, revision: 10 });
  };
  const saving = patchSessions({ baseVersion: 6, baseRevision: 8, chats: [chat], chatBaseRevisions: { a: 0 } });
  chat.history[0].content = 'New local edit'; blocked.release(); await saving;
  assert.equal(serializations, 1);
  assert.equal(bodies[1].chats[0].history[0].content, 'Original');
  assert.equal(bodies[1].baseRevision, 9);
});

test('direct API PUT/PATCH and shutdown fallbacks strip managed canonical fields', async () => {
  const state = fixture(), chat = state.chats[0];
  chat.chatCommandVersion = 1;
  Object.defineProperty(chat, 'history', { enumerable: true, get() { throw new Error('Read managed history'); } });
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
  };
  await patchSessions({ baseVersion: 6, chats: [chat] });
  await putSessions(state);
  assert.equal(putSessionsKeepalive(state), true);
  const delta = buildSessionsPatchDelta(state); delta.chats = [chat];
  assert.equal(flushSessionsOnShutdown(delta, state).clearedOk, true);
  for (const body of bodies) assert.equal('history' in body.chats[0], false);
});
