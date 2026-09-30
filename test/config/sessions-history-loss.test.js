/**
 * Regression cover for the session transcript wipe.
 *
 * Every chat that predated 2026-08-09 lost its messages while its chat row, runs
 * and timestamps survived, leaving 12k orphaned messages_fts rows behind. The
 * cause was a whole-blob PUT that deleted chats it did not list, plus a re-upsert
 * that recreated them from a payload which omitted `history`.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closeSessionsDb, getSessionsDb } from '../../server/config/sessions-db.js';
import { readSessionRevision } from '../../server/config/sessions-repo.js';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

const ALPHA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeChat(id, name, history = []) {
  return {
    id,
    name,
    workspacePath: '',
    modelId: '',
    modeId: 'build',
    history,
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
  };
}

function makeState(chats, extra = {}) {
  return {
    version: 6,
    activeId: chats[0]?.id ?? '',
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
    groups: [],
    chats,
    ...extra,
  };
}

/** A chat as the client wires it while its history is still lazily unloaded. */
function withoutHistory(chat) {
  const { history: _history, ...rest } = chat;
  void _history;
  return rest;
}

function messageCount(chatId) {
  return getSessionsDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
    .get(chatId).n;
}

describe('sessions history loss regressions', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-loss-${Date.now()}`);
    server = createConfigTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeSessionsDb();
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    await rmTestHome(homeDir);
  });

  beforeEach(async () => {
    const seeded = makeState([
      makeChat(ALPHA, 'Alpha', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ]),
      makeChat(BETA, 'Beta', [{ role: 'user', content: 'beta only' }]),
    ]);
    const res = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', seeded);
    assert.equal(res.status, 200);
  });

  test('PUT that omits a chat does not delete it', async () => {
    // A client booted lazily, or one whose load degraded, holds a short list.
    const partial = makeState([makeChat(ALPHA, 'Alpha', [{ role: 'user', content: 'hello' }])]);
    const res = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', partial);
    assert.equal(res.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const beta = after.chats.find((c) => c.id === BETA);
    assert.ok(beta, 'chat missing from the payload must survive');
    assert.equal(beta.history.length, 1);
  });

  test('PUT deletes only the ids it names', async () => {
    const res = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', {
      ...makeState([makeChat(ALPHA, 'Alpha', [{ role: 'user', content: 'hello' }])]),
      deleteChatIds: [BETA],
    });
    assert.equal(res.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(
      after.chats.some((c) => c.id === BETA),
      false,
    );
    assert.equal(messageCount(BETA), 0);
  });

  test('deleting a chat sweeps its FTS rows', async () => {
    const db = getSessionsDb();
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE chat_id = ?')
      .get(ALPHA).n;
    assert.ok(before > 0, 'seed should have indexed rows');

    await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      deleteChatIds: [ALPHA],
    });

    const orphaned = db
      .prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE chat_id = ?')
      .get(ALPHA).n;
    assert.equal(orphaned, 0, 'FTS rows must not outlive the chat');
  });

  test('a history-omitting write cannot resurrect a deleted chat as empty', async () => {
    await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      deleteChatIds: [ALPHA],
    });

    // The other window still holds ALPHA in memory, unhydrated, and flushes it.
    const res = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [withoutHistory(makeChat(ALPHA, 'Alpha'))],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.applied.chats, 0, 'empty resurrection must be refused');

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(
      after.chats.some((c) => c.id === ALPHA),
      false,
      'a chat with no recoverable history must not come back blank',
    );
  });

  test('PUT preserves messages for chats that omit history', async () => {
    const res = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', {
      ...makeState([
        withoutHistory(makeChat(ALPHA, 'Alpha renamed')),
        withoutHistory(makeChat(BETA, 'Beta')),
      ]),
    });
    assert.equal(res.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(after.chats.find((c) => c.id === ALPHA).history.length, 2);
    assert.equal(after.chats.find((c) => c.id === ALPHA).name, 'Alpha renamed');
    assert.equal(after.chats.find((c) => c.id === BETA).history.length, 1);
  });

  test('a stale baseRevision is rejected instead of overwriting', async () => {
    const stale = readSessionRevision();

    // Another window writes first.
    const first = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      baseRevision: stale,
      chats: [makeChat(BETA, 'Beta from window two', [{ role: 'user', content: 'newer' }])],
    });
    assert.equal(first.status, 200);

    const conflict = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      baseRevision: stale,
      chats: [makeChat(BETA, 'Beta from window one', [])],
    });
    assert.equal(conflict.status, 409);
    assert.equal(typeof conflict.json.revision, 'number');

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const beta = after.chats.find((c) => c.id === BETA);
    assert.equal(beta.name, 'Beta from window two');
    assert.equal(beta.history.length, 1, 'the losing write must not have landed');
  });

  test('rebasing a stale write cannot overwrite the same chat or revive a deletion', async () => {
    const summaries = (await httpRequest(baseUrl, 'GET', '/api/config/sessions/summaries')).json;
    const baseRevision = summaries.revision;
    const betaRevision = summaries.chatRevisions[BETA];

    const first = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6, baseRevision, chatBaseRevisions: { [BETA]: betaRevision },
      chats: [makeChat(BETA, 'Newer transcript', [{ role: 'user', content: 'newer turn' }])],
    });
    assert.equal(first.status, 200);

    const stale = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6, baseRevision: first.json.revision,
      chatBaseRevisions: { [BETA]: betaRevision },
      chats: [makeChat(BETA, 'Stale transcript', [{ role: 'user', content: 'stale turn' }])],
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.json.conflictingChatIds, [BETA]);
    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(after.chats.find((chat) => chat.id === BETA).name, 'Newer transcript');

    const deleteRevision = first.json.revision;
    const deleted = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6, baseRevision: deleteRevision,
      chatBaseRevisions: { [BETA]: first.json.revision }, deleteChatIds: [BETA],
    });
    assert.equal(deleted.status, 200);
    const resurrect = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6, baseRevision: deleted.json.revision,
      chatBaseRevisions: { [BETA]: first.json.revision },
      chats: [makeChat(BETA, 'Revived', [{ role: 'user', content: 'old' }])],
    });
    assert.equal(resurrect.status, 409);
    assert.deepEqual(resurrect.json.conflictingChatIds, [BETA]);
  });

  test('whole-blob pruning stamps a tombstone and requires the deleted chat base', async () => {
    const summaries = (await httpRequest(baseUrl, 'GET', '/api/config/sessions/summaries')).json;
    const baseRevision = summaries.revision;
    const betaRevision = summaries.chatRevisions[BETA];
    const alphaRevision = summaries.chatRevisions[ALPHA];

    const missingBase = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', {
      ...makeState([makeChat(ALPHA, 'Alpha')]), pruneMissingChats: true,
      baseRevision, chatBaseRevisions: { [ALPHA]: alphaRevision },
    });
    assert.equal(missingBase.status, 409);
    assert.deepEqual(missingBase.json.conflictingChatIds, [BETA]);

    const pruned = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', {
      ...makeState([makeChat(ALPHA, 'Alpha')]), pruneMissingChats: true,
      baseRevision, chatBaseRevisions: { [ALPHA]: alphaRevision, [BETA]: betaRevision },
    });
    assert.equal(pruned.status, 200);
    const staleRecreate = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6, baseRevision: pruned.json.revision,
      chatBaseRevisions: { [BETA]: betaRevision },
      chats: [makeChat(BETA, 'Stale Beta', [{ role: 'user', content: 'old' }])],
    });
    assert.equal(staleRecreate.status, 409);
    assert.deepEqual(staleRecreate.json.conflictingChatIds, [BETA]);
  });

  test('writes without a baseRevision still apply', async () => {
    const res = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [makeChat(BETA, 'Beta unversioned', [{ role: 'user', content: 'beta only' }])],
    });
    assert.equal(res.status, 200);
    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(after.chats.find((c) => c.id === BETA).name, 'Beta unversioned');
  });

  test('two views on two workspaces never drop rows belonging to the other', async () => {
    // A folder opens in exactly one view, so the two writers own disjoint chats.
    // They still share one global revision counter, which is why a losing writer
    // has to re-base and re-send rather than give up.
    const seeded = readSessionRevision();

    const windowOne = httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      baseRevision: seeded,
      chats: [
        makeChat(ALPHA, 'Alpha in workspace A', [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'from A' },
        ]),
      ],
    });
    const windowTwo = httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      baseRevision: seeded,
      chats: [
        makeChat(BETA, 'Beta in workspace B', [
          { role: 'user', content: 'beta only' },
          { role: 'user', content: 'from B' },
        ]),
      ],
    });

    const results = await Promise.all([windowOne, windowTwo]);
    const conflicted = results.filter((r) => r.status === 409);
    const applied = results.filter((r) => r.status === 200);
    assert.equal(applied.length + conflicted.length, 2);
    assert.ok(applied.length >= 1, 'at least one concurrent write must land');

    // Whoever lost re-bases onto the reported revision and re-sends the identical
    // body — which is exactly what the client's `sendSessionsWrite` does.
    for (const loser of conflicted) {
      const isAlpha = loser === results[0];
      const retry = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
        baseVersion: 6,
        baseRevision: loser.json.revision,
        chats: [
          isAlpha
            ? makeChat(ALPHA, 'Alpha in workspace A', [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' },
                { role: 'user', content: 'from A' },
              ])
            : makeChat(BETA, 'Beta in workspace B', [
                { role: 'user', content: 'beta only' },
                { role: 'user', content: 'from B' },
              ]),
        ],
      });
      assert.equal(retry.status, 200);
    }

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const alpha = after.chats.find((c) => c.id === ALPHA);
    const beta = after.chats.find((c) => c.id === BETA);
    assert.equal(alpha.name, 'Alpha in workspace A');
    assert.equal(alpha.history.length, 3);
    assert.equal(beta.name, 'Beta in workspace B');
    assert.equal(beta.history.length, 2);
    assert.equal(messageCount(ALPHA), 3);
    assert.equal(messageCount(BETA), 2);
  });

  test('a concurrent writer cannot prune chats belonging to the other view', async () => {
    // The upsert-only rule and the pruneMissingChats guard are what stopped the
    // 2026-08 wipe; a second concurrent writer is precisely what they defend
    // against. Window two writes only its own chat and must not touch Alpha.
    const res = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', {
      ...makeState([makeChat(BETA, 'Beta alone', [{ role: 'user', content: 'beta only' }])]),
    });
    assert.equal(res.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const alpha = after.chats.find((c) => c.id === ALPHA);
    assert.ok(alpha, 'a chat owned by the other view must survive a write that omits it');
    assert.equal(alpha.history.length, 2);
    assert.equal(messageCount(ALPHA), 2);
  });

  test('summaries expose the revision clients echo back', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions/summaries');
    assert.equal(res.status, 200);
    assert.equal(res.json.revision, readSessionRevision());
    assert.equal(typeof res.json.chatRevisions[ALPHA], 'number');
    const full = await httpRequest(baseUrl, 'GET', '/api/config/sessions');
    assert.equal(full.json.revision, res.json.revision);
    assert.equal(full.json.chatRevisions[ALPHA], res.json.chatRevisions[ALPHA]);
  });
});
