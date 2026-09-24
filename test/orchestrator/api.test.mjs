import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { DEFAULT_BOARD_CONCURRENCY } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { stateFromJSON } from '../../server/orchestrator/core/snapshot.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { appendEvent, resetJournalCache } from '../../server/orchestrator/journal.js';
import { createBoardsMiddleware, matchRoute, ROUTES, setEffectorFactory } from '../../server/orchestrator/middleware.js';
import { getDefaultWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';

const PLAN = `---
name: demo-board
overview: A demo.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
  - id: W1-B
    content: "Wave 1: B"
    status: pending
isProject: true
---

# Demo

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** build alpha
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**

#### Task W1-B: Beta
- **Build:** build beta
- **Test:** test beta
- **Accept:** beta works
- **Touches:** src/beta/**
`;

/** @type {http.Server} */
let server;
/** @type {string} */
let base;
/** @type {string | undefined} */
let previousHome;

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-api-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  disposeEngines();

  setEffectorFactory(() =>
    createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }] }),
  );

  const middleware = createBoardsMiddleware();
  server = http.createServer((req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  disposeEngines();
  await new Promise((resolve) => server.close(resolve));
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  disposeEngines();
});

/**
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
async function call(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
/** @type {any} */
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function createBoard(markdown = PLAN) {
  const created = await call('POST', '/api/boards', { planPath: 'demo.md', markdown });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.boardId;
}

/**
 * @param {string} pathname
 * @param {(frames: Array<{ id?: string, event: string, data: any }>) => boolean} enough
 * @param {Record<string, string>} [headers]
 */
function readSse(pathname, enough, headers = {}) {
  return new Promise((resolve, reject) => {
/** @type {Array<{ id?: string, event: string, data: any }>} */
    const frames = [];
    const request = http.get(`${base}${pathname}`, { headers }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`SSE returned ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (raw.startsWith(':')) continue;
/** @type {any} */
          const frame = {};
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
          }
          frames.push(frame);
          if (enough(frames)) {
            request.destroy();
            resolve(frames);
            return;
          }
        }
      });
      response.on('error', () => resolve(frames));
    });
    request.on('error', (err) => {
      if (frames.length > 0) resolve(frames);
      else reject(err);
    });
    setTimeout(() => {
      request.destroy();
      resolve(frames);
    }, 8_000).unref?.();
  });
}

// ── POST boards ──────────────────────────────────────────────────────────────

describe('POST /api/boards', () => {
  it('creates a board from a plan and returns its derived state', async () => {
    const created = await call('POST', '/api/boards', { planPath: 'demo.md', markdown: PLAN });
    assert.equal(created.status, 201);
    assert.equal(created.body.boardId, 'demo-board');
    const state = stateFromJSON(created.body.state);
    assert.deepEqual([...state.tasks.keys()], ['W1-A', 'W1-B']);
    assert.equal(state.status, 'created');
    assert.deepEqual(state.tasks.get('W1-A').touches, ['src/alpha/**']);
  });

  it('returns 400 with ParseError[] and line numbers, not a 500', async () => {
    const broken = PLAN.replace('- **Touches:** src/beta/**\n', '');
    const response = await call('POST', '/api/boards', { planPath: 'demo.md', markdown: broken });
    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.ok(Array.isArray(response.body.errors));
    assert.ok(response.body.errors.length > 0);
    for (const error of response.body.errors) {
      assert.equal(typeof error.line, 'number');
      assert.ok(error.line >= 1);
      assert.ok(error.message.length > 0);
      assert.ok(error.hint.length > 0);
    }
    assert.match(response.body.detail, /^line \d+:\d+ — /m);
  });

  it('rejects an isolated task that uses another task\'s newly created type', async () => {
    const missingEdge = PLAN
      .replace('- **Build:** build alpha',
        '- **Build:** CREATE `src/alpha/settings.ts` with `export interface GameSettings {}`')
      .replace('- **Touches:** src/alpha/**', '- **Touches:** src/alpha/settings.ts')
      .replace('- **Build:** build beta', '- **Build:** Import GameSettings into beta');
    const response = await call('POST', '/api/boards', {
      planPath: 'demo.md', markdown: missingEdge,
    });
    assert.equal(response.status, 400);
    assert.match(response.body.detail, /task W1-B uses work introduced by W1-A/);
    assert.equal((await call('GET', '/api/boards')).body.boards.length, 0);
  });

  it('returns 400 for garbage rather than creating a half-board', async () => {
    const response = await call('POST', '/api/boards', { planPath: 'x.md', markdown: 'nonsense' });
    assert.equal(response.status, 400);
    assert.equal((await call('GET', '/api/boards')).body.boards.length, 0);
  });

  it('requires a planPath', async () => {
    assert.equal((await call('POST', '/api/boards', {})).status, 400);
  });

  it('refuses to clobber an existing board', async () => {
    await createBoard();
    const again = await call('POST', '/api/boards', { planPath: 'demo.md', markdown: PLAN });
    assert.equal(again.status, 409);
  });

  it('reads the plan from the workspace when markdown is omitted', async () => {
    const root = getDefaultWorkspaceRoot();
    const rel = `documentation/plans/ov2-api-disk-${Date.now()}.md`;
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, PLAN);
    try {
      const created = await call('POST', '/api/boards', { planPath: rel });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.boardId, 'demo-board');
    } finally {
      await fs.unlink(abs).catch(() => {});
    }
  });

  it('returns 400 when the workspace-relative plan file is missing', async () => {
    const response = await call('POST', '/api/boards', {
      planPath: 'documentation/plans/ov2-does-not-exist.md',
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /could not read plan/i);
  });
});

// ── GET boards ───────────────────────────────────────────────────────────────

describe('GET /api/boards', () => {
  it('lists boards with their status', async () => {
    await createBoard();
    const list = await call('GET', '/api/boards');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.boards.map((b) => b.boardId), ['demo-board']);
    assert.equal(list.body.boards[0].taskCount, 2);
    assert.equal(list.body.boards[0].status, 'created');
  });

  it('404s for a board that does not exist', async () => {
    assert.equal((await call('GET', '/api/boards/nope')).status, 404);
    assert.equal((await call('GET', '/api/boards/nope/journal')).status, 404);
    assert.equal((await call('POST', '/api/boards/nope/start', { concurrency: 1 })).status, 404);
  });

  it('serves a state that always equals the fold of its own journal', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 2 });

    const state = await call('GET', `/api/boards/${boardId}`);
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.deepEqual(stateFromJSON(state.body.state), derive(journal.body.events));
  });
});

// ── commands ─────────────────────────────────────────────────────────────────

describe('commands', () => {
  it('starts, changes concurrency, and stops', async () => {
    const boardId = await createBoard();

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 2 });
    assert.equal(started.status, 200);
    assert.equal(stateFromJSON(started.body.state).status, 'running');
    assert.equal(stateFromJSON(started.body.state).concurrency, 2);

    const changed = await call('POST', `/api/boards/${boardId}/concurrency`, { n: 1 });
    assert.equal(stateFromJSON(changed.body.state).concurrency, 1);

    const stopped = await call('POST', `/api/boards/${boardId}/stop`);
    assert.equal(stateFromJSON(stopped.body.state).status, 'stopped');
    assert.equal(stateFromJSON(stopped.body.state).stopReason, 'user');
  });

  it('defaults omitted start concurrency to 2; fold stays 1 until then', async () => {
    const boardId = await createBoard();
    const before = stateFromJSON((await call('GET', `/api/boards/${boardId}`)).body.state);
    assert.equal(before.status, 'created');
    assert.equal(before.concurrency, 1);

    const started = await call('POST', `/api/boards/${boardId}/start`, {});
    assert.equal(started.status, 200);
    const after = stateFromJSON(started.body.state);
    assert.equal(after.status, 'running');
    assert.equal(after.concurrency, DEFAULT_BOARD_CONCURRENCY);
    assert.equal(DEFAULT_BOARD_CONCURRENCY, 2);
  });

  it('rejects a nonsense concurrency', async () => {
    const boardId = await createBoard();
    for (const concurrency of [0, -1, 1.5, 'two', null, 1000]) {
      const response = await call('POST', `/api/boards/${boardId}/start`, { concurrency });
      assert.equal(response.status, 400, JSON.stringify(concurrency));
    }
  });

  it('starts a single task on demand, and 409s when it cannot', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const ok = await call('POST', `/api/boards/${boardId}/tasks/W1-B/start`);
    assert.equal(ok.status, 200);

    const again = await call('POST', `/api/boards/${boardId}/tasks/W1-B/start`);
    assert.equal(again.status, 409);
  });

  it('runs a hand-started task on a stopped board — Manual mode', async () => {
    const boardId = await createBoard();
    const started = await call('POST', `/api/boards/${boardId}/tasks/W1-A/start`);
    assert.equal(started.status, 200);

    const after = await call('GET', `/api/boards/${boardId}`);
    const state = stateFromJSON(after.body.state);
    assert.equal(state.status, 'created');
    assert.equal(state.tasks.get('W1-A').phase, 'building');
    assert.equal(state.tasks.get('W1-A').attempts.at(-1).ended, false);
    assert.equal(state.tasks.get('W1-A').attempts.at(-1).manual, true);
  });

  it('survives four concurrent commands against a cold board', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    disposeEngines();

    const responses = await Promise.all([
      call('POST', `/api/boards/${boardId}/stop`),
      call('POST', `/api/boards/${boardId}/stop`),
      call('POST', `/api/boards/${boardId}/stop`),
      call('POST', `/api/boards/${boardId}/stop`),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(stateFromJSON(response.body.state).status, 'stopped');
    }
  });

  it('serves one engine to concurrent readers and streamers alike', async () => {
    const boardId = await createBoard();
    disposeEngines();

    const [get, stop, journal] = await Promise.all([
      call('GET', `/api/boards/${boardId}`),
      call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 }),
      call('GET', `/api/boards/${boardId}/journal`),
    ]);
    assert.equal(get.status, 200, JSON.stringify(get.body));
    assert.equal(stop.status, 200, JSON.stringify(stop.body));
    assert.equal(journal.status, 200);
  });
});

// ── SSE ──────────────────────────────────────────────────────────────────────

describe('SSE', () => {
  it('opens with a snapshot frame carrying the current seq and state', async () => {
    const boardId = await createBoard();
    const frames = await readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 1);

    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].id, '1');
    assert.equal(frames[0].data.seq, 1);
    const state = stateFromJSON(frames[0].data.state);
    assert.deepEqual([...state.tasks.keys()], ['W1-A', 'W1-B']);
  });

  it('flushes an SSE comment before the snapshot so the client is not stuck connecting', async () => {
    const boardId = await createBoard();
    const firstChunk = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/boards/${boardId}/events`, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`SSE returned ${response.statusCode}`));
          return;
        }
        response.setEncoding('utf8');
        response.once('data', (chunk) => {
          request.destroy();
          resolve(chunk);
        });
      });
      request.on('error', (err) => {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ECONNRESET') return;
        reject(err);
      });
      setTimeout(() => {
        request.destroy();
        reject(new Error('timed out waiting for SSE comment'));
      }, 3_000);
    });
    assert.match(String(firstChunk), /^: connected\n\n/);
  });

  it('streams each subsequent event with its seq as the frame id', async () => {
    const boardId = await createBoard();
    const streamed = readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const frames = await streamed;
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[1].event, 'event');
    assert.equal(frames[1].data.type, 'board.started');
    assert.equal(frames[1].id, String(frames[1].data.seq));
    assert.equal(frames[2].data.type, 'task.attempt.started');
  });

  it('gives two clients connecting mid-run identical sequences from their connect points', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const first = readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 2);
    const second = readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call('POST', `/api/boards/${boardId}/concurrency`, { n: 2 });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0].event, 'snapshot');
    assert.equal(b[0].event, 'snapshot');
    assert.deepEqual(
      a.slice(1).map((f) => f.data.seq),
      b.slice(1).map((f) => f.data.seq),
    );
  });

  it('resumes from Last-Event-ID with exactly the missed tail', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    const journal = (await call('GET', `/api/boards/${boardId}/journal`)).body.events;
    assert.ok(journal.length >= 3, `journal only has ${journal.length} events`);

    const frames = await readSse(
      `/api/boards/${boardId}/events`,
      (f) => f.length >= journal.length - 1,
      { 'Last-Event-ID': '1' },
    );

    assert.equal(frames.every((f) => f.event === 'event'), true, 'a snapshot was re-sent');
    const seqs = frames.map((f) => f.data.seq);
    assert.deepEqual(seqs, journal.slice(1, seqs.length + 1).map((e) => e.seq));
    assert.equal(new Set(seqs).size, seqs.length, 'duplicates in the resumed tail');
    for (let i = 1; i < seqs.length; i += 1) {
      assert.equal(seqs[i], seqs[i - 1] + 1, 'a gap in the resumed tail');
    }
  });

  it('drops the subscriber when a socket is destroyed, and keeps appending', async () => {
    const boardId = await createBoard();

    const request = http.get(`${base}/api/boards/${boardId}/events`);
    await new Promise((resolve) => request.once('response', resolve));
    request.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.ok(journal.body.events.length >= 2);
  });

  it('sends a snapshot whose seq the state actually contains', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const frames = await readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 1);
    const snapshot = frames[0];
    assert.equal(snapshot.event, 'snapshot');

    const journal = (await call('GET', `/api/boards/${boardId}/journal`)).body.events;
    const throughSeq = journal.filter((e) => e.seq <= snapshot.data.seq);
    assert.equal(throughSeq.length, snapshot.data.seq, 'the journal is not gapless');
    assert.deepEqual(
      stateFromJSON(snapshot.data.state),
      derive(throughSeq),
      'the snapshot state is not what its seq says it is',
    );
  });

  it('loses no event appended while a client is connecting', async () => {
    const boardId = await createBoard();
    await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });

    const streamed = readSse(`/api/boards/${boardId}/events`, (f) => f.length >= 12);
    for (let i = 0; i < 12; i += 1) {
      await call('POST', `/api/boards/${boardId}/concurrency`, { n: 1 + (i % 3) });
    }

    const frames = await streamed;
    const snapshot = frames.find((f) => f.event === 'snapshot');
    assert.ok(snapshot, 'no snapshot frame');
    const seen = frames.filter((f) => f.event === 'event').map((f) => f.data.seq);

    const journal = (await call('GET', `/api/boards/${boardId}/journal`)).body.events;
    const expected = journal
      .map((e) => e.seq)
      .filter((seq) => seq > snapshot.data.seq && seq <= Math.max(...seen, snapshot.data.seq));
    assert.deepEqual(seen, expected, 'the stream dropped or duplicated an event');
  });

  it('404s a stream for a board that does not exist', async () => {
    const response = await fetch(`${base}/api/boards/nope/events`);
    assert.equal(response.status, 404);
    await response.text();
  });
});

// ── Surface ──────────────────────────────────────────────────────────────────

describe('the surface itself', () => {
  it('exposes exactly the documented routes', async () => {
    assert.deepEqual(
      ROUTES.map((r) => `${r.method} ${r.name}`).sort(),
      [
        'DELETE delete',
        'GET attempt',
        'GET events',
        'GET get',
        'GET journal',
        'GET list',
        'GET report',
        'GET resumePending',
        'GET taskFiles',
        'PATCH rename',
        'POST abandonTask',
        'POST concurrency',
        'POST create',
        'POST model',
        'POST rerun',
        'POST resetTask',
        'POST resumeResolve',
        'POST rewindTask',
        'POST start',
        'POST startTask',
        'POST stop',
      ],
    );
  });

  it('has no route that writes board state', async () => {
    const lifecycle = new Set(['PATCH rename', 'DELETE delete']);
    for (const route of ROUTES) {
      if (lifecycle.has(`${route.method} ${route.name}`)) continue;
      assert.notEqual(route.method, 'PUT', `${route.name} is a PUT`);
      assert.notEqual(route.method, 'PATCH', `${route.name} is a PATCH`);
      assert.notEqual(route.method, 'DELETE', `${route.name} is a DELETE`);
    }
    assert.equal(ROUTES.some((r) => r.method === 'PUT'), false, 'a PUT exists');

    const boardId = await createBoard();
    assert.equal((await call('PUT', `/api/boards/${boardId}`)).status, 404, 'PUT');
    const bad = await call('PATCH', `/api/boards/${boardId}`, { status: 'running' });
    assert.equal(bad.status, 400);
  });

  it('matches routes exactly, with no prefix surprises', () => {
    assert.equal(matchRoute('GET', '/api/boards')?.name, 'list');
    assert.equal(matchRoute('GET', '/api/boards/b1')?.name, 'get');
    assert.equal(matchRoute('GET', '/api/boards/b1/events')?.name, 'events');
    assert.equal(matchRoute('GET', '/api/boards/b1/report')?.name, 'report');
    assert.equal(matchRoute('POST', '/api/boards/b1/rerun')?.name, 'rerun');
    assert.deepEqual(matchRoute('POST', '/api/boards/b1/tasks/W1-A/start')?.params, ['b1', 'W1-A']);
    assert.equal(matchRoute('GET', '/api/boards/b1/nope'), null);
    assert.equal(matchRoute('POST', '/api/boards/b1'), null);
    assert.equal(matchRoute('GET', '/api/boardsomething'), null);
  });

  it('leaves unrelated paths to the next middleware', async () => {
    const response = await fetch(`${base}/api/something-else`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'not found');
  });

  it('409s rerun when nothing failed', async () => {
    const boardId = await createBoard();
    const response = await call('POST', `/api/boards/${boardId}/rerun`, {});
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'nothing to rerun');
  });

  it('409s start on a finished board', async () => {
    const boardId = await createBoard();
    await appendEvent(boardId, makeEvent('run.finished', { summary: 'done' }));
    disposeEngines();
    const response = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'the run has finished; rerun it instead');
  });
});

// ── Workspace scope ──────────────────────────────────────────────────────────

describe('GET /api/boards — workspace scope (MIN-752)', () => {
  it('lists only boards stamped for the live workspace and 409s start from another', async () => {
    const originalRoot = getDefaultWorkspaceRoot();
    const wsA = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-board-ws-a-'));
    const wsB = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-board-ws-b-'));
    try {
      await setWorkspaceRoot(wsA);
      const createdA = await call('POST', '/api/boards', {
        planPath: 'demo.md',
        markdown: PLAN,
        boardId: 'ws-a-board',
      });
      assert.equal(createdA.status, 201, JSON.stringify(createdA.body));
      assert.equal(createdA.body.state.workspacePath, path.resolve(wsA));

      const listA = await call('GET', '/api/boards');
      assert.deepEqual(listA.body.boards.map((b) => b.boardId), ['ws-a-board']);

      await setWorkspaceRoot(wsB);
      const listBEmpty = await call('GET', '/api/boards');
      assert.deepEqual(listBEmpty.body.boards.map((b) => b.boardId), []);

      const startFromB = await call('POST', '/api/boards/ws-a-board/start', { concurrency: 1 });
      assert.equal(startFromB.status, 409);
      assert.match(String(startFromB.body.error), /another workspace/i);

      const createdB = await call('POST', '/api/boards', {
        planPath: 'demo.md',
        markdown: PLAN,
        boardId: 'ws-b-board',
      });
      assert.equal(createdB.status, 201, JSON.stringify(createdB.body));
      const listB = await call('GET', '/api/boards');
      assert.deepEqual(listB.body.boards.map((b) => b.boardId), ['ws-b-board']);
    } finally {
      await setWorkspaceRoot(originalRoot);
      await fs.rm(wsA, { recursive: true, force: true }).catch(() => {});
      await fs.rm(wsB, { recursive: true, force: true }).catch(() => {});
    }
  });
});
