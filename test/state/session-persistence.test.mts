/**
 * MIN-408 + B.2: hydration guard, PATCH flush, shutdown beacon size branch.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  chooseSessionsShutdownTransport,
  FETCH_KEEPALIVE_MAX_BYTES,
  putSessionsKeepalive,
  SESSIONS_BEACON_MAX_BYTES,
} from '../../src/config/api-client.ts';
import {
  buildSessionsPatchDelta,
  flushPendingSessionSaveOnShutdown,
  getSessionDirtyTrackingForTests,
  isSessionsHydratedFromServerForTests,
  loadSessionsFromStorage,
  markGroupDeleted,
  markGroupDirty,
  removeChatById,
  resetSessionPersistenceForTests,
  saveSessionsNow,
  sessionState,
  setSessionPatchDirtySetsReadyForTests,
  setSessionStateForTests,
  setSessionsClientPatchEnabledForTests,
  setSessionsLazyHistoryEnabledForTests,
  touchChat,
  waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';
import type { ChatGroup, SessionState } from '../../src/types.ts';

const SAVED_CHAT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_CHAT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_ID = 'grp_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function restoreFetch(): void {
  // @ts-expect-error test cleanup
  delete globalThis.fetch;
}

/**
 * Mock GET for C.2 lazy boot: summaries omit history; history/:id returns full messages.
 * Whole-blob GET remains for flag-off tests / export paths.
 */
function mockSessionsGet(payload: SessionState | Record<string, unknown>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/api/config/sessions') && (!init?.method || init.method === 'GET')) {
      if (url.includes('/sessions/history/')) {
        const chatId = decodeURIComponent(url.split('/sessions/history/')[1]?.split('?')[0] ?? '');
        const chats = Array.isArray((payload as SessionState).chats)
          ? (payload as SessionState).chats
          : [];
        const chat = chats.find((c) => c.id === chatId);
        return new Response(JSON.stringify({ chatId, history: chat?.history ?? [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/sessions/summaries')) {
        const chats = Array.isArray((payload as SessionState).chats)
          ? (payload as SessionState).chats
          : [];
        const summaries = chats.map((chat) => {
          const history = Array.isArray(chat.history) ? chat.history : [];
          const last = history.length ? history[history.length - 1] : null;
          const { history: _drop, ...rest } = chat;
          void _drop;
          return {
            ...rest,
            messageCount: history.length,
            lastMessagePreview:
              last && typeof last === 'object' && typeof (last as { content?: unknown }).content === 'string'
                ? String((last as { content: string }).content).slice(0, 240)
                : '',
          };
        });
        return new Response(JSON.stringify({ ...payload, chats: summaries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

describe('session persistence (MIN-408 + B.2)', () => {
  afterEach(() => {
    restoreFetch();
    // @ts-expect-error test cleanup
    delete globalThis.navigator;
    setStorageModeForTests('localStorage');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
  });

  test('server GET failure does not hydrate and blocks PATCH/PUT clobber', async () => {
    setStorageModeForTests('server');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);

    globalThis.fetch = async () => {
      throw new Error('config server unavailable');
    };

    await loadSessionsFromStorage();

    assert.ok(sessionState);
    assert.equal(isSessionsHydratedFromServerForTests(), false);

    let writeCalled = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (
        url.includes('/api/config/sessions') &&
        (init?.method === 'PUT' || init?.method === 'PATCH' || init?.method === 'POST')
      ) {
        writeCalled = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Dirty markers must not bypass the MIN-408 hydration guard.
    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    setSessionPatchDirtySetsReadyForTests(true);
    assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.length >= 1);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(writeCalled, false);
  });

  test('force reload replaces stale in-memory sessions from ~/.minnow', async () => {
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    const serverPayload = {
      version: 5,
      activeId: SAVED_CHAT_ID,
      sidebarCollapsed: false,
      chats: [
        {
          id: SAVED_CHAT_ID,
          name: 'Persisted chat',
          workspacePath: '',
          modelId: 'test-model',
          history: [{ role: 'user', content: 'hello' }],
          updatedAt: 1,
        },
      ],
    };

    globalThis.fetch = mockSessionsGet(serverPayload);

    await loadSessionsFromStorage({ force: true });

    assert.equal(sessionState?.activeId, SAVED_CHAT_ID);
    assert.equal(sessionState?.chats.length, 1);
    assert.equal(sessionState?.chats[0]?.name, 'Persisted chat');
    // C.2 lazy boot hydrates the active chat's full history after summaries.
    assert.equal(sessionState?.chats[0]?.historyLoaded, true);
    assert.equal(sessionState?.chats[0]?.history[0]?.content, 'hello');
    assert.equal(isSessionsHydratedFromServerForTests(), true);
    assert.equal(getSessionDirtyTrackingForTests().sessionPatchDirtySetsReady, false);
  });

  test('lazy summaries keep messageCount on unloaded chats after ensureChatShape', async () => {
    // Regression: normalizeChatRow dropped messageCount → empty rails + prune wiped SQLite.
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    const activeId = SAVED_CHAT_ID;
    const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const serverPayload = {
      version: 6,
      activeId,
      sidebarCollapsed: false,
      chats: [
        {
          id: activeId,
          name: 'Active',
          workspacePath: '/ws',
          modelId: 'm',
          history: [{ role: 'user', content: 'hi' }],
          updatedAt: 2,
        },
        {
          id: otherId,
          name: 'Other prior chat',
          workspacePath: '/ws',
          modelId: 'm',
          history: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
          ],
          updatedAt: 1,
        },
      ],
    };

    globalThis.fetch = mockSessionsGet(serverPayload);
    await loadSessionsFromStorage({ force: true });

    const other = sessionState?.chats.find((c) => c.id === otherId);
    assert.ok(other);
    assert.equal(other.historyLoaded, false);
    assert.equal(other.messageCount, 2);
    assert.equal(other.history.length, 0);
  });

  test('delete during in-flight PUT is not resurrected (follow-up flush)', async () => {
    // Overlapping PUT + delete used to clear deletedChatIds when the PUT settled,
    // leaving the removed chat on disk after reload.
    setStorageModeForTests('server');
    resetSessionPersistenceForTests();

    const twoChats: SessionState = {
      version: 6,
      activeId: SAVED_CHAT_ID,
      sidebarCollapsed: false,
      chats: [
        {
          id: SAVED_CHAT_ID,
          name: 'Keep',
          workspacePath: '',
          modelId: 'm',
          history: [{ role: 'user', content: 'keep' }],
          updatedAt: 2,
          lastMessageAt: 2,
          lastStats: null,
          modelInfo: {},
        },
        {
          id: OTHER_CHAT_ID,
          name: 'Delete me',
          workspacePath: '',
          modelId: 'm',
          history: [{ role: 'user', content: 'gone' }],
          updatedAt: 1,
          lastMessageAt: 1,
          lastStats: null,
          modelInfo: {},
        },
      ],
    };
    setSessionStateForTests(twoChats);
    // Simulate post-load: next save must full-PUT.
    setSessionPatchDirtySetsReadyForTests(false);

    let releasePut!: () => void;
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const putBodies: Array<{ chats?: Array<{ id: string }> }> = [];
    const patchBodies: Array<{ deleteChatIds?: string[] }> = [];

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/config/sessions') && method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body ?? '{}')));
        await putGate;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/api/config/sessions') && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    touchChat(twoChats.chats[0]!);
    saveSessionsNow();
    // Delete while the baseline PUT is still in flight.
    removeChatById(OTHER_CHAT_ID, 'm');
    assert.equal(
      sessionState?.chats.some((c) => c.id === OTHER_CHAT_ID),
      false,
    );
    assert.deepEqual(getSessionDirtyTrackingForTests().deletedChatIds, [OTHER_CHAT_ID]);

    releasePut();
    await waitForSessionSaveForTests();

    assert.equal(putBodies.length, 1);
    assert.ok(putBodies[0]?.chats?.some((c) => c.id === OTHER_CHAT_ID));
    // Follow-up PATCH must delete the chat the stale PUT may have rewritten.
    assert.ok(
      patchBodies.some((body) => body.deleteChatIds?.includes(OTHER_CHAT_ID)),
      'expected follow-up PATCH with deleteChatIds',
    );
    assert.deepEqual(getSessionDirtyTrackingForTests().deletedChatIds, []);
    assert.equal(sessionState?.chats.some((c) => c.id === OTHER_CHAT_ID), false);
  });

  test('current-schema hydration uses PATCH from the first save', async () => {
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    globalThis.fetch = mockSessionsGet(defaultSessionState());

    await loadSessionsFromStorage({ force: true });
    assert.equal(getSessionDirtyTrackingForTests().sessionPatchDirtySetsReady, true);

    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method) {
        methods.push(init.method);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.deepEqual(methods, ['PATCH']);
    assert.equal(getSessionDirtyTrackingForTests().sessionPatchDirtySetsReady, true);

    methods.length = 0;
    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.deepEqual(methods, ['PATCH']);
  });

  test('startup backfills persist only the loaded chat that changed', async () => {
    setStorageModeForTests('server');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
    const remote = defaultSessionState();
    remote.chats[0]!.id = SAVED_CHAT_ID;
    remote.activeId = SAVED_CHAT_ID;
    remote.chats[0]!.history = [{ role: 'user', content: 'Existing history' }];
    remote.chats.push({ ...remote.chats[0]!, id: OTHER_CHAT_ID, name: 'Untouched chat' });
    globalThis.fetch = mockSessionsGet(remote);
    await loadSessionsFromStorage({ force: true });
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [SAVED_CHAT_ID]);
    assert.equal(getSessionDirtyTrackingForTests().sessionScalarsDirty, true);
    const bodies: Array<{ chats?: Array<{ id: string; codeChangeBackfillAt?: number }> }> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, revision: 1 });
    };
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.deepEqual(bodies.flatMap((body) => body.chats ?? []).map((chat) => chat.id), [SAVED_CHAT_ID]);
    assert.ok(bodies[0]?.chats?.[0]?.codeChangeBackfillAt);
  });

  test('failed PATCH keeps dirty sets for retry', async () => {
    setStorageModeForTests('server');
    const state = defaultSessionState();
    setSessionStateForTests(state);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 });

    touchChat(state.chats[0]!);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [state.chats[0]!.id]);
  });

  test('deletedGroupIds are emitted on PATCH (not dirty upsert)', async () => {
    setStorageModeForTests('server');
    const state = defaultSessionState();
    const group: ChatGroup = {
      id: GROUP_ID,
      name: 'Folder',
      workspacePath: '',
      collapsed: false,
      order: 0,
      createdAt: 1,
    };
    state.groups = [group];
    setSessionStateForTests(state);

    let patchBody: unknown = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Simulate delete: mark deleted (and ensure a prior dirty mark is superseded).
    markGroupDirty(GROUP_ID);
    state.groups = [];
    markGroupDeleted(GROUP_ID);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    const body = patchBody as { deleteGroupIds?: string[]; groups?: ChatGroup[] };
    assert.deepEqual(body.deleteGroupIds, [GROUP_ID]);
    assert.equal(body.groups, undefined);
  });

  test('buildSessionsPatchDelta includes only dirty chats', () => {
    const state = defaultSessionState() as SessionState;
    state.chats = [
      {
        id: SAVED_CHAT_ID,
        name: 'A',
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
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        name: 'B',
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
    setSessionStateForTests(state);
    touchChat(state.chats[0]!);
    const delta = buildSessionsPatchDelta(state);
    assert.equal(delta.chats?.length, 1);
    assert.equal(delta.chats?.[0]?.id, SAVED_CHAT_ID);
  });

  test('chooseSessionsShutdownTransport respects 60 KiB beacon threshold', () => {
    assert.equal(chooseSessionsShutdownTransport(SESSIONS_BEACON_MAX_BYTES - 1), 'beacon');
    assert.equal(chooseSessionsShutdownTransport(SESSIONS_BEACON_MAX_BYTES), 'keepalive-put');
    assert.equal(chooseSessionsShutdownTransport(FETCH_KEEPALIVE_MAX_BYTES), 'keepalive-put');
  });

  test('shutdown flush uses sendBeacon for small PATCH deltas', async () => {
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    globalThis.fetch = mockSessionsGet(defaultSessionState());

    await loadSessionsFromStorage({ force: true });
    // Establish trusted dirty sets via a baseline PUT.
    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    saveSessionsNow();
    await waitForSessionSaveForTests();

    let beaconBodies: string[] = [];
    let keepalivePut = false;
    // @ts-expect-error test stub
    globalThis.navigator = {
      sendBeacon(url: string, data?: BodyInit | null) {
        assert.equal(url, '/api/config/sessions');
        if (data instanceof Blob) {
          // Blob.text is async; decode via FileReader-less path for Node.
          beaconBodies.push('queued');
        } else {
          beaconBodies.push(String(data ?? ''));
        }
        return true;
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PUT' && init.keepalive) {
        keepalivePut = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    flushPendingSessionSaveOnShutdown();
    assert.equal(beaconBodies.length, 1);
    assert.equal(keepalivePut, false);
  });

  test('shutdown flush falls back to keepalive PUT when delta is oversized', async () => {
    setStorageModeForTests('server');
    const state = defaultSessionState();
    // Inflate one chat so the PATCH delta exceeds the 60 KiB beacon budget.
    state.chats[0]!.history = [
      { role: 'user', content: 'x'.repeat(SESSIONS_BEACON_MAX_BYTES) },
    ];
    setSessionStateForTests(state);

    let beaconCalls = 0;
    let keepalivePut = false;
    // @ts-expect-error test stub
    globalThis.navigator = {
      sendBeacon() {
        beaconCalls += 1;
        return true;
      },
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PUT' && init.keepalive) {
        keepalivePut = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    touchChat(state.chats[0]!);
    flushPendingSessionSaveOnShutdown();
    assert.equal(beaconCalls, 0);
    assert.equal(keepalivePut, true);
  });

  test('lazy-history flag off still boots via whole-blob GET', async () => {
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();
    setSessionsLazyHistoryEnabledForTests(false);

    const remote = defaultSessionState();
    remote.chats[0]!.id = SAVED_CHAT_ID;
    remote.activeId = SAVED_CHAT_ID;
    const paths: string[] = [];
    let putBody: { baseRevision?: number; chatBaseRevisions?: Record<string, number> } | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && (!init?.method || init.method === 'GET')) {
        paths.push(url);
        return new Response(JSON.stringify({ ...remote, revision: 4,
          chatRevisions: { [SAVED_CHAT_ID]: 3 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (init?.method === 'PATCH') putBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, revision: 5 }), { status: 200 });
    };

    await loadSessionsFromStorage({ force: true });
    assert.ok(paths.some((p) => p.includes('/api/config/sessions') && !p.includes('summaries')));
    assert.ok(!paths.some((p) => p.includes('/summaries')));
    assert.equal(sessionState?.chats.every((c) => c.historyLoaded !== false), true);
    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(putBody?.baseRevision, 4);
    assert.equal(putBody?.chatBaseRevisions?.[SAVED_CHAT_ID], 3);
  });

  test('sessionsClientPatchEnabled=false forces full PUT', async () => {
    setStorageModeForTests('server');
    const state = defaultSessionState();
    setSessionStateForTests(state);
    setSessionsClientPatchEnabledForTests(false);

    let method = '';
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method) {
        method = init.method;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    touchChat(state.chats[0]!);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(method, 'PUT');
  });

  test('putSessionsKeepalive attaches catch to keepalive fetch', () => {
    let catchAttached = false;
    globalThis.fetch = (() => {
      const base = Promise.reject(new TypeError('Failed to fetch')) as Promise<Response>;
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === 'catch') {
            return (...args: Parameters<Promise<Response>['catch']>) => {
              catchAttached = true;
              return Reflect.get(target, prop, receiver).apply(target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }) as typeof fetch;

    putSessionsKeepalive(defaultSessionState());
    assert.equal(catchAttached, true);
  });

  test('putSessionsKeepalive reports an over-cap body as not dispatched', () => {
    // Browsers drop keepalive bodies past 64 KiB silently. Reporting that as a
    // success let the client clear dirty markers for a write that never happened.
    let dispatched = false;
    globalThis.fetch = (async () => {
      dispatched = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const state = defaultSessionState();
    state.chats[0]!.history = [
      { role: 'user', content: 'x'.repeat(FETCH_KEEPALIVE_MAX_BYTES) },
    ];

    assert.equal(putSessionsKeepalive(state), false);
    assert.equal(dispatched, false);
  });

  test('shutdown flush splits an oversized delta into per-chat beacons', async () => {
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();
    globalThis.fetch = mockSessionsGet(defaultSessionState());
    await loadSessionsFromStorage({ force: true });
    saveSessionsNow();
    await waitForSessionSaveForTests();
    setSessionPatchDirtySetsReadyForTests(true);

    const state = sessionState!;
    // Two chats that each fit a beacon but together blow the budget.
    const half = Math.floor(SESSIONS_BEACON_MAX_BYTES * 0.6);
    state.chats[0]!.history = [{ role: 'user', content: 'x'.repeat(half) }];
    state.chats.push({
      id: OTHER_CHAT_ID,
      name: 'B',
      workspacePath: '',
      modelId: 'm',
      modeId: 'build',
      history: [{ role: 'user', content: 'y'.repeat(half) }],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
      lastMessageAt: 1,
    });
    touchChat(state.chats[0]!);
    touchChat(state.chats[1]!);

    const beaconBlobs: Blob[] = [];
    let keepalivePut = false;
    // @ts-expect-error test stub
    globalThis.navigator = {
      sendBeacon(_url: string, data: Blob) {
        beaconBlobs.push(data);
        return true;
      },
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/config/sessions') && init?.keepalive) {
        keepalivePut = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    flushPendingSessionSaveOnShutdown();

    assert.equal(beaconBlobs.length, 2, 'one beacon per chat');
    const pieces = await Promise.all(beaconBlobs.map(async (blob) => JSON.parse(await blob.text())));
    for (const piece of pieces) {
      const id = piece.chats[0].id;
      assert.deepEqual(piece.chatBaseRevisions, { [id]: 0 });
    }
    assert.equal(keepalivePut, false, 'no over-cap whole-blob fallback needed');
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.length, 0);
  });

  test('shutdown flush keeps dirty markers when nothing could be dispatched', async () => {
    // Reporting an undispatched keepalive PUT as success dropped the markers for a
    // write the browser had already discarded.
    setStorageModeForTests('server');
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();
    globalThis.fetch = mockSessionsGet(defaultSessionState());
    await loadSessionsFromStorage({ force: true });
    saveSessionsNow();
    await waitForSessionSaveForTests();
    setSessionPatchDirtySetsReadyForTests(true);

    const state = sessionState!;
    // A single chat too big for a beacon and for the keepalive cap.
    state.chats[0]!.history = [
      { role: 'user', content: 'x'.repeat(FETCH_KEEPALIVE_MAX_BYTES + 1024) },
    ];
    touchChat(state.chats[0]!);

    let beaconCalls = 0;
    let keepalivePut = false;
    // @ts-expect-error test stub
    globalThis.navigator = {
      sendBeacon() {
        beaconCalls += 1;
        return true;
      },
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/config/sessions') && init?.keepalive) {
        keepalivePut = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    flushPendingSessionSaveOnShutdown();

    assert.equal(beaconCalls, 0);
    assert.equal(keepalivePut, false);
    assert.equal(
      getSessionDirtyTrackingForTests().dirtyChatIds.length,
      1,
      'an undispatched shutdown write must keep its dirty markers',
    );
  });

  test('a degraded summaries parse does not count as hydrated', async () => {
    // parseSessionStateFromJson falls back to a single empty chat for shapes it does
    // not recognize. Adopting that as real state is what turned one bad boot into a
    // PUT that deleted every other chat.
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(true);
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    const remote = defaultSessionState();
    remote.chats.push({
      id: OTHER_CHAT_ID,
      name: 'Real chat',
      workspacePath: '',
      modelId: 'm',
      modeId: 'build',
      history: [{ role: 'user', content: 'keep me' }],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
      lastMessageAt: 1,
    });
    // A version the parser rejects sends it down the default-state path.
    globalThis.fetch = mockSessionsGet({ ...remote, version: 99 });

    await loadSessionsFromStorage({ force: true });
    assert.equal(isSessionsHydratedFromServerForTests(), false);

    let wrote = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(input).includes('/api/config/sessions') &&
        (init?.method === 'PUT' || init?.method === 'PATCH')
      ) {
        wrote = true;
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    if (sessionState?.chats[0]) touchChat(sessionState.chats[0]);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(wrote, false, 'a degraded session must never reach the store');
  });

  test('a lazy-unloaded chat forces PATCH instead of a whole-blob PUT', async () => {
    // A PUT describes the whole session. After a lazy boot the client cannot
    // describe the transcripts it never loaded, so it must not send one.
    setStorageModeForTests('server');
    setSessionsLazyHistoryEnabledForTests(true);
    setSessionStateForTests(defaultSessionState());
    resetSessionPersistenceForTests();

    const remote = defaultSessionState();
    remote.chats[0]!.history = [{ role: 'user', content: 'stored' }];
    remote.chats.push({
      id: OTHER_CHAT_ID,
      name: 'Never opened',
      workspacePath: '',
      modelId: 'm',
      modeId: 'build',
      history: [{ role: 'user', content: 'do not lose me' }],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
      lastMessageAt: 1,
    });

    globalThis.fetch = mockSessionsGet(remote);
    await loadSessionsFromStorage({ force: true });

    const unloaded = sessionState!.chats.find((c) => c.id === OTHER_CHAT_ID)!;
    assert.equal(unloaded.historyLoaded, false, 'precondition: chat stayed unhydrated');

    let putCalls = 0;
    let patchBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/config/sessions') && init?.method === 'PUT') putCalls += 1;
      if (url.includes('/api/config/sessions') && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    touchChat(sessionState!.chats[0]!);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(putCalls, 0, 'no whole-blob PUT while a transcript is unloaded');
    assert.ok(patchBody, 'the save must still reach the server');
    const wired = (patchBody!.chats as Record<string, unknown>[]).find(
      (c) => c.id === OTHER_CHAT_ID,
    );
    assert.equal(wired, undefined, 'untouched unloaded chats are excluded entirely');
  });
});
