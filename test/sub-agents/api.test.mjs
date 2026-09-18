/**
 * P8-F — `/api/agents` REST and SSE (MIN-759).
 *
 * Driven through a real HTTP server, same as `test/orchestrator/api.test.mjs`:
 * reconnect with `Last-Event-ID`, live frames with no `seq`, and spawn
 * preflight (P9-A) so an unresolvable model is a 400 at the spawn site.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { emitLive } from '../../server/orchestrator/live-events.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  createAgentsMiddleware,
  matchRoute,
  MUTATING_ROUTES,
  resetAgentsMiddlewareForTests,
  ROUTES,
  setAgentsEffectorFactory,
} from '../../server/sub-agents/middleware.js';
import { resetProductionDelivery } from '../../server/sub-agents/runtime.js';
import { appendEvents } from '../../server/sub-agents/journal.js';
import { makeEvent } from '../../server/sub-agents/events.js';

const PARENT = 'chat-p8f-api';
const CWD = '/tmp/p8f-workspace';
const NO_MODEL =
  'no model bound for this attempt: set Settings → Autopilot planner model, or select a model in the menubar';

/** @type {http.Server} */
let server;
/** @type {string} */
let base;
/** @type {string | undefined} */
let previousHome;

function hangingEffector() {
  /** @type {Map<string, { taskId: string | null, role: string, attemptId: string }>} */
  const running = new Map();
  let n = 0;
  return {
    inspect: () => [...running.values()],
    async preflight() {},
    async start(want) {
      const attemptId = `e-${(n += 1)}`;
      running.set(attemptId, { taskId: want.taskId, role: want.role, attemptId });
      return { attemptId };
    },
    async stop(attemptId) {
      running.delete(attemptId);
    },
    onEnd() {},
  };
}

function noModelEffector() {
  return {
    inspect: () => [],
    async preflight() {
      throw new Error(NO_MODEL);
    },
    async start() {
      throw new Error('start must not run when preflight failed');
    },
    async stop() {},
    onEnd() {},
  };
}

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-agents-api-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetProductionDelivery();
  resetAgentsMiddlewareForTests();
  setAgentsEffectorFactory(() => hangingEffector());

  const middleware = createAgentsMiddleware();
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
  resetAgentsMiddlewareForTests();
  resetProductionDelivery();
  await new Promise((resolve) => server.close(resolve));
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetAgentsMiddlewareForTests();
  resetProductionDelivery();
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

async function spawnOk(extra = {}) {
  const created = await call('POST', '/api/agents', {
    type: 'explore',
    task: 'list files',
    parentChatId: PARENT,
    cwd: CWD,
    ...extra,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
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

/**
 * Read until the server ends the SSE (MIN-584). Do not destroy() on the first
 * frames — a leaked stream never emits `end`.
 *
 * @param {string} pathname
 */
function readSseUntilEnd(pathname) {
  return new Promise((resolve, reject) => {
    /** @type {Array<{ id?: string, event: string, data: any }>} */
    const frames = [];
    const request = http.get(`${base}${pathname}`, (response) => {
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
        }
      });
      response.on('end', () => resolve({ frames, ended: true }));
      response.on('error', (err) => reject(err));
    });
    request.on('error', reject);
    setTimeout(() => {
      request.destroy();
      reject(new Error('SSE did not end within 8s'));
    }, 8_000).unref?.();
  });
}

// ── POST /api/agents spawn ───────────────────────────────────────────────────

describe('POST /api/agents spawn 400 without model', () => {
  it('refuses spawn at the command boundary when preflight has no model', async () => {
    setAgentsEffectorFactory(() => noModelEffector());
    const created = await call('POST', '/api/agents', {
      type: 'explore',
      task: 'list files',
      parentChatId: PARENT,
      cwd: CWD,
    });
    assert.equal(created.status, 400);
    assert.match(String(created.body?.error ?? ''), /no model bound for this attempt/);
  });
});

// ── POST /api/agents spawn ok ────────────────────────────────────────────────

describe('POST /api/agents spawn ok', () => {
  it('spawns a run and returns derived state', async () => {
    const body = await spawnOk({ parentTurnId: 'turn-1' });
    assert.equal(typeof body.runId, 'string');
    assert.ok(body.runId.length > 0);
    assert.ok(body.status === 'queued' || body.status === 'running');
    assert.equal(body.run?.type, 'explore');
    assert.equal(body.run?.parentChatId, PARENT);
    assert.equal(body.run?.parentTurnId, 'turn-1');
  });
});

// ── GET /api/agents list ─────────────────────────────────────────────────────

describe('GET /api/agents list', () => {
  it('requires parentChatId', async () => {
    const listed = await call('GET', '/api/agents');
    assert.equal(listed.status, 400);
  });

  it('returns derived state for one chat', async () => {
    const spawned = await spawnOk();
    const listed = await call('GET', `/api/agents?parentChatId=${PARENT}`);
    assert.equal(listed.status, 200);
    const runs = listed.body?.state?.runs ?? [];
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, spawned.runId);
  });
});

// ── POST /api/agents/:runId/cancel ───────────────────────────────────────────

describe('POST /api/agents/:runId/cancel', () => {
  it('cancels an in-flight run', async () => {
    const spawned = await spawnOk();
    const cancelled = await call('POST', `/api/agents/${spawned.runId}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    const got = await call('GET', `/api/agents/${spawned.runId}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.status, 'cancelled');
  });

  it('settles a cancelling attempt left open by a previous process', async () => {
    const runId = 'cancelled-before-restart';
    await appendEvents(PARENT, [
      makeEvent('run.requested', {
        runId,
        agentType: 'explore',
        task: 'inspect files',
        parentChatId: PARENT,
        cwd: CWD,
        requestedAt: 1,
      }),
      makeEvent('attempt.started', {
        runId,
        attemptId: 'sa-before-restart',
        seedKind: 'initial',
        seed: { kind: 'initial' },
      }),
      makeEvent('run.cancelled', { runId, reason: 'user' }),
    ]);

    const cancelled = await call('POST', `/api/agents/${runId}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.state.runs[0].phase, 'cancelled');

    const journal = (await call('GET', `/api/agents/${runId}/journal`)).body.events;
    const ended = journal.filter((event) => event.type === 'attempt.ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].attemptId, 'sa-before-restart');
    assert.equal(ended[0].outcome, 'crashed');
  });
});

// ── GET /api/agents/:runId/events ────────────────────────────────────────────

describe('GET /api/agents/:runId/events SSE live vs journal', () => {
  it('journals carry seq; live frames do not', async () => {
    const spawned = await spawnOk();
    const streamed = readSse(`/api/agents/${spawned.runId}/events`, (frames) => {
      const live = frames.find((f) => f.event === 'live');
      const snapshot = frames.find((f) => f.event === 'snapshot');
      return Boolean(live && snapshot);
    });
    // Wait until the SSE subscriber is attached, then emit a live token.
    await new Promise((r) => setTimeout(r, 80));
    emitLive({
      key: PARENT,
      boardId: PARENT,
      attemptId: 'e-live',
      taskId: spawned.runId,
      role: 'sub-agent',
      event: { type: 'tool_call', name: 'read_file' },
    });
    const frames = await streamed;
    const snapshot = frames.find((f) => f.event === 'snapshot');
    const live = frames.find((f) => f.event === 'live');
    const journaled = frames.filter((f) => f.event === 'event' || f.event === 'snapshot');
    assert.ok(snapshot, 'missing snapshot');
    assert.ok(snapshot.id, 'snapshot must carry Last-Event-ID seq');
    assert.ok(live, 'missing live frame');
    assert.equal(live.id, undefined, 'live frames must not carry seq');
    for (const frame of journaled) {
      if (frame.event === 'event') assert.ok(frame.id, 'journal event missing seq');
    }
  });

  it('does not forward a sibling run live frame onto this stream (P10-M)', async () => {
    const first = await spawnOk({ task: 'run a' });
    const second = await spawnOk({ task: 'run b' });
    const streamed = readSse(`/api/agents/${first.runId}/events`, (frames) => {
      const lives = frames.filter((f) => f.event === 'live');
      return lives.some((f) => f.data?.event?.name === 'own_tool');
    });
    // Wait until the SSE subscriber is attached, then emit sibling then own.
    await new Promise((r) => setTimeout(r, 80));
    emitLive({
      key: PARENT,
      boardId: PARENT,
      attemptId: 'e-sibling',
      taskId: second.runId,
      role: 'sub-agent',
      event: { type: 'tool_call', name: 'sibling_tool' },
    });
    emitLive({
      key: PARENT,
      boardId: PARENT,
      attemptId: 'e-own',
      taskId: first.runId,
      role: 'sub-agent',
      event: { type: 'tool_call', name: 'own_tool' },
    });
    const frames = await streamed;
    const lives = frames.filter((f) => f.event === 'live');
    assert.ok(
      lives.some((f) => f.data?.event?.name === 'own_tool'),
      'missing this run live frame',
    );
    assert.equal(
      lives.some((f) => f.data?.event?.name === 'sibling_tool' || f.data?.taskId === second.runId),
      false,
      'sibling live frame leaked onto this run stream',
    );
    assert.equal(
      lives.every((f) => f.data?.taskId === first.runId),
      true,
      'a live frame on this stream carried another run id',
    );
  });

  it('ends the HTTP response after snapshot+done for a terminal run (MIN-584)', async () => {
    setAgentsEffectorFactory(() =>
      createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 1 } }] }),
    );
    const spawned = await spawnOk();
    let terminal = false;
    for (let i = 0; i < 80; i += 1) {
      const got = await call('GET', `/api/agents/${spawned.runId}`);
      if (got.body?.status === 'completed' || got.body?.run?.phase === 'passed') {
        terminal = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(terminal, true, 'scripted pass did not reach a terminal fold');

    const result = await readSseUntilEnd(`/api/agents/${spawned.runId}/events`);
    assert.equal(result.ended, true, 'server must res.end() so the socket is released');
    assert.ok(
      result.frames.some((f) => f.event === 'snapshot'),
      'missing snapshot',
    );
    assert.ok(
      result.frames.some((f) => f.event === 'done'),
      'missing done frame',
    );
  });

  it('emits deliver before done when connecting SSE to a completed run', async () => {
    setAgentsEffectorFactory(() =>
      createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 1 } }] }),
    );
    const spawned = await spawnOk();
    let terminal = false;
    for (let i = 0; i < 80; i += 1) {
      const got = await call('GET', `/api/agents/${spawned.runId}`);
      if (got.body?.status === 'completed' || got.body?.run?.phase === 'passed') {
        terminal = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(terminal, true, 'scripted pass did not reach a terminal fold');

    const result = await readSseUntilEnd(`/api/agents/${spawned.runId}/events`);
    const events = result.frames.map((f) => f.event);
    const deliverIdx = events.indexOf('deliver');
    const doneIdx = events.indexOf('done');
    assert.ok(deliverIdx >= 0, 'missing deliver frame for a pending completion');
    assert.ok(doneIdx >= 0, 'missing done frame');
    assert.ok(deliverIdx < doneIdx, 'deliver must land before the socket is closed');
  });
});

describe('POST /api/agents/cancel', () => {
  it('cancels every active run for a parent chat in one request', async () => {
    const first = await spawnOk({ task: 'run a' });
    const second = await spawnOk({ task: 'run b' });
    const cancelled = await call(
      'POST',
      `/api/agents/cancel?parentChatId=${encodeURIComponent(PARENT)}`,
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.parentChatId, PARENT);
    assert.equal(cancelled.body.cancelled, 2);
    const runs = cancelled.body.state.runs.filter(
      (run) => run.runId === first.runId || run.runId === second.runId,
    );
    assert.equal(runs.length, 2);
    assert.equal(runs.every((run) => run.phase === 'cancelled'), true);
  });
});

describe('GET /api/agents/events parent SSE', () => {
  it('multiplexes sibling run frames over one connection', async () => {
    const first = await spawnOk({ task: 'run a' });
    const second = await spawnOk({ task: 'run b' });
    const streamed = readSse(`/api/agents/events?parentChatId=${encodeURIComponent(PARENT)}`, (frames) => {
      const taskIds = new Set(
        frames.filter((frame) => frame.event === 'live').map((frame) => frame.data?.taskId),
      );
      return taskIds.has(first.runId) && taskIds.has(second.runId);
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    for (const [taskId, name] of [[first.runId, 'first_tool'], [second.runId, 'second_tool']]) {
      emitLive({
        key: PARENT,
        boardId: PARENT,
        attemptId: `attempt-${taskId}`,
        taskId,
        role: 'sub-agent',
        event: { type: 'tool_call', name },
      });
    }
    const frames = await streamed;
    const snapshots = frames.filter((frame) => frame.event === 'snapshot');
    assert.equal(snapshots.some((frame) => frame.data?.run?.runId === first.runId), true);
    assert.equal(snapshots.some((frame) => frame.data?.run?.runId === second.runId), true);
    assert.equal(frames.filter((frame) => frame.event === 'live').length, 2);
  });
});

// ── GET /api/agents/:runId/events ────────────────────────────────────────────

describe('GET /api/agents/:runId/events SSE seq resume', () => {
  it('resumes from Last-Event-ID with exactly the missed tail', async () => {
    const spawned = await spawnOk();
    const journal = (await call('GET', `/api/agents/${spawned.runId}/journal`)).body.events;
    assert.ok(journal.length >= 1, `journal only has ${journal.length} events`);

    const frames = await readSse(
      `/api/agents/${spawned.runId}/events`,
      (f) => f.filter((x) => x.event === 'event').length >= Math.max(0, journal.length - 1),
      { 'Last-Event-ID': '1' },
    );

    assert.equal(
      frames.every((f) => f.event === 'event'),
      true,
      'a snapshot was re-sent on resume',
    );
    const seqs = frames.map((f) => f.data.seq);
    const expected = journal.filter((e) => e.seq > 1).map((e) => e.seq);
    assert.deepEqual(seqs.slice(0, expected.length), expected.slice(0, seqs.length));
  });
});

// ── /api/agents routes ───────────────────────────────────────────────────────

describe('/api/agents routes', () => {
  it('only declared command routes mutate', () => {
    assert.deepEqual([...MUTATING_ROUTES].sort(), ['cancel', 'cancel-parent', 'spawn']);
    for (const route of ROUTES) {
      if (MUTATING_ROUTES.has(route.name)) {
        assert.equal(route.method, 'POST', `${route.name} must POST`);
      } else {
        assert.equal(route.method, 'GET', `${route.name} must be a read`);
      }
    }
  });

  it('matches routes exactly', () => {
    assert.equal(matchRoute('POST', '/api/agents')?.name, 'spawn');
    assert.equal(matchRoute('GET', '/api/agents')?.name, 'list');
    assert.equal(matchRoute('POST', '/api/agents/cancel')?.name, 'cancel-parent');
    assert.equal(matchRoute('GET', '/api/agents/events')?.name, 'parent-events');
    assert.equal(matchRoute('GET', '/api/agents/r1/events')?.name, 'events');
    assert.equal(matchRoute('GET', '/api/agents/r1/journal')?.name, 'journal');
    assert.equal(matchRoute('GET', '/api/agents/r1/transcript')?.name, 'transcript');
    assert.equal(matchRoute('POST', '/api/agents/r1/cancel')?.name, 'cancel');
    assert.equal(matchRoute('GET', '/api/agents/r1')?.name, 'get');
    assert.equal(matchRoute('PUT', '/api/agents/r1'), null);
  });
});

// ── GET /api/agents/:runId/transcript ────────────────────────────────────────

describe('GET /api/agents/:runId/transcript', () => {
  it('returns recorded tool_call lines for the latest attempt', async () => {
    const { recordTranscriptEvent } = await import('../../server/orchestrator/transcripts.js');
    const { agentsDir } = await import('../../server/sub-agents/journal.js');
    const spawned = await spawnOk();
    const attemptId =
      spawned.run?.attempts?.[0]?.attemptId ??
      (await call('GET', `/api/agents/${spawned.runId}`)).body.run?.attempts?.[0]?.attemptId;
    assert.equal(typeof attemptId, 'string');
    recordTranscriptEvent({
      entryDir: agentsDir(PARENT),
      attemptId,
      taskId: spawned.runId,
      role: 'sub-agent',
      event: {
        type: 'tool_call',
        name: 'read_file',
        id: 'call_read',
        arguments: { path: 'src/a.ts' },
      },
    });
    const transcript = await call('GET', `/api/agents/${spawned.runId}/transcript`);
    assert.equal(transcript.status, 200, JSON.stringify(transcript.body));
    assert.equal(transcript.body.ok, true);
    assert.equal(transcript.body.attemptId, attemptId);
    const types = (transcript.body.events ?? []).map((row) => row.type);
    assert.equal(types.includes('tool_call'), true);
    const callRow = transcript.body.events.find((row) => row.type === 'tool_call');
    assert.equal(callRow.name, 'read_file');
  });

  it('returns an empty transcript when no attempt has been recorded', async () => {
    const spawned = await spawnOk();
    const transcript = await call('GET', `/api/agents/${spawned.runId}/transcript?attemptId=never-written`);
    assert.equal(transcript.status, 200);
    assert.deepEqual(transcript.body.events, []);
  });
});
