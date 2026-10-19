/**
 * Session summaries carry run stubs and leave out per-chat detail; the history
 * route sends it with `detail=1`. Saves from a window that never opened a chat
 * (history omitted, run stubs) must keep every stored record.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { after, before, beforeEach, describe, test } from 'node:test';

import { mergeOmittedChatDetail, slimChatSummary } from '../../server/config/chat-detail.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

const CHAT = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function fullRun(runId, status, createdAt) {
  return {
    runId,
    branchId: `branch-${runId}`,
    forkHistoryIndex: 0,
    status,
    createdAt,
    snapshot: { files: ['a.ts'], note: `snapshot ${runId}` },
    outputMessages: [{ role: 'assistant', content: `output of ${runId}` }],
    generationIds: [`gen-${runId}`],
  };
}

function seedChat(extra = {}) {
  return {
    id: CHAT,
    name: 'Detail',
    workspacePath: '/ws/detail',
    modelId: '',
    modeId: 'build',
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
    runs: [fullRun('run-1', 'completed', 1), fullRun('run-2', 'running', 2)],
    subAgentRuns: [{ runId: 'sub-1', status: 'done', transcript: [{ role: 'assistant', content: 'child' }] }],
    tokenLedger: { entries: [{ id: 'e1', totalTokens: 10 }], totals: { totalTokens: 10 }, bySource: {} },
    injectedContext: { 'code-map': 'map body' },
    runnerTiming: { startedAt: 1, events: [], totals: {}, dropped: 0 },
    ...extra,
  };
}

function state(chats) {
  return {
    version: 6,
    activeId: chats[0]?.id ?? '',
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
    groups: [],
    chats,
  };
}

/** What a window that never opened the chat sends: its summary, minus history. */
function summaryWrite(summary, extra = {}) {
  const { messageCount: _c, lastMessagePreview: _p, historyDigest: _d, sortIndex: _s, ...chat } = summary;
  return { ...chat, ...extra };
}

describe('session summaries and chat detail', () => {
  let homeDir;
  let server;
  let baseUrl;
  let savedStore;

  before(async () => {
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-detail-${Date.now()}`);
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
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/sessions', state([seedChat()]));
    assert.equal(put.status, 200);
  });

  async function summary() {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions/summaries');
    assert.equal(res.status, 200);
    return res.json.chats.find((chat) => chat.id === CHAT);
  }

  async function stored() {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/sessions');
    return res.json.chats.find((chat) => chat.id === CHAT);
  }

  test('summaries keep run stubs and the token ledger, and leave the rest of the detail out', async () => {
    const chat = await summary();
    assert.deepEqual(chat.runs.map((run) => [run.runId, run.status]), [['run-1', 'completed'], ['run-2', 'running']]);
    for (const run of chat.runs) {
      assert.equal('snapshot' in run, false);
      assert.equal('outputMessages' in run, false);
      assert.equal('generationIds' in run, false);
    }
    assert.deepEqual(chat.tokenLedger.totals, { totalTokens: 10 });
    for (const key of ['subAgentRuns', 'terminalHistory', 'injectedContext', 'runnerTiming']) {
      assert.equal(key in chat, false, key);
    }
  });

  test('the history route sends the full detail with detail=1, and only then', async () => {
    const plain = await httpRequest(baseUrl, 'GET', `/api/config/sessions/history/${CHAT}`);
    assert.equal('detail' in plain.json, false);
    const res = await httpRequest(baseUrl, 'GET', `/api/config/sessions/history/${CHAT}?detail=1`);
    assert.equal(res.json.history.length, 2);
    const { detail } = res.json;
    assert.deepEqual(detail.runs.map((run) => run.snapshot.note), ['snapshot run-1', 'snapshot run-2']);
    assert.equal(detail.subAgentRuns[0].runId, 'sub-1');
    assert.deepEqual(detail.injectedContext, { 'code-map': 'map body' });
    assert.equal(detail.runnerTiming.startedAt, 1);
  });

  test('saving an unopened chat from its summary keeps every stored record', async () => {
    const chat = await summary();
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [summaryWrite(chat, { name: 'Renamed' })],
    });
    assert.equal(patch.status, 200);
    assert.equal(patch.json.applied.chats, 1);

    const after = await stored();
    assert.equal(after.name, 'Renamed');
    assert.equal(after.history.length, 2);
    assert.deepEqual(after.runs.map((run) => run.outputMessages[0].content), ['output of run-1', 'output of run-2']);
    assert.deepEqual(after.runs.map((run) => run.snapshot.note), ['snapshot run-1', 'snapshot run-2']);
    assert.equal(after.subAgentRuns[0].runId, 'sub-1');
    assert.deepEqual(after.injectedContext, { 'code-map': 'map body' });
    assert.equal(after.runnerTiming.startedAt, 1);
    assert.deepEqual(after.tokenLedger.totals, { totalTokens: 10 });
  });

  test('a run stub updates status without erasing the stored copy, even on a write with history', async () => {
    const chat = await summary();
    const runs = chat.runs.map((run) => (run.runId === 'run-2' ? { ...run, status: 'completed', endedAt: 3 } : run));
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [{ ...summaryWrite(chat), runs, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }],
    });
    assert.equal(patch.status, 200);
    const after = await stored();
    const run2 = after.runs.find((run) => run.runId === 'run-2');
    assert.equal(run2.status, 'completed');
    assert.equal(run2.endedAt, 3);
    assert.equal(run2.snapshot.note, 'snapshot run-2');
    assert.equal(run2.outputMessages[0].content, 'output of run-2');
  });

  test('a client that opened the chat without fetching its detail cannot drop injected context', async () => {
    const chat = await summary();
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [{ ...summaryWrite(chat), history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }],
    });
    assert.equal(patch.status, 200);
    const after = await stored();
    assert.deepEqual(after.injectedContext, { 'code-map': 'map body' });
    assert.equal(after.runnerTiming.startedAt, 1);
    assert.equal(after.runs.length, 2);
    assert.equal(after.runs[0].snapshot.note, 'snapshot run-1');
  });

  test('an opened chat still prunes runs it no longer lists', async () => {
    const full = await stored();
    const patch = await httpRequest(baseUrl, 'PATCH', '/api/config/sessions', {
      baseVersion: 6,
      chats: [{ ...full, runs: full.runs.filter((run) => run.runId === 'run-1') }],
    });
    assert.equal(patch.status, 200);
    assert.deepEqual((await stored()).runs.map((run) => run.runId), ['run-1']);
  });

  test('large answers are gzipped for clients that accept it', async () => {
    const big = 'x'.repeat(80 * 1024);
    await httpRequest(baseUrl, 'PUT', '/api/config/sessions', state([seedChat({ name: big })]));
    const res = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/config/sessions/summaries`, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(res.headers['content-encoding'], 'gzip');
    const json = JSON.parse(zlib.gunzipSync(res.body).toString('utf8'));
    assert.equal(json.chats[0].name, big);

    const history = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/config/sessions/history/${CHAT}?detail=1`, { headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(history.headers['content-encoding'], undefined, 'small answers stay uncompressed');
    assert.equal(JSON.parse(history.body.toString('utf8')).detail.runs.length, 2);
  });
});

describe('chat detail helpers (JSON store)', () => {
  test('slimChatSummary drops detail and stubs runs', () => {
    const slim = slimChatSummary(seedChat());
    assert.equal('snapshot' in slim.runs[0], false);
    assert.equal('subAgentRuns' in slim, false);
    assert.ok(slim.tokenLedger);
  });

  test('mergeOmittedChatDetail keeps stored detail and merges run stubs', () => {
    const prior = seedChat();
    const incoming = slimChatSummary(prior);
    incoming.runs = [{ ...incoming.runs[1], status: 'completed' }, { runId: 'run-3', status: 'running', createdAt: 4, snapshot: {} }];
    const merged = mergeOmittedChatDetail(incoming, prior);
    assert.deepEqual(merged.runs.map((run) => [run.runId, run.status]), [['run-1', 'completed'], ['run-2', 'completed'], ['run-3', 'running']]);
    assert.equal(merged.runs[1].snapshot.note, 'snapshot run-2');
    assert.equal(merged.subAgentRuns[0].runId, 'sub-1');
    assert.deepEqual(merged.injectedContext, { 'code-map': 'map body' });
  });
});
