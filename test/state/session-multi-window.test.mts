/**
 * Multi-window session writes.
 *
 * Normal hydration establishes trusted dirty sets immediately. Legacy/untrusted
 * baselines still describe every row; those describes must never be rebased over
 * another window's edits or deletions.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { patchSessions } from '../../src/config/api-client.ts';
import {
  createEmptyChatObject,
  getSessionDirtyTrackingForTests,
  ensureChatHistoryLoaded,
  loadSessionsFromStorage,
  persistSessionsBeforeDeliveryAck,
  resetSessionPersistenceForTests,
  refreshSessionsFromServer,
  saveSessionsNow,
  sessionState,
  setSessionStateForTests,
  setSessionPatchDirtySetsReadyForTests,
  touchChat,
  waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';

const MINE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface PatchBody {
  baseRevision?: number;
  chats?: { id: string; name?: string }[];
  chatBaseRevisions?: Record<string, number>;
}

/** A fake sessions store that enforces the revision guard like the real one. */
class FakeSessionsStore {
  revision = 7;
  readonly chatRevisions = new Map([[MINE, 0], [THEIRS, 0]]);
  readonly chatNames = new Map([[MINE, 'Mine'], [THEIRS, 'Theirs']]);
  readonly writes: PatchBody[] = [];

  /** Another window wrote: the shared revision counter moves on. */
  advance(): void {
    this.revision += 1;
  }

  advanceChat(id: string): void {
    this.advance();
    this.chatRevisions.set(id, this.revision);
    this.chatNames.set(id, `${this.chatNames.get(id)} updated elsewhere`);
  }

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/api/config/sessions/summaries')) {
        return this.json({
          version: 6,
          revision: this.revision,
          chatRevisions: Object.fromEntries(this.chatRevisions),
          activeId: MINE,
          chats: [...this.chatNames].map(([id, name]) => ({ id, name,
            workspacePath: id === THEIRS ? '/b' : '/a', modelId: 'm', updatedAt: 2, messageCount: 1 })),
        });
      }
      if (url.includes('/api/config/sessions/history/')) {
        const chatId = decodeURIComponent(url.split('/sessions/history/')[1]?.split('?')[0] ?? '');
        return this.json({ chatId, history: [], chatRevision: this.chatRevisions.get(chatId) ?? 0 });
      }
      if (url.includes('/api/config/sessions') && method !== 'GET') {
        const body = JSON.parse(String(init?.body ?? '{}')) as PatchBody;
        this.writes.push(body);
        if (typeof body.baseRevision === 'number' && body.baseRevision !== this.revision) {
          return this.json(
            { error: 'Session state changed in another window', revision: this.revision },
            409,
          );
        }
        for (const chat of body.chats ?? []) {
          const expected = body.chatBaseRevisions?.[chat.id];
          if (typeof expected === 'number' && expected !== (this.chatRevisions.get(chat.id) ?? 0)) {
            return this.json({ error: 'Chat changed in another window', revision: this.revision,
              conflictingChatIds: [chat.id] }, 409);
          }
        }
        this.revision += 1;
        for (const chat of body.chats ?? []) {
          this.chatRevisions.set(chat.id, this.revision);
          if (chat.name) this.chatNames.set(chat.id, chat.name);
        }
        return this.json({ ok: true, revision: this.revision });
      }
      return this.json({ ok: true });
    }) as typeof fetch;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function bootWindow(store: FakeSessionsStore, untrustedBaseline = false): Promise<void> {
  setStorageModeForTests('server');
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  store.install();
  await loadSessionsFromStorage({ force: true });
  if (untrustedBaseline) setSessionPatchDirtySetsReadyForTests(false);
}

describe('multi-window session writes', () => {
  test('live refresh imports remote chats, edits and deletes without moving the active chat', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    const active = sessionState!.chats.find((chat) => chat.id === MINE)!;
    store.advanceChat(THEIRS);
    const added = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    store.chatNames.set(added, 'Mobile chat');
    store.chatRevisions.set(added, store.revision);
    const result = await refreshSessionsFromServer();
    assert.deepEqual(result, { changed: true, activeChanged: false });
    assert.equal(sessionState!.activeId, MINE);
    assert.equal(sessionState!.chats.find((chat) => chat.id === MINE), active);
    assert.equal(sessionState!.chats.find((chat) => chat.id === THEIRS)!.name, 'Theirs updated elsewhere');
    assert.equal(sessionState!.chats.find((chat) => chat.id === added)!.name, 'Mobile chat');
    store.chatNames.delete(THEIRS);
    store.advance();
    await refreshSessionsFromServer();
    assert.equal(sessionState!.chats.some((chat) => chat.id === THEIRS), false);
    assert.equal(store.writes.length, 0, 'receiving updates never echoes a write');
  });

  test('live refresh updates active history but preserves its object identity', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    const active = sessionState!.chats.find((chat) => chat.id === MINE)!;
    store.advanceChat(MINE);
    const fetchStore = globalThis.fetch;
    globalThis.fetch = async (input, init) => String(input).includes(`/history/${MINE}`)
      ? Response.json({ history: [{ role: 'user', content: 'Sent from phone' }] })
      : fetchStore(input, init);
    assert.deepEqual(await refreshSessionsFromServer(), { changed: true, activeChanged: true });
    assert.equal(sessionState!.chats.find((chat) => chat.id === MINE), active);
    assert.equal(active.history[0].content, 'Sent from phone');
    assert.equal(active.historyLoaded, true);
  });

  test('live refresh protects dirty chats and their conflict bases while importing unrelated changes', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    const active = sessionState!.chats.find((chat) => chat.id === MINE)!;
    active.name = 'Unsaved desktop work';
    touchChat(active);
    store.advanceChat(MINE);
    store.advanceChat(THEIRS);
    await refreshSessionsFromServer();
    assert.equal(active.name, 'Unsaved desktop work');
    assert.equal(sessionState!.chats.find((chat) => chat.id === THEIRS)!.name, 'Theirs updated elsewhere');
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(store.writes[0].chatBaseRevisions?.[MINE], 0);
    assert.equal(store.chatNames.get(MINE), 'Mine updated elsewhere');
  });

  test('live refresh preserves a draft before its deferred dirty marker is written', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    const active = sessionState!.chats.find((chat) => chat.id === MINE)!;
    active.composerDraft = 'Still typing';
    store.advanceChat(MINE);
    await refreshSessionsFromServer();
    assert.equal(active.composerDraft, 'Still typing');
    assert.equal(active.name, 'Mine');
  });

  test('remote deletion of the active chat leaves a usable local draft without resurrecting it', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    store.chatNames.delete(MINE);
    store.advance();
    assert.deepEqual(await refreshSessionsFromServer(), { changed: true, activeChanged: true });
    assert.equal(sessionState!.chats.some((chat) => chat.id === MINE), false);
    const draft = sessionState!.chats.find((chat) => chat.id === sessionState!.activeId)!;
    assert.ok(draft);
    assert.equal(draft.historyLoaded, true);
    await refreshSessionsFromServer();
    assert.equal(sessionState!.chats.find((chat) => chat.id === draft.id), draft);
    assert.equal(store.writes.length, 0);
  });

  test('an edit landing during a refresh keeps local work and retries on the next poll', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    store.advanceChat(MINE);
    const active = sessionState!.chats.find((chat) => chat.id === MINE)!;
    const fetchStore = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await fetchStore(input, init);
      if (String(input).includes(`/history/${MINE}`)) {
        active.name = 'Typed while reading';
        touchChat(active);
      }
      return response;
    };
    assert.deepEqual(await refreshSessionsFromServer(), { changed: false, activeChanged: false });
    assert.equal(active.name, 'Typed while reading');
  });

  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.fetch;
    setStorageModeForTests('localStorage');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
  });

  test('opening a second window does not revise the first window’s untouched chat', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    const firstWindowChat = structuredClone(sessionState!.chats.find((chat) => chat.id === MINE)!);
    const firstWindowBase = store.chatRevisions.get(MINE)!;
    const firstWindowRevision = store.revision;

    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(store.chatRevisions.get(MINE), firstWindowBase,
      'an idle second window must not claim ownership of every chat');
    const theirs = sessionState!.chats.find((chat) => chat.id === THEIRS)!;
    theirs.name = 'Second window edit';
    touchChat(theirs);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(store.chatRevisions.get(MINE), firstWindowBase);
    assert.deepEqual(store.writes.flatMap((write) => write.chats ?? []).map((chat) => chat.id), [THEIRS]);

    firstWindowChat.name = 'First window edit';
    await patchSessions({ baseVersion: 6, baseRevision: firstWindowRevision,
      chatBaseRevisions: { [MINE]: firstWindowBase }, chats: [firstWindowChat] });
    assert.equal(store.chatNames.get(MINE), 'First window edit');
    assert.equal(store.chatNames.get(THEIRS), 'Second window edit');
  });

  test('a stale unrelated chat is excluded from the first normal save', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    store.advanceChat(THEIRS);
    const mine = sessionState!.chats.find((chat) => chat.id === MINE)!;
    mine.name = 'My first edit';
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.ok(store.writes.every((write) =>
      (write.chats ?? []).every((chat) => chat.id === MINE)));
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
    assert.equal(store.chatNames.get(MINE), 'My first edit');
    assert.equal(store.chatNames.get(THEIRS), 'Theirs updated elsewhere');
  });

  test('a conflicted whole-state describe is dropped, not re-based over the other window', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store, true);
    assert.equal(getSessionDirtyTrackingForTests().sessionPatchDirtySetsReady, false);

    // The other window saves between this window's boot and its first flush.
    store.advance();

    saveSessionsNow();
    await waitForSessionSaveForTests();

    const describe = store.writes[0];
    assert.ok(describe, 'expected the boot describe');
    assert.ok(
      describe.chats?.some((c) => c.id === THEIRS),
      'the describe should carry every chat',
    );

    // Whatever followed the 409 must not re-send the other window's row.
    for (const write of store.writes.slice(1)) {
      assert.equal(
        write.chats?.some((c) => c.id === THEIRS) ?? false,
        false,
        'the other window’s chat was re-sent after the conflict',
      );
    }
    assert.equal(getSessionDirtyTrackingForTests().sessionPatchDirtySetsReady, true);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(THEIRS), false);
  });

  test('after the drop, only this window’s own edits are sent', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store, true);
    store.advance();

    saveSessionsNow();
    await waitForSessionSaveForTests();
    const afterDescribe = store.writes.length;

    const mine = sessionState?.chats.find((c) => c.id === MINE);
    assert.ok(mine);
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    const followUps = store.writes.slice(afterDescribe);
    assert.ok(followUps.length >= 1, 'expected a follow-up write');
    for (const write of followUps) {
      assert.deepEqual((write.chats ?? []).map((c) => c.id), [MINE]);
    }
  });

  test('an edit made while the describe was in flight survives the drop', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store, true);
    store.advance();

    saveSessionsNow();
    // Touch a chat before the conflicted describe settles: the drop must not
    // take this real edit with it.
    const mine = sessionState?.chats.find((c) => c.id === MINE);
    assert.ok(mine);
    touchChat(mine);
    await waitForSessionSaveForTests();

    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(THEIRS), false);
    const landed = store.writes.slice(1).flatMap((w) => (w.chats ?? []).map((c) => c.id));
    assert.ok(landed.includes(MINE), 'the in-flight edit was dropped with the describe');
  });

  test('an ordinary delta still re-bases onto the newer revision', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);

    // An idle save can send scalar backfills, but cannot restamp untouched chats.
    saveSessionsNow();
    await waitForSessionSaveForTests();
    const afterDescribe = store.writes.length;
    assert.equal(store.writes[0]?.baseRevision, 7);

    // Now the other window writes, so this window's delta is composed stale.
    store.advance();
    const staleRevision = store.revision;

    const mine = sessionState?.chats.find((c) => c.id === MINE);
    assert.ok(mine);
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    const followUps = store.writes.slice(afterDescribe);
    assert.equal(followUps.length, 2, 'expected one conflict then one re-based retry');
    assert.equal(followUps[1]?.baseRevision, staleRevision);
    assert.deepEqual((followUps[1]?.chats ?? []).map((c) => c.id), [MINE]);
  });

  test('a same-chat conflict stops retrying and retains the unsaved edit', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    const before = store.writes.length;

    store.advanceChat(MINE);
    const mine = sessionState?.chats.find((chat) => chat.id === MINE);
    assert.ok(mine);
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(store.writes.length, before + 2, 'global conflict retries once; chat conflict stops');
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[MINE], 0);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(MINE), true);
    saveSessionsNow();
    assert.equal(store.writes.length, before + 2, 'blocked viewer must not overwrite on another flush');
  });

  test('a conflicted chat does not prevent new chats or unrelated edits surviving reload', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    store.advanceChat(MINE);
    const mine = sessionState!.chats.find((chat) => chat.id === MINE)!;
    mine.name = 'Unsaved conflicting edit';
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();

    const fresh = createEmptyChatObject('m', '/a');
    sessionState!.chats.unshift(fresh);
    fresh.name = 'Recent chat';
    touchChat(fresh);
    const theirs = sessionState!.chats.find((chat) => chat.id === THEIRS)!;
    theirs.name = 'Unrelated edit';
    touchChat(theirs);
    const before = store.writes.length;
    saveSessionsNow();
    await waitForSessionSaveForTests();
    const landed = store.writes.slice(before).flatMap((write) => write.chats ?? []);
    assert.deepEqual(landed.map((chat) => chat.id).sort(), [fresh.id, THEIRS].sort());
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [MINE]);
    assert.equal(mine.name, 'Unsaved conflicting edit', 'retain the conflict for copying');
    assert.equal(store.chatNames.get(MINE), 'Mine updated elsewhere');
    assert.equal(await persistSessionsBeforeDeliveryAck(), false, 'conflicted edits are not durably acknowledged');
    await bootWindow(store);
    assert.equal(sessionState!.chats.find((chat) => chat.id === fresh.id)?.name, 'Recent chat');
    assert.equal(sessionState!.chats.find((chat) => chat.id === THEIRS)?.name, 'Unrelated edit');
  });

  test('a stale unedited boot row cannot block the first real edit', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store, true);
    // Expose a per-chat conflict directly on the first describe.
    store.chatRevisions.set(THEIRS, store.revision);
    const mine = sessionState!.chats.find((chat) => chat.id === MINE)!;
    mine.name = 'My first edit';
    touchChat(mine);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    assert.equal(store.writes.length, 2);
    assert.deepEqual(store.writes[1]?.chats?.map((chat) => chat.id), [MINE]);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
    assert.equal(store.chatNames.get(MINE), 'My first edit');
  });

  test('shutdown excludes a conflicted row and retains its unsaved dirty marker', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    store.advanceChat(MINE);
    touchChat(sessionState!.chats.find((chat) => chat.id === MINE)!);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    const fresh = createEmptyChatObject('m', '/a');
    sessionState!.chats.unshift(fresh);
    touchChat(fresh);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const beacons: PatchBody[] = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      sendBeacon: (_url: string, blob: Blob) => {
        void blob.text().then((body) => beacons.push(JSON.parse(body)));
        return true;
      },
    } });
    try {
      saveSessionsNow({ keepalive: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(beacons.flatMap((body) => body.chats ?? []).map((chat) => chat.id), [fresh.id]);
      assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [MINE]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  test('a caller without chat bases cannot blindly rebase a stale write', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    store.advance();
    const mine = sessionState?.chats.find((chat) => chat.id === MINE);
    assert.ok(mine);
    await assert.rejects(patchSessions({ baseVersion: 6, baseRevision: 7,
      chats: [mine] }), /another window/);
    assert.equal(store.writes.length, 1);
  });

  test('lazy hydration retains stale metadata base and rejects its later overwrite', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    store.advanceChat(THEIRS);

    await ensureChatHistoryLoaded(THEIRS);
    const theirs = sessionState?.chats.find((chat) => chat.id === THEIRS);
    assert.ok(theirs);
    assert.equal(theirs.name, 'Theirs', 'history hydration does not refresh metadata');
    assert.equal(store.chatNames.get(THEIRS), 'Theirs updated elsewhere');
    touchChat(theirs);
    const before = store.writes.length;
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(store.writes.length, before + 2);
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[THEIRS], 0);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(THEIRS), true);
  });

  test('lazy hydration keeps an older base when the chat was edited locally', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
    saveSessionsNow();
    await waitForSessionSaveForTests();
    const theirs = sessionState?.chats.find((chat) => chat.id === THEIRS);
    assert.ok(theirs);
    touchChat(theirs);
    store.advanceChat(THEIRS);

    await ensureChatHistoryLoaded(THEIRS);
    const before = store.writes.length;
    saveSessionsNow();
    await waitForSessionSaveForTests();

    assert.equal(store.writes.length, before + 2);
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[THEIRS], 0);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(THEIRS), true);
  });
});
