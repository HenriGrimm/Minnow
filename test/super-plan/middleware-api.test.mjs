/**
 * W3-B — Super Plan HTTP integration.
 *
 * Drives `createSuperPlanMiddleware` over a real socket with a scripted
 * effector injected through `setSuperPlanEffectorFactory`, mirroring
 * `test/orchestrator/api.test.mjs`. Covers the documented surface:
 * create → start → state → events, with a `Last-Event-ID` replay that must
 * deliver exactly the missed tail and no duplicates.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  createSuperPlanMiddleware,
  matchRoute,
  resetSuperPlanMiddlewareForTests,
  ROUTES,
  setSuperPlanEffectorFactory,
} from '../../server/super-plan/middleware.js';
import {
  appendEvent,
  createEntry,
  readEvents,
  resetJournalCache,
} from '../../server/super-plan/journal.js';
import { makeEvent } from '../../server/super-plan/events.js';
import { derive } from '../../server/super-plan/derive.js';
import { emitLive } from '../../server/super-plan/live-events.js';
import { createDelegatedEffector } from '../../server/super-plan/effector-delegated.js';

const RUN_ID = 'run-1';
const PROMPT = 'Build a Kanban UI';
let WORKSPACE = path.resolve(os.tmpdir(), 'kanban-ws');

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-super-plan-api-'));
  WORKSPACE = path.join(home, 'workspace');
  await fs.mkdir(WORKSPACE);
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  resetSuperPlanMiddlewareForTests();

  setSuperPlanEffectorFactory(() =>
    createScriptedEffector({ script: [{ match: { role: 'gate' }, emit: { outcome: 'pass', delayMs: 60000 } }, { emit: { outcome: 'pass', delayMs: 60_000 } }] }),
  );

  const middleware = createSuperPlanMiddleware();
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
  resetSuperPlanMiddlewareForTests();
  await new Promise((resolve) => server.close(resolve));
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  resetSuperPlanMiddlewareForTests();
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

async function createRun() {
  const created = await call('POST', '/api/super-plan', {
    prompt: PROMPT,
    runId: RUN_ID,
    workspacePath: WORKSPACE,
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

// ── POST /api/super-plan ─────────────────────────────────────────────────────

describe('POST /api/super-plan', () => {
  it('creates a run from a prompt and returns its derived state', async () => {
    const created = await createRun();
    assert.equal(created.runId, RUN_ID);
    const state = created.state;
    assert.equal(state.status, 'created');
    assert.equal(state.finished, false);
    assert.equal(state.stage, 'interview');
    assert.equal(state.prompt, PROMPT);
    assert.equal(state.workspacePath, WORKSPACE);
  });

  it('requires a prompt', async () => {
    assert.equal((await call('POST', '/api/super-plan', {})).status, 400);
  });

  it('refuses to clobber an existing run', async () => {
    await createRun();
    const again = await call('POST', '/api/super-plan', { prompt: PROMPT, runId: RUN_ID });
    assert.equal(again.status, 409);
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('super-plan lifecycle', () => {
  it('start journals run.started and begins the pipeline', async () => {
    await createRun();
    const started = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.state.status, 'running');
    assert.equal(started.body.state.stage, 'interview');
    assert.equal(started.body.state.attempts.length, 1);
    assert.equal(started.body.state.attempts[0].ended, false);
  });

  it('start is idempotent while the run is running', async () => {
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const again = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    assert.equal(again.status, 200);
    const events = await readEvents(RUN_ID);
    assert.equal(
      events.filter((e) => e.type === 'run.started').length,
      1,
      'start twice must not double-journal run.started',
    );
  });

  it('state reflects the fold of its own journal', async () => {
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const state = await call('GET', `/api/super-plan/${RUN_ID}/state`);
    assert.equal(state.status, 200);
    const journal = await readEvents(RUN_ID);
    const { view, ...folded } = state.body.state;
    assert.equal(view.runId, RUN_ID);
    assert.deepEqual(folded, derive(journal));
  });

  it('cancel stops the run with stopReason cancelled', async () => {
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const cancelled = await call('POST', `/api/super-plan/${RUN_ID}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state.finished, true);
    assert.equal(cancelled.body.state.stopReason, 'cancelled');
    assert.equal(cancelled.body.state.status, 'stopped');
  });

  it('stop journals a non-terminal pause (D8)', async () => {
    await createRun();
    const started = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    assert.equal(started.body.state.stage, 'interview');
    const stopped = await call('POST', `/api/super-plan/${RUN_ID}/stop`);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.state.status, 'stopped');
    assert.equal(stopped.body.state.finished, false, 'a stop is a pause, not terminal');
    assert.equal(stopped.body.state.stopReason, 'paused');
    assert.equal(stopped.body.state.stage, 'interview', 'the stage is preserved');
  });

  it('resume after a pause re-plans the same stage, not a fresh one (D8)', async () => {
    await createRun();
    const started = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    assert.equal(started.body.state.stage, 'interview');
    await call('POST', `/api/super-plan/${RUN_ID}/stop`);

    const resumed = await call('POST', `/api/super-plan/${RUN_ID}/resume`);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.state.status, 'running');
    assert.equal(resumed.body.state.finished, false);
    assert.equal(resumed.body.state.stopReason, null);
    assert.equal(resumed.body.state.stage, 'interview', 'the same stage re-plans');
    assert.equal(
      resumed.body.state.stageRecords.some((r) => r.stage === 'spec'),
      false,
      'resume must not restart the pipeline',
    );

    const journal = await readEvents(RUN_ID);
    assert.equal(
      journal.filter((e) => e.type === 'run.stopped' && e.reason === 'paused').length,
      1,
    );
    assert.equal(journal.filter((e) => e.type === 'run.resumed').length, 1);
  });

  it('resume answers an open gate and replans the stage', async () => {
    await createEntry(RUN_ID);
    await appendEvent(RUN_ID, makeEvent('run.created', { runId: RUN_ID, prompt: PROMPT }));
    await appendEvent(RUN_ID, makeEvent('run.started', {}));
    await appendEvent(
      RUN_ID,
      makeEvent('stage.started', { stage: 'interview', attemptId: 'i1' }),
    );
    await appendEvent(
      RUN_ID,
      makeEvent('stage.ended', { stage: 'interview', attemptId: 'i1', outcome: 'ok' }),
    );
    await appendEvent(
      RUN_ID,
      makeEvent('stage.started', { stage: 'spec', attemptId: 's1' }),
    );
    await appendEvent(
      RUN_ID,
      makeEvent('stage.ended', { stage: 'spec', attemptId: 's1', outcome: 'ok' }),
    );
    await appendEvent(
      RUN_ID,
      makeEvent('spec.written', { path: 'documentation/plans/references/kanban-spec.md' }),
    );
    await appendEvent(RUN_ID, makeEvent('gate.opened', { kind: 'spec' }));

    const resumed = await call('POST', `/api/super-plan/${RUN_ID}/resume`, {
      kind: 'spec',
      verdict: 'confirm',
    });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.state.gate, null);
    assert.equal(resumed.body.state.stage, 'research');
  });

  it('resume rejects a bad verdict', async () => {
    await createRun();
    const response = await call('POST', `/api/super-plan/${RUN_ID}/resume`, {
      kind: 'spec',
      verdict: 'accept',
    });
    assert.equal(response.status, 400);
  });

  it('404s for a run that does not exist', async () => {
    assert.equal((await call('GET', '/api/super-plan/nope/state')).status, 404);
    assert.equal((await call('POST', '/api/super-plan/nope/start')).status, 404);
    assert.equal((await call('POST', '/api/super-plan/nope/cancel')).status, 404);
    assert.equal((await call('POST', '/api/super-plan/nope/claim', { attemptId: 'x' })).status, 404);
    const response = await fetch(`${base}/api/super-plan/nope/events`);
    assert.equal(response.status, 404);
    await response.text();
  });
});

// ── claim (W4-A) ─────────────────────────────────────────────────────────────

describe('POST /api/super-plan/:runId/claim', () => {
  it('hands a delegated lease to the first claimer and 409s the second', async () => {
    setSuperPlanEffectorFactory((runId) => createDelegatedEffector({ runId }));
    await createRun();
    const started = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const attemptId = started.body.state.attempts[0]?.attemptId;
    assert.ok(attemptId, 'the interview lease was not started');

    const first = await call('POST', `/api/super-plan/${RUN_ID}/claim`, {
      attemptId,
      clientId: 'window-a',
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.lease.claimedBy, 'window-a');

    const second = await call('POST', `/api/super-plan/${RUN_ID}/claim`, {
      attemptId,
      clientId: 'window-b',
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /already claimed/);
  });

  it('404s a claim when the run has no delegated effector', async () => {
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const response = await call('POST', `/api/super-plan/${RUN_ID}/claim`, {
      attemptId: 'nope',
      clientId: 'window-a',
    });
    assert.equal(response.status, 404);
  });

  it('finish delivers the renderer outcome and journals stage.ended', async () => {
    setSuperPlanEffectorFactory((runId) => createDelegatedEffector({ runId }));
    await createRun();
    const started = await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const attemptId = started.body.state.attempts[0]?.attemptId;
    assert.ok(attemptId, 'the interview lease was not started');

    const claimed = await call('POST', `/api/super-plan/${RUN_ID}/claim`, {
      attemptId,
      clientId: 'window-a',
    });
    assert.equal(claimed.status, 200);

    await fs.mkdir(path.join(WORKSPACE, 'documentation/plans/references'), { recursive: true });
    await fs.writeFile(path.join(WORKSPACE, `documentation/plans/references/${RUN_ID}-spec.md`), '# Specification\n\nAgreed requirements.');
    const finished = await call('POST', `/api/super-plan/${RUN_ID}/finish`, {
      clientId: 'window-a',
      attemptId,
      outcome: 'pass',
      summary: 'interview done',
    });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.ok, true);

    const journal = await readEvents(RUN_ID);
    const ended = journal.find((e) => e.type === 'stage.ended' && e.attemptId === attemptId);
    assert.ok(ended, 'finish must journal stage.ended');
    assert.equal(ended.outcome, 'ok');
    assert.equal(ended.summary, 'interview done');

    // A late finish after the lease was delivered is an idempotent no-op.
    const again = await call('POST', `/api/super-plan/${RUN_ID}/finish`, {
      clientId: 'window-a',
      attemptId,
      outcome: 'pass',
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
  });
});

// ── SSE ──────────────────────────────────────────────────────────────────────

describe('SSE', () => {
  it('opens with a snapshot frame carrying the current seq and state', async () => {
    await createRun();
    const frames = await readSse(`/api/super-plan/${RUN_ID}/events`, (f) => f.length >= 1);

    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[0].id, '1');
    assert.equal(frames[0].data.seq, 1);
    assert.equal(frames[0].data.state.status, 'created');
  });

  it('streams each subsequent event with its seq as the frame id', async () => {
    await createRun();
    const streamed = readSse(`/api/super-plan/${RUN_ID}/events`, (f) => f.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await call('POST', `/api/super-plan/${RUN_ID}/start`);

    const frames = await streamed;
    assert.equal(frames[0].event, 'snapshot');
    assert.equal(frames[1].event, 'event');
    assert.equal(frames[1].data.type, 'run.started');
    assert.equal(frames[1].id, String(frames[1].data.seq));
  });

  it('resumes from Last-Event-ID with exactly the missed tail and no duplicates', async () => {
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const journal = await readEvents(RUN_ID);
    assert.ok(journal.length >= 3, `journal only has ${journal.length} events`);

    const frames = await readSse(
      `/api/super-plan/${RUN_ID}/events`,
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

  it('forwards live channel frames without journaling them', async () => {
    await createRun();
    const streamed = readSse(
      `/api/super-plan/${RUN_ID}/events`,
      (f) => f.some((x) => x.event === 'live'),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    emitLive({ runId: RUN_ID, stage: 'research', event: { type: 'delta', text: 'thinking…' } });

    const frames = await streamed;
    const live = frames.find((f) => f.event === 'live');
    assert.ok(live, 'no live frame arrived');
    assert.equal(live.data.runId, RUN_ID);
    assert.equal(live.data.stage, 'research');
    assert.equal(live.data.event.type, 'delta');

    const journal = await readEvents(RUN_ID);
    assert.equal(
      journal.some((e) => e.type === 'delta' || e.type === 'live'),
      false,
      'live activity must never be journaled',
    );
  });
});

// ── Surface ──────────────────────────────────────────────────────────────────

describe('the surface itself', () => {
  it('exposes exactly the documented routes', async () => {
    assert.deepEqual(
      ROUTES.map((r) => `${r.method} ${r.name}`).sort(),
      ['GET events', 'GET state', 'POST answer', 'POST ask', 'POST cancel', 'POST claim', 'POST create', 'POST finish', 'POST resume', 'POST rework', 'POST skip', 'POST start', 'POST stop'],
    );
  });

  it('matches routes exactly, with no prefix surprises', () => {
    assert.equal(matchRoute('POST', '/api/super-plan')?.name, 'create');
    assert.equal(matchRoute('GET', '/api/super-plan/run-1/state')?.name, 'state');
    assert.deepEqual(matchRoute('GET', '/api/super-plan/run-1/events')?.params, ['run-1']);
    assert.equal(matchRoute('POST', '/api/super-plan/run-1/start')?.name, 'start');
    assert.equal(matchRoute('POST', '/api/super-plan/run-1/claim')?.name, 'claim');
    assert.equal(matchRoute('POST', '/api/super-plan/run-1/finish')?.name, 'finish');
    assert.equal(matchRoute('GET', '/api/super-plan/run-1/nope'), null);
    assert.equal(matchRoute('GET', '/api/super-plan/run-1'), null);
    assert.equal(matchRoute('GET', '/api/super-plansomething'), null);
  });

  it('leaves unrelated paths to the next middleware', async () => {
    const response = await fetch(`${base}/api/something-else`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'not found');
  });
});
describe('journaled interactive question API', () => {
  it('answers the owning attempt over HTTP and unblocks its pending ask', async () => {
    setSuperPlanEffectorFactory(() => createDelegatedEffector({ runId: RUN_ID }));
    await createRun();
    await call('POST', `/api/super-plan/${RUN_ID}/start`);
    const state = (await call('GET', `/api/super-plan/${RUN_ID}/state`)).body.state;
    const attemptId = state.attempts.find((attempt) => !attempt.ended).attemptId;
    assert.equal((await call('POST', `/api/super-plan/${RUN_ID}/claim`, { attemptId, clientId: 'gate-owner' })).status, 200);
    assert.equal((await call('POST', `/api/super-plan/${RUN_ID}/finish`, { attemptId, outcome: 'pass' })).status, 400);
    const pending = call('POST', `/api/super-plan/${RUN_ID}/ask`, { attemptId, clientId: 'gate-owner', question: { question: 'Who uses it?' } });
    let gate;
    for (let i = 0; i < 100 && !gate; i++) {
      gate = (await call('GET', `/api/super-plan/${RUN_ID}/state`)).body.state.gate;
      if (!gate) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(gate, 'question must appear in authoritative state');
    const answered = await call('POST', `/api/super-plan/${RUN_ID}/gates/${encodeURIComponent(gate.gateId)}/answer`, { answer: 'Developers' });
    assert.equal(answered.status, 200);
    assert.equal((await pending).body.answer, 'Developers');
    const events = await readEvents(RUN_ID);
    assert.ok(events.find((event) => event.type === 'gate.answered' && event.verdict === 'Developers'));
  });
});
