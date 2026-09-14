/**
 * GET /api/config/sessions/recall/:chatId — recall_history over a persisted chat
 * (context compaction v2, Phase 3): FTS ranking fused with the in-memory BM25.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { rankChatHistoryRows } from '../../server/config/sessions-repo.js';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

const CHAT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OTHER_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeChat(id, history) {
  return {
    id,
    name: 'Recall',
    workspacePath: '/ws/recall',
    modelId: '',
    modeId: 'build',
    history,
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
  };
}

function seedState() {
  const history = [
    { role: 'user', content: 'Refactor the payment reconciliation job' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/jobs/settle.ts"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'export function settleInvoices() { /* batches */ }' },
    { role: 'assistant', content: 'The job settles invoices in batches of 50.' },
    // UI-only: never ranked or read back.
    { role: 'context', policy: 'compact', droppedTurns: 1, summaryText: 'invoices summary', createdAt: 1 },
    { role: 'user', content: 'Now add retries when reconciling fails' },
    { role: 'assistant', content: 'Added exponential retries to the reconciler.' },
  ];
  return {
    version: 6,
    activeId: CHAT_ID,
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
    groups: [],
    chats: [
      makeChat(CHAT_ID, history),
      makeChat(OTHER_ID, [{ role: 'user', content: 'invoices invoices invoices in another chat' }]),
    ],
  };
}

describe('GET /api/config/sessions/recall/:chatId', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-recall-${Date.now()}`);
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
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', seedState());
    assert.equal(put.status, 200);
  });

  test('FTS ranks only this chat, stems terms, and skips UI-only rows', () => {
    const ranked = rankChatHistoryRows(CHAT_ID, 'reconcile invoice');
    // porter: "reconcile" matches reconciliation / reconciling / reconciler.
    assert.ok(ranked.includes(0), `request row ranked: ${ranked}`);
    assert.ok(ranked.includes(3), `answer row ranked: ${ranked}`);
    assert.ok(!ranked.includes(4), 'context row is never ranked');
    for (const seq of ranked) assert.ok(seq < 7, 'no rows from another chat');
  });

  test('query returns hits grouped by turn with #row numbers', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      `/api/config/sessions/recall/${CHAT_ID}?q=${encodeURIComponent('reconciling retries')}`,
    );
    assert.equal(res.status, 200);
    assert.match(res.json.text, /match/);
    assert.match(res.json.text, /> #6 assistant: .*retries/);
    assert.ok(Array.isArray(res.json.ranked) && res.json.ranked.length > 0);
    assert.doesNotMatch(res.json.text, /invoices summary/);
  });

  test('tool-call arguments are found even though the FTS index does not store them', async () => {
    const res = await httpRequest(
      baseUrl,
      'GET',
      `/api/config/sessions/recall/${CHAT_ID}?q=${encodeURIComponent('settle.ts')}`,
    );
    assert.equal(res.status, 200);
    assert.match(res.json.text, /#1 assistant/);
  });

  test('rows returns a verbatim slice', async () => {
    const res = await httpRequest(baseUrl, 'GET', `/api/config/sessions/recall/${CHAT_ID}?rows=2-3`);
    assert.equal(res.status, 200);
    assert.match(res.json.text, /#2 tool read_file src\/jobs\/settle\.ts:\nexport function settleInvoices/);
    assert.match(res.json.text, /#3 assistant:\nThe job settles invoices in batches of 50\./);
  });

  test('an unknown chat reads as no rows, not an error status', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions/recall/ffffffff-ffff-ffff-ffff-ffffffffffff?q=x1');
    assert.equal(res.status, 200);
    assert.match(res.json.text, /^Error: recall_history has no earlier rows/);
  });
});
