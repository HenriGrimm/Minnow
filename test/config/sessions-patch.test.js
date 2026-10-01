/**
 * Phase B.0: PATCH /api/config/sessions — partial upserts, explicit deletes, no-op absents.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closeSessionsDb, getSessionsDb } from '../../server/config/sessions-db.js';
import { appendTerminalRun } from '../../server/config/sessions-repo.js';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

/** Minimal chat row for PATCH/PUT fixtures. */
function makeChat(id, name, extra = {}) {
  return {
    id,
    name,
    workspacePath: '',
    modelId: '',
    modeId: 'build',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
    ...extra,
  };
}

/** Whole-blob SessionState with the given chats. */
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

/** Drop undefined keys for deep compares. */
function canonicalize(value) {
  // revision / chatRevisions are server-owned concurrency counters that every PATCH bumps.
  const { revision: _revision, chatRevisions: _chatRevisions, ...rest } = JSON.parse(JSON.stringify(value));
  return rest;
}

describe('PATCH /api/config/sessions', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-patch-${Date.now()}`);
    server = createConfigTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeSessionsDb();
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    await rmTestHome(homeDir);
  });

  beforeEach(async () => {
    // Reset to a known two-chat blob before each case.
    const seed = makeState([
      makeChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha', {
        history: [{ role: 'user', content: 'alpha-msg' }],
      }),
      makeChat('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta', {
        history: [{ role: 'user', content: 'beta-msg' }],
      }),
    ]);
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', seed);
    assert.equal(put.status, 200);
  });

  test('PATCH one chat leaves others byte-identical', async () => {
    const before = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );
    const betaBefore = before.chats.find((c) => c.id.startsWith('bbbb'));

    const patchedAlpha = makeChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha patched', {
      history: [
        { role: 'user', content: 'alpha-msg' },
        { role: 'assistant', content: 'reply' },
      ],
      updatedAt: 1_700_000_000_100,
      lastMessageAt: 1_700_000_000_100,
    });

    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [patchedAlpha],
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.ok, true);
    assert.equal(patch.json.applied.chats, 1);
    assert.equal(patch.json.applied.deletedChats, 0);
    assert.equal(patch.json.applied.groups, 0);
    assert.equal(patch.json.applied.scalars, false);

    const after = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );
    const betaAfter = after.chats.find((c) => c.id.startsWith('bbbb'));
    assert.deepEqual(betaAfter, betaBefore);

    const alphaAfter = after.chats.find((c) => c.id.startsWith('aaaa'));
    assert.equal(alphaAfter.name, 'Alpha patched');
    assert.equal(alphaAfter.history.length, 2);
  });

  test('deleteChatIds removes chat and cascades child rows', async () => {
    const alphaId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    appendTerminalRun(alphaId, {
      id: 'term-1',
      command: 'echo hi',
      cwd: 'C:/tmp',
      source: 'agent',
      startedAt: 1,
      finishedAt: 2,
      timedOut: false,
      logPath: '',
    });

    const db = getSessionsDb();
    const termBefore = db
      .prepare('SELECT COUNT(*) AS n FROM chat_terminal_history WHERE chat_id = ?')
      .get(alphaId);
    assert.equal(termBefore.n, 1);
    const msgBefore = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(alphaId);
    assert.ok(msgBefore.n >= 1);

    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      deleteChatIds: [alphaId],
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.applied.deletedChats, 1);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(
      after.chats.some((c) => c.id === alphaId),
      false,
    );
    assert.equal(after.chats.length, 1);
    assert.equal(after.activeId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

    const termAfter = db
      .prepare('SELECT COUNT(*) AS n FROM chat_terminal_history WHERE chat_id = ?')
      .get(alphaId);
    assert.equal(termAfter.n, 0);
    const msgAfter = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(alphaId);
    assert.equal(msgAfter.n, 0);
  });

  test('absent keys are no-ops', async () => {
    const before = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );

    const empty = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.applied, {
      chats: 0,
      deletedChats: 0,
      groups: 0,
      deletedGroups: 0,
      scalars: false,
    });

    const afterEmpty = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );
    assert.deepEqual(afterEmpty, before);

    // Scalars omitted → activeId / sidebar unchanged even when chats patch.
    const patchChatOnly = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [
        makeChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha again', {
          history: [{ role: 'user', content: 'alpha-msg' }],
        }),
      ],
    });
    assert.equal(patchChatOnly.status, 200);
    const afterChat = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(afterChat.activeId, before.activeId);
    assert.equal(afterChat.sidebarCollapsed, before.sidebarCollapsed);
  });

  test('unknown chat id inserts', async () => {
    const gamma = makeChat('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Gamma', {
      history: [{ role: 'user', content: 'gamma-msg' }],
    });
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [gamma],
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.applied.chats, 1);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    assert.equal(after.chats.length, 3);
    const inserted = after.chats.find((c) => c.id === gamma.id);
    assert.ok(inserted);
    assert.equal(inserted.name, 'Gamma');
    assert.equal(inserted.history[0].content, 'gamma-msg');
    // Pre-existing chats still present.
    assert.ok(after.chats.some((c) => c.id.startsWith('aaaa')));
    assert.ok(after.chats.some((c) => c.id.startsWith('bbbb')));
  });

  test('scalars patch updates activeId without touching chats', async () => {
    const before = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      scalars: { activeId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.applied.scalars, true);
    assert.equal(patch.json.applied.chats, 0);

    const after = canonicalize(
      (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json,
    );
    assert.equal(after.activeId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.deepEqual(after.chats, before.chats);
  });

  test('metadata-only PATCH without history preserves existing messages', async () => {
    const betaId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const metaOnly = {
      id: betaId,
      name: 'Beta renamed',
      workspacePath: '',
      modelId: '',
      modeId: 'build',
      lastStats: null,
      modelInfo: {},
      updatedAt: 1_700_000_000_200,
      lastMessageAt: 1_700_000_000_200,
    };

    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [metaOnly],
    });
    assert.equal(patch.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const beta = after.chats.find((c) => c.id === betaId);
    assert.equal(beta.name, 'Beta renamed');
    assert.equal(beta.history.length, 1);
    assert.equal(beta.history[0].content, 'beta-msg');
  });

  test('whole-blob PUT omits history for one chat and preserves its messages', async () => {
    // Simulates C.2 first-save after lazy boot: active chat has history, others omit it.
    const alphaId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const betaId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const alpha = makeChat(alphaId, 'Alpha kept', {
      history: [{ role: 'user', content: 'alpha-msg' }],
      updatedAt: 1_700_000_000_300,
      lastMessageAt: 1_700_000_000_300,
    });
    const betaMeta = {
      id: betaId,
      name: 'Beta meta-only',
      workspacePath: '',
      modelId: '',
      modeId: 'build',
      lastStats: null,
      modelInfo: {},
      updatedAt: 1_700_000_000_300,
      lastMessageAt: 1_700_000_000_300,
    };
    const put = await httpRequest(
      baseUrl,
      'PUT',
      '/api/config/sessions',
      makeState([alpha, betaMeta]),
    );
    assert.equal(put.status, 200);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const beta = after.chats.find((c) => c.id === betaId);
    assert.equal(beta.name, 'Beta meta-only');
    assert.equal(beta.history.length, 1);
    assert.equal(beta.history[0].content, 'beta-msg');
    const alphaAfter = after.chats.find((c) => c.id === alphaId);
    assert.equal(alphaAfter.history[0].content, 'alpha-msg');
  });

  test('POST is a sendBeacon alias for PATCH', async () => {
    const patched = makeChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha via POST', {
      history: [{ role: 'user', content: 'alpha-msg' }],
    });
    const post = await httpRequest(baseUrl, 'POST', '/api/config/sessions', {
      baseVersion: 6,
      chats: [patched],
    });
    assert.equal(post.status, 200);
    assert.equal(post.json.ok, true);
    assert.equal(post.json.applied.chats, 1);

    const after = (await httpRequest(baseUrl, 'GET', '/api/config/sessions')).json;
    const alpha = after.chats.find((c) => c.id.startsWith('aaaa'));
    assert.equal(alpha.name, 'Alpha via POST');
  });
});
