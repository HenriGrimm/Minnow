/**
 * Phase B.1/B.2: dirty-tracking + PATCH flush once dirty sets are trusted.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  captureDirtyTrackingShadowForTests,
  getDirtyTrackingShadowSizeForTests,
  getSessionDirtyTrackingForTests,
  removeChatById,
  resetSessionPersistenceForTests,
  saveSessionsNow,
  setDirtyTrackingVerifierForcedForTests,
  setSessionPatchDirtySetsReadyForTests,
  setSessionStateForTests,
  setSidebarCollapsed,
  touchChat,
  waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';
import type { Chat, SessionState } from '../../src/types.ts';

const CHAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function baseState(): SessionState {
  const state = defaultSessionState();
  state.chats = [
    {
      id: CHAT_A,
      name: 'Chat A',
      workspacePath: '',
      modelId: 'm',
      modeId: 'build',
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
      lastMessageAt: 1,
    },
    {
      id: CHAT_B,
      name: 'Chat B',
      workspacePath: '',
      modelId: 'm',
      modeId: 'build',
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
      lastMessageAt: 1,
    },
  ];
  state.activeId = CHAT_A;
  return state;
}

describe('session dirty tracking (B.1/B.2)', () => {
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.fetch;
    setStorageModeForTests('localStorage');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
  });

  test('touchChat marks dirtyChatIds', () => {
    const state = baseState();
    setSessionStateForTests(state);
    const chat = state.chats[0] as Chat;
    touchChat(chat);
    const dirty = getSessionDirtyTrackingForTests();
    assert.deepEqual(dirty.dirtyChatIds, [CHAT_A]);
    assert.equal(dirty.sessionScalarsDirty, false);
  });

  test('flush PATCHes dirty chats/scalars and clears dirty sets after success', async () => {
    setStorageModeForTests('server');
    const state = baseState();
    setSessionStateForTests(state);

    let patchBodies: unknown[] = [];
    let putCount = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
      }
      if (url.includes('/api/config/sessions') && init?.method === 'PUT') {
        putCount += 1;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    touchChat(state.chats[0] as Chat);
    setSidebarCollapsed(true);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [CHAT_A]);
    assert.equal(getSessionDirtyTrackingForTests().sessionScalarsDirty, true);

    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(putCount, 0);
    assert.equal(patchBodies.length, 1);
    const body = patchBodies[0] as {
      chats?: Chat[];
      scalars?: { sidebarCollapsed?: boolean };
    };
    assert.equal(body.chats?.length, 1);
    assert.equal(body.chats?.[0]?.id, CHAT_A);
    assert.equal(body.scalars?.sidebarCollapsed, true);
    assert.deepEqual(getSessionDirtyTrackingForTests(), {
      dirtyChatIds: [],
      deletedChatIds: [],
      dirtyGroupIds: [],
      deletedGroupIds: [],
      sessionScalarsDirty: false,
      sessionPatchDirtySetsReady: true,
      sessionsClientPatchEnabled: true,
    });
  });

  test('the whole-state PATCH fallback omits history for chats nothing touched (MIN-794)', async () => {
    setStorageModeForTests('server');
    const state = baseState();
    (state.chats[0] as Chat).history = [{ role: 'user', content: 'edited' }];
    (state.chats[1] as Chat).history = [{ role: 'user', content: 'x'.repeat(1000) }];
    // A chat still on its lazy placeholder is what forces the fallback.
    state.chats.push({
      ...(state.chats[1] as Chat),
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      history: [],
      historyLoaded: false,
    } as Chat);
    setSessionStateForTests(state);
    // First save after load: the baseline is untrusted, so a PUT would be unsafe.
    setSessionPatchDirtySetsReadyForTests(false);

    const patchBodies: Array<{ chats?: Chat[] }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    touchChat(state.chats[0] as Chat);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(patchBodies.length, 1);
    const chats = patchBodies[0]?.chats ?? [];
    assert.equal(chats.length, 3, 'the fallback still describes the whole session');
    const edited = chats.find((c) => c.id === CHAT_A);
    const untouched = chats.find((c) => c.id === CHAT_B);
    assert.deepEqual(edited?.history, [{ role: 'user', content: 'edited' }]);
    // Omitted history means "preserve" server-side — this is the 60.4 MB PATCH.
    assert.equal('history' in (untouched as object), false);
  });

  test('removeChatById records deletedChatIds', () => {
    const state = baseState();
    setSessionStateForTests(state);
    removeChatById(CHAT_B, 'm');
    const dirty = getSessionDirtyTrackingForTests();
    assert.deepEqual(dirty.deletedChatIds, [CHAT_B]);
  });

  test('removeChatById purges stale remembered workspace and app ids', () => {
    const state = baseState();
    state.lastActiveChatIdByWorkspace = { '': CHAT_B };
    state.lastActiveChatIdByApp = { code: CHAT_B };
    setSessionStateForTests(state);
    removeChatById(CHAT_B, 'm');
    assert.equal(state.lastActiveChatIdByWorkspace[''], undefined);
    assert.equal(state.lastActiveChatIdByApp.code, undefined);
    assert.equal(getSessionDirtyTrackingForTests().sessionScalarsDirty, true);
  });

  test('removeChatById retargets remembered ids when the active chat is deleted', () => {
    const state = baseState();
    state.chats[0]!.history = [{ role: 'user', content: 'hello' }];
    state.chats[1]!.history = [{ role: 'user', content: 'bye' }];
    state.activeId = CHAT_B;
    state.lastActiveChatIdByWorkspace = { '': CHAT_B };
    state.lastActiveChatIdByApp = { code: CHAT_B };
    setSessionStateForTests(state);
    const result = removeChatById(CHAT_B, 'm');
    assert.equal(result.ok, true);
    assert.equal(result.activeChanged, true);
    assert.equal(state.activeId, CHAT_A);
    assert.equal(state.lastActiveChatIdByWorkspace[''], CHAT_A);
    assert.equal(state.lastActiveChatIdByApp.code, CHAT_A);
  });

  test('removeChatById switches to another unassigned chat when active is deleted', () => {
    const state = baseState();
    state.chats[0]!.history = [{ role: 'user', content: 'hello' }];
    state.chats[1]!.history = [{ role: 'user', content: 'bye' }];
    state.activeId = CHAT_B;
    setSessionStateForTests(state);
    const result = removeChatById(CHAT_B, 'm');
    assert.equal(result.ok, true);
    assert.equal(result.activeChanged, true);
    assert.equal(state.activeId, CHAT_A);
    assert.equal(state.chats.some((c) => c.id === CHAT_B), false);
  });

  test('verifier warns when a chat mutates without touchChat', () => {
    const state = baseState();
    setSessionStateForTests(state);
    setDirtyTrackingVerifierForcedForTests(true);
    captureDirtyTrackingShadowForTests();

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      // Unmarked mutation — bypasses touchChat on purpose.
      state.chats[0]!.name = 'mutated without touch';
      saveSessionsNow();
    } finally {
      console.warn = originalWarn;
    }

    assert.ok(
      warnings.some((w) => w.includes(CHAT_A) && w.includes('without touchChat')),
      `expected verifier warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  test('verifier stays quiet when mutation goes through touchChat', async () => {
    setStorageModeForTests('server');
    const state = baseState();
    setSessionStateForTests(state);
    setDirtyTrackingVerifierForcedForTests(true);
    captureDirtyTrackingShadowForTests();

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const chat = state.chats[0] as Chat;
      chat.name = 'renamed via touch';
      touchChat(chat);
      saveSessionsNow();
      await waitForSessionSaveForTests();
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 0);
  });

  test('an unmarked mutation is repaired so it still reaches the server (MIN-794)', async () => {
    setStorageModeForTests('server');
    setDirtyTrackingVerifierForcedForTests(true);
    const state = baseState();
    setSessionStateForTests(state);
    captureDirtyTrackingShadowForTests();

    const patchBodies: Array<{ chats?: Chat[] }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init.body)));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Bypasses touchChat on purpose. The development diagnostic repairs this miss;
    // production deliberately does not serialize chats to find unmarked edits.
    (state.chats[0] as Chat).name = 'mutated without touch';
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(patchBodies.length, 1);
    const sent = patchBodies[0]?.chats ?? [];
    assert.deepEqual(sent.map((c) => c.id), [CHAT_A]);
    assert.equal(sent[0]?.name, 'mutated without touch');
  });

  test('the verifier samples a window instead of every chat ever created (MIN-794)', () => {
    const state = baseState();
    // 556 chats is the real store this was profiled against; serializing all of them on
    // every save is what blocked the main thread for ~1.2 s per switch.
    state.chats = Array.from({ length: 300 }, (_, i) => {
      const chat = { ...(state.chats[0] as Chat) } as Chat;
      chat.id = `chat-${i}`;
      chat.history = [{ role: 'user', content: `body ${i}` }];
      return chat;
    });
    setDirtyTrackingVerifierForcedForTests(true);
    setSessionStateForTests(state);
    captureDirtyTrackingShadowForTests();

    const baselined = getDirtyTrackingShadowSizeForTests();
    assert.ok(baselined > 0 && baselined < state.chats.length, `sampled ${baselined}`);
  });
});
