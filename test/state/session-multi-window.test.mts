/**
 * Multi-window session writes.
 *
 * Every window loads the whole cross-workspace chat list, and the first flush
 * after a lazy boot upserts *every* row so the PATCH can stand in for a full
 * PUT. That body describes chats another window owns, frozen at this window's
 * boot — so it must never be re-based onto a newer revision. If it were, this
 * window would push stale copies over the other window's edits and revive chats
 * it had deleted.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { patchSessions } from '../../src/config/api-client.ts';
import {
  getSessionDirtyTrackingForTests,
  ensureChatHistoryLoaded,
  loadSessionsFromStorage,
  resetSessionPersistenceForTests,
  saveSessionsNow,
  sessionState,
  setSessionStateForTests,
  touchChat,
  waitForSessionSaveForTests,
} from '../../src/state/sessions.ts';

const MINE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface PatchBody {
  baseRevision?: number;
  chats?: { id: string }[];
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
          chats: [
            { id: MINE, name: this.chatNames.get(MINE), workspacePath: '/a', modelId: 'm', updatedAt: 2, messageCount: 1 },
            { id: THEIRS, name: this.chatNames.get(THEIRS), workspacePath: '/b', modelId: 'm', updatedAt: 2, messageCount: 1 },
          ],
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
        for (const chat of body.chats ?? []) this.chatRevisions.set(chat.id, this.revision);
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

async function bootWindow(store: FakeSessionsStore): Promise<void> {
  setStorageModeForTests('server');
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  store.install();
  await loadSessionsFromStorage({ force: true });
}

describe('multi-window session writes', () => {
  afterEach(() => {
    // @ts-expect-error test cleanup
    delete globalThis.fetch;
    setStorageModeForTests('localStorage');
    resetSessionPersistenceForTests();
    setSessionStateForTests(null);
  });

  test('a conflicted whole-state describe is dropped, not re-based over the other window', async () => {
    const store = new FakeSessionsStore();
    await bootWindow(store);
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
    await bootWindow(store);
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
    await bootWindow(store);
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

    // No conflict on the describe: it lands and bumps the revision itself.
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
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[MINE], 8);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(MINE), true);
    saveSessionsNow();
    assert.equal(store.writes.length, before + 2, 'blocked viewer must not overwrite on another flush');
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
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[THEIRS], 8);
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
    assert.equal(store.writes.at(-1)?.chatBaseRevisions?.[THEIRS], 8);
    assert.equal(getSessionDirtyTrackingForTests().dirtyChatIds.includes(THEIRS), true);
  });
});
