/**
 * Phase C.2: GET /api/config/sessions/search — FTS5 match/ranking/scope + mirror sync after truncate.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closeSessionsDb, getSessionsDb } from '../../server/config/sessions-db.js';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

function makeChat(id, name, extra = {}) {
  return {
    id,
    name,
    workspacePath: extra.workspacePath ?? '',
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

describe('GET /api/config/sessions/search (FTS5)', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-search-${Date.now()}`);
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
    const seed = makeState([
      makeChat('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Alpha Login Flow', {
        workspacePath: '/ws/alpha',
        history: [
          { role: 'user', content: 'please fix the login validation' },
          { role: 'assistant', content: 'I updated the login form validators' },
        ],
      }),
      makeChat('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Cooking', {
        workspacePath: '/ws/beta',
        history: [
          { role: 'user', content: 'garlic pasta recipe ideas' },
          { role: 'assistant', content: 'try a simple aglio e olio' },
        ],
      }),
      makeChat('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Empty', {
        workspacePath: '/ws/alpha',
        history: [],
      }),
    ]);
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', seed);
    assert.equal(put.status, 200);
  });

  test('matches message body via FTS and returns chatId + snippet', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/config/sessions/search?q=login%20validation',
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.results));
    assert.ok(res.json.results.length >= 1);
    const hit = res.json.results[0];
    assert.equal(hit.chatId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(hit.matchedIn, 'message');
    assert.match(String(hit.snippet), /login/i);
  });

  test('title hits outrank message hits for the same chat', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions/search?q=Alpha');
    assert.equal(res.status, 200);
    const alpha = res.json.results.find((r) => r.chatId.startsWith('aaaa'));
    assert.ok(alpha);
    assert.equal(alpha.matchedIn, 'title');
    assert.ok(alpha.score >= 200);
  });

  test('message-only results keep the matching transcript index when the title also matches', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions/search?q=login&match=message&workspace=/ws/alpha');
    assert.equal(res.status, 200);
    const hit = res.json.results.find(row => row.chatId === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(hit?.matchedIn, 'message');
    assert.ok(Number.isSafeInteger(hit.messageIndex) && hit.messageIndex >= 0);
    assert.match(hit.snippet, /login/i);
  });

  test('workspace scope limits results', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      '/api/config/sessions/search?q=garlic&workspace=/ws/beta',
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.results.length, 1);
    assert.equal(res.json.results[0].chatId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.equal(res.json.results[0].workspacePath, '/ws/beta');
  });

  test('FTS mirror stays in sync after history truncate', async () => {
    const chatId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    // Truncate to a single user message that no longer mentions "validators".
    const truncated = makeState([
      makeChat(chatId, 'Alpha Login Flow', {
        workspacePath: '/ws/alpha',
        history: [{ role: 'user', content: 'please fix the login form' }],
      }),
      makeChat('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Beta Cooking', {
        workspacePath: '/ws/beta',
        history: [{ role: 'user', content: 'garlic pasta recipe ideas' }],
      }),
    ]);
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', truncated);
    assert.equal(put.status, 200);

    const db = getSessionsDb();
    const ftsCount = db
      .prepare('SELECT COUNT(*) AS n FROM messages_fts WHERE chat_id = ?')
      .get(chatId).n;
    assert.equal(ftsCount, 1);

    const stale = await httpRequest(
      baseUrl,
      'GET',
      '/api/config/sessions/search?q=validators',
    );
    assert.equal(stale.status, 200);
    assert.equal(
      stale.json.results.filter((r) => r.chatId === chatId).length,
      0,
      'truncated history must drop old FTS rows',
    );

    const alive = await httpRequest(
      baseUrl,
      'GET',
      '/api/config/sessions/search?q=login%20form',
    );
    assert.ok(alive.json.results.some((r) => r.chatId === chatId));
  });
});
