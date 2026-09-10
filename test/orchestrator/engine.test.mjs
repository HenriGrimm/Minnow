import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { boardGraph } from '../../server/orchestrator/board-graph.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { abandonmentEvidenceIsComplete } from '../../server/orchestrator/core/evidence.js';
import {
  createEngine,
  disposeEngines,
  getEngine,
  peekEngine,
} from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  appendEvent,
  createBoard,
  loadAbandonments,
  readEvents,
  resetJournalCache,
} from '../../server/orchestrator/journal.js';
import { journalHasReport, REPORT_EVENT_TYPE } from '../../server/orchestrator/report.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_SOURCE = path.join(PROJECT_ROOT, 'server/orchestrator/engine.js');

/** @type {string | undefined} */
let previousHome;

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

/** @type {Array<{ dispose: () => void }>} */
let liveEngines = [];

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-engine-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  liveEngines = [];
});

afterEach(async () => {
  for (const engine of liveEngines) await drainReportWrite(engine);
  for (const engine of liveEngines) engine.dispose();
  liveEngines = [];
  disposeEngines();
  await settle();
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
});

function fakeClock() {
  let now = 1_700_000_000_000;
/** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  let nextHandle = 0;
  return {
    now: () => now,
    setTimer(fn, ms) {
      const handle = (nextHandle += 1);
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer(handle) {
      timers.delete(/** @type {number} */ (handle));
    },
    async advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        await timer.fn();
      }
      await settle();
    },
    get pending() {
      return timers.size;
    },
  };
}

async function settle(rounds = 60) {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const task = (id, extra = {}) => ({
  id,
  title: id,
  wave: 1,
  dependsOn: [],
  touches: [`src/${id}/**`],
  build: 'b',
  test: 't',
  accept: 'a',
  ...extra,
});

/**
 * @param {{ boardId?: string, tasks?: object[], script?: object[], effector?: object, graph?: object }} [setup]
 */
async function harness(setup = {}) {
  const boardId = setup.boardId ?? 'b1';
  const clock = fakeClock();
  await createBoard(boardId);
  await appendEvent(
    boardId,
    makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: setup.tasks ?? [task('A')],
      waves: [],
    }),
    { now: clock.now },
  );

  const effector = setup.effector ?? createScriptedEffector({ script: setup.script ?? [], clock });
  const engine = createEngine({
    boardId,
    effector,
    clock,
    tickMs: 5000,
    ...(setup.graph ? { graph: setup.graph } : {}),
  });
  liveEngines.push(engine);
  await engine.load();
  return { boardId, engine, effector, clock };
}

async function finishedWithReport(engine) {
  return engine.getState().finished && journalHasReport(await engine.getEvents());
}

async function drainReportWrite(engine) {
  try {
    const st = engine.getState();
    if (!st.finished && st.stopReason !== 'user') return;
    for (let i = 0; i < 80; i += 1) {
      if (journalHasReport(await engine.getEvents())) return;
      await settle();
    }
  } catch {
  }
}

async function runToCompletion(engine, clock, concurrency = 1, maxTicks = 400) {
  await engine.startBoard(concurrency);
  for (let i = 0; i < maxTicks; i += 1) {
    await settle();
    if (await finishedWithReport(engine)) return i;
    await engine.tick();
    if (clock.pending > 0) await clock.advance(10_000);
  }
  assert.fail(`board did not finish in ${maxTicks} ticks`);
}

// ── The tick ─────────────────────────────────────────────────────────────────

describe('engine — the tick', () => {
  it('reload retries a missing terminal report using the safety timer', async () => {
    const { engine, effector, clock, boardId } = await harness();
    await engine.append([
      makeEvent('task.abandoned', { taskId: 'A', reason: 'fixture', evidence: {} }),
      makeEvent('run.finished', { summary: '0 merged, 1 abandoned' }),
      makeEvent('board.stopped', { reason: 'terminal' }),
    ]);
    engine.dispose();
    let writes = 0;
    const restored = createEngine({ boardId, effector, clock, graph: { ...boardGraph,
      async writeReport() { writes += 1; return { relativePath: 'report.md', usedFallback: true }; },
    } });
    liveEngines.push(restored);
    await restored.load();
    assert.ok(clock.pending > 0);
    await clock.advance(5000);
    assert.equal(writes, 1);
    assert.ok(await finishedWithReport(restored));
  });

  it('replaces the partial stop report when resumed work completes', async () => {
    const inputs = [];
    const graph = { ...boardGraph, async writeReport(ctx) {
      inputs.push(structuredClone(ctx.state));
      return { relativePath: 'report.md', usedFallback: true };
    } };
    const { engine, clock } = await harness({ graph, script: [{ emit: { outcome: 'pass', delayMs: 9999 } }] });
    await engine.startBoard(1);
    await engine.stopBoard('user');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].finished, false);
    await runToCompletion(engine, clock);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[1].finished, true);
    assert.match(inputs[1].runSummary, /1 merged/);
  });

  it('rearms the safety timer after a transient scheduler failure', async () => {
    let fail = false;
    const graph = { ...boardGraph, plan(state) {
      if (fail) { fail = false; throw new Error('temporary scheduler error'); }
      return boardGraph.plan(state);
    } };
    const { engine, clock } = await harness({ graph, script: [{ emit: { outcome: 'pass', delayMs: 20000 } }] });
    await engine.startBoard(1);
    fail = true;
    await clock.advance(5000);
    assert.ok(clock.pending > 0);
    await runToCompletion(engine, clock);
    assert.equal(engine.getState().tasks.get('A').phase, 'merged');
  });

  it('retries report persistence after completion without rerunning tasks', async () => {
    let writes = 0;
    const graph = { ...boardGraph, async writeReport(ctx) {
      writes += 1;
      if (writes === 1) throw new Error('temporary report write failure');
      assert.match(ctx.state.runSummary, /1 merged/);
      return { relativePath: 'report.md', usedFallback: true };
    } };
    const { engine, clock } = await harness({ graph });
    await runToCompletion(engine, clock);
    assert.equal(writes, 2);
    assert.equal((await engine.getEvents()).filter((event) => event.type === 'run.finished').length, 1);
  });

  it('runs a single-task board end to end', async () => {
    const { engine, clock, boardId } = await harness();
    await runToCompletion(engine, clock);

    const state = engine.getState();
    assert.equal(state.tasks.get('A').phase, 'merged');
    assert.equal(state.finished, true);
    assert.equal(state.status, 'stopped');
    assert.equal(state.stopReason, 'complete');

    const types = (await readEvents(boardId)).map((e) => e.type);
    assert.deepEqual(types, [
      'board.created',
      'board.started',
      'task.attempt.started',
      'task.attempt.ended',
      'task.attempt.started',
      'task.attempt.ended',
      'merge.enqueued',
      'merge.succeeded',
      'final.test.ended',
      'run.finished',
      'board.stopped',
      'run.report.written',
    ]);
  });

  it('halts on a spent provider allowance instead of burning retries', async () => {
    const quota =
      'Upstream HTTP 429: Weekly usage limit reached. Resets in 3 days. To continue using ' +
      'this model now, enable usage from your available balance.';
    const { engine, clock, boardId } = await harness({
      tasks: [task('A'), task('B')],
      script: [{ emit: { outcome: 'crashed', summary: quota, evidence: { error: quota } } }],
    });

    await engine.startBoard(1);
    for (let i = 0; i < 20; i += 1) {
      await settle();
      if (engine.getState().status === 'stopped') break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }

    const state = engine.getState();
    assert.equal(state.status, 'stopped');
    assert.equal(state.stopReason, 'quota');

    const events = await readEvents(boardId);
    // One attempt, then the halt. The old policy retried twice and abandoned.
    assert.equal(events.filter((e) => e.type === 'task.attempt.ended').length, 1);
    assert.equal(events.filter((e) => e.type === 'task.abandoned').length, 0);

    // Both tasks stay resumable rather than being written off.
    assert.notEqual(state.tasks.get('A').phase, 'abandoned');
    assert.notEqual(state.tasks.get('B').phase, 'abandoned');
  });

  it('leaves an ordinary crash on the retry path', async () => {
    const { engine, clock, boardId } = await harness({
      script: [{ emit: { outcome: 'crashed', summary: 'segfault in the test runner' } }],
    });

    await engine.startBoard(1);
    for (let i = 0; i < 20; i += 1) {
      await settle();
      if (engine.getState().stopReason === 'quota') assert.fail('halted on a non-quota crash');
      if (engine.getState().tasks.get('A').phase === 'abandoned') break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }

    const events = await readEvents(boardId);
    assert.ok(
      events.filter((e) => e.type === 'task.attempt.ended').length > 1,
      'a plain crash should still be retried',
    );
  });

  it('does not mark live state finished while the report writer runs', async () => {
    /** @type {boolean | null} */
    let liveFinishedDuringWrite = null;
    /** @type {boolean | null} */
    let journalHadFinishedDuringWrite = null;
    const { engine, clock, boardId } = await harness({
      boardId: 'live-finished-race',
      graph: {
        ...boardGraph,
        async writeReport() {
          liveFinishedDuringWrite = engine.getState().finished === true;
          journalHadFinishedDuringWrite = (await readEvents(boardId)).some(
            (event) => event.type === 'run.finished',
          );
          return { relativePath: 'report.md', usedFallback: true };
        },
      },
    });
    await runToCompletion(engine, clock);
    assert.equal(liveFinishedDuringWrite, false, 'live GET/peek must stay unfinished during writeReport');
    assert.equal(journalHadFinishedDuringWrite, false, 'run.finished must land in the same append as the report');
    assert.equal(engine.getState().finished, true);
    assert.ok(
      (await engine.getEvents()).some((event) => event.type === 'run.finished'),
      'journal must contain run.finished after the tick that wrote the report',
    );
  });

  it('is idempotent — a second tick on identical state starts nothing', async () => {
    const { engine, effector, clock } = await harness({
      script: [{ match: { role: 'builder' }, emit: { outcome: 'pass', delayMs: 1000 } }],
    });
    await engine.startBoard(1);
    await settle();

    const afterFirst = effector.started.length;
    assert.equal(afterFirst, 1);
    for (let i = 0; i < 10; i += 1) {
      await engine.tick();
      await settle();
    }
    assert.equal(effector.started.length, afterFirst, 'extra ticks started work');
    assert.equal(clock.pending >= 1, true);
  });

  it('starts exactly one process per {taskId, role} under 20 concurrent ticks', async () => {
    const { engine, effector } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 5000 } }],
      tasks: [task('A'), task('B'), task('C')],
    });
    await engine.startBoard(3);
    await Promise.all(Array.from({ length: 20 }, () => engine.tick()));
    await settle();

    const keys = effector.started.map((s) => `${s.taskId}:${s.role}`);
    assert.deepEqual([...new Set(keys)].sort(), ['A:builder', 'B:builder', 'C:builder']);
    assert.equal(keys.length, 3, `double-started: ${keys.join(', ')}`);
  });

  it('coalesces a tick that fires during a tick rather than queueing passes', async () => {
    const { engine } = await harness({ script: [{ emit: { outcome: 'pass', delayMs: 5000 } }] });
    await engine.startBoard(1);

    const ticks = Array.from({ length: 50 }, () => engine.tick());
    await Promise.all(ticks);
    await settle();
    assert.equal(engine.getState().tasks.get('A').phase, 'building');
  });

  it('never exceeds the cap across a long simulated run', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`T${i}`));
    const { engine, effector, clock } = await harness({
      tasks,
      script: [{ emit: { outcome: 'pass', delayMs: 100 } }],
    });
    await engine.startBoard(1);

    let peak = 0;
    for (let i = 0; i < 200 && !(await finishedWithReport(engine)); i += 1) {
      const live = effector.inspect().filter((r) => r.role !== 'merge').length;
      peak = Math.max(peak, live);
      await engine.tick();
      await settle();
      if (clock.pending > 0) await clock.advance(1000);
    }
    assert.equal(peak <= 1, true, `peak concurrency was ${peak} at N=1`);
    assert.equal(engine.getState().finished, true);
  });
});

// ── Journaling ───────────────────────────────────────────────────────────────

describe('engine — journaling completed effects only', () => {
  it('appends task.attempt.started strictly after effector.start() resolves', async () => {
/** @type {string[]} */
    const order = [];
    const inner = createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 9999 } }] });
    const effector = {
      inspect: () => inner.inspect(),
      onEnd: (h) => inner.onEnd(h),
      stop: (id) => inner.stop(id),
      async start(desired) {
        order.push('start:called');
        const handle = await inner.start(desired);
        order.push('start:resolved');
        return handle;
      },
    };

    const { engine, boardId } = await harness({ effector });
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === 'task.attempt.started') order.push('journal:started');
    });
    await engine.startBoard(1);
    await settle();
    unsubscribe();

    assert.deepEqual(order, ['start:called', 'start:resolved', 'journal:started']);
    const events = await readEvents(boardId);
    assert.equal(events.filter((e) => e.type === 'task.attempt.started').length, 1);
  });

  it('journals nothing when the effector cannot start the process', async () => {
    let attempts = 0;
    const inner = createScriptedEffector({});
    const effector = {
      inspect: () => inner.inspect(),
      onEnd: (h) => inner.onEnd(h),
      stop: (id) => inner.stop(id),
      async start(desired) {
        attempts += 1;
        if (attempts <= 2) throw new Error('spawn failed');
        return inner.start(desired);
      },
    };

    const { engine, boardId } = await harness({ effector });
    await engine.startBoard(1);
    await settle();

    let events = await readEvents(boardId);
    assert.equal(events.filter((e) => e.type === 'task.attempt.started').length, 0);
    assert.equal(attempts, 1);

    await engine.tick();
    await settle();
    assert.equal(attempts, 2);
    events = await readEvents(boardId);
    assert.equal(events.filter((e) => e.type === 'task.attempt.started').length, 0);

    await engine.tick();
    await settle();
    events = await readEvents(boardId);
    const builderStarts = events.filter(
      (e) => e.type === 'task.attempt.started' && e.role === 'builder',
    );
    assert.equal(builderStarts.length, 1, 'the builder was started more than once');
    assert.equal(
      events.filter((e) => e.type === 'task.attempt.ended' && e.role === 'builder').length,
      1,
    );
  });

  it('never writes an event type that names an intent', async () => {
    const { engine, clock, boardId } = await harness({
      tasks: [task('A'), task('B', { dependsOn: ['A'], touches: ['src/b/**'] })],
      script: [{ match: { taskId: 'A', role: 'builder' }, emit: { outcome: 'fail' } }],
    });
    await runToCompletion(engine, clock, 2);
    for (const event of await readEvents(boardId)) {
      assert.doesNotMatch(String(event.type), /\.(requested|pending|starting|will)$/);
    }
  });
});

// ── Self-healing ─────────────────────────────────────────────────────────────

describe('engine — self-healing is a consequence, not a feature', () => {
  it('restarts a process that vanished, with no watchdog involved', async () => {
    const { engine, effector } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(1);
    await settle();
    assert.equal(effector.inspect().length, 1);
    assert.equal(effector.started.length, 1);

    effector.vanishAll();
    assert.equal(effector.inspect().length, 0);

    await engine.tick();
    await settle();
    assert.equal(effector.started.length, 2, 'the vanished attempt was not restarted');
    assert.equal(effector.inspect().length, 1);
  });

  it('recovers from a vanish at every point in a task lifecycle', async () => {
    for (const vanishAfter of [0, 1, 2, 3, 4]) {
      const { engine, effector, clock } = await harness({
        boardId: `v${vanishAfter}`,
        script: [{ emit: { outcome: 'pass' } }],
      });
      await engine.startBoard(1);
      for (let i = 0; i < vanishAfter; i += 1) {
        await settle();
        await engine.tick();
      }
      effector.vanishAll();
      await runToCompletion(engine, clock, 1);
      assert.equal(engine.getState().finished, true, `vanish after ${vanishAfter}`);
    }
  });

  it('warns, and leaks nothing, when an effector breaks the inspect() contract', async () => {
/** @type {Array<(end: object) => Promise<void>>} */
    const handlers = [];
/** @type {Array<{ taskId: string, role: string, attemptId: string }>} */
    let running = [];
    let nextId = 0;

    const effector = {
      inspect: () => running,
      async start(desired) {
        const attemptId = `bad${(nextId += 1)}`;
        running = [...running, { taskId: desired.taskId, role: desired.role, attemptId }];
        return { attemptId };
      },
      async stop(attemptId) {
        running = running.filter((r) => r.attemptId !== attemptId);
      },
      onEnd: (handler) => handlers.push(handler),
    };

    const { engine, clock } = await harness({ effector });
    await engine.startBoard(1);
    await settle();

    const attempt = running[0];
    assert.ok(attempt, 'nothing started');

    running = [];
    await clock.advance(10_000);
    await settle();

    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      for (const handler of handlers) {
        await handler({ attemptId: attempt.attemptId, taskId: 'A', role: 'builder', outcome: 'pass' });
      }
      await settle();
    } finally {
      console.warn = realWarn;
    }

    const recorded = engine
      .getState()
      .tasks.get('A')
      .attempts.find((a) => a.attemptId === attempt.attemptId);
    assert.equal(recorded.ended, true);
    assert.equal(recorded.outcome, 'crashed', 'the reap did not run');
    assert.ok(
      warnings.some((line) => line.includes('inspect()')),
      `no contract warning: ${JSON.stringify(warnings)}`,
    );
  });

  it('survives every process disappearing at once — the display-sleep analogue', async () => {
    const tasks = Array.from({ length: 4 }, (_, i) => task(`T${i}`));
    const { engine, effector, clock } = await harness({
      tasks,
      script: [{ emit: { outcome: 'pass', delayMs: 500 } }],
    });
    await engine.startBoard(4);
    await settle();
    assert.equal(effector.inspect().length, 4);

    effector.vanishAll();
    await runToCompletion(engine, clock, 4);
    assert.equal(engine.getState().finished, true);
  });

  it('lets running work finish when the cap is lowered, but starts nothing new', async () => {
    const tasks = [task('A'), task('B'), task('C'), task('D')];
    const { engine, effector } = await harness({
      tasks,
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(3);
    await settle();
    assert.equal(effector.inspect().length, 3);

    await engine.setConcurrency(1);
    await settle();
    assert.equal(effector.inspect().length, 3, 'in-flight work was killed by a cap change');
    assert.equal(effector.started.length, 3, 'a fourth task was started below the cap');

    await engine.setConcurrency(4);
    await settle();
    assert.equal(effector.inspect().length, 4);
  });

  it('stops everything when the board stops', async () => {
    const tasks = [task('A'), task('B'), task('C')];
    const { engine, effector } = await harness({
      tasks,
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(3);
    await settle();
    assert.equal(effector.inspect().length, 3);

    await engine.stopBoard('user');
    await settle();
    assert.equal(effector.inspect().length, 0, 'stopping the board left work running');
  });
});

// ── Policy ───────────────────────────────────────────────────────────────────

describe('engine — the policy has one application point', () => {
  it('retries, then abandons, then skips what the abandonment stranded', async () => {
    const tasks = [
      task('A'),
      task('B', { dependsOn: ['A'], touches: ['src/b/**'] }),
      task('C', { touches: ['src/c/**'] }),
    ];
    const { engine, clock, boardId } = await harness({
      tasks,
      script: [{ match: { taskId: 'A' }, emit: { outcome: 'fail' } }, { emit: { outcome: 'pass' } }],
    });
    await runToCompletion(engine, clock, 2);

    const state = engine.getState();
    assert.equal(state.tasks.get('A').phase, 'abandoned');
    assert.equal(state.tasks.get('B').phase, 'skipped');
    assert.equal(state.tasks.get('B').skippedBy, 'A');
    assert.equal(state.tasks.get('C').phase, 'merged');
    assert.equal(state.finished, true);

    const events = await readEvents(boardId);
    const abandon = events.find((e) => e.type === 'task.abandoned');
    assert.equal(abandon.taskId, 'A');
    assert.equal(abandon.reason, 'builder-failed');
    assert.ok(abandon.evidence, 'the abandonment carries no evidence');
    assert.ok(abandonmentEvidenceIsComplete(abandon.evidence));
    assert.ok(abandon.evidence.attempts.length >= 3);
    assert.equal(
      events.filter((e) => e.type === 'task.attempt.started' && e.taskId === 'A').length,
      3,
    );
  });

  it('re-opens the owning task on a merge conflict rather than spawning a fixer', async () => {
    const { engine, clock, boardId } = await harness({
      script: [
        { match: { role: 'merge', nth: 1 }, emit: { outcome: 'conflicted', files: ['src/a.ts'] } },
        { emit: { outcome: 'pass' } },
      ],
    });
    await runToCompletion(engine, clock, 1);

    const events = await readEvents(boardId);
    assert.equal(events.filter((e) => e.type === 'merge.conflicted').length, 1);
    assert.equal(events.filter((e) => e.type === 'merge.succeeded').length, 1);
    const seeds = events
      .filter((e) => e.type === 'task.attempt.started')
      .map((e) => e.seedKind);
    assert.ok(seeds.includes('rebase'), `seeds were ${seeds.join(', ')}`);
    for (const event of events) assert.doesNotMatch(String(event.role ?? ''), /fixer/);
    assert.equal(engine.getState().tasks.get('A').phase, 'merged');
  });

  it('repairs a blocked builder in place instead of running an env-fixer', async () => {
    const { engine, clock, boardId } = await harness({
      script: [
        { match: { role: 'builder', nth: 1 }, emit: { outcome: 'blocked' } },
        { emit: { outcome: 'pass' } },
      ],
    });
    await runToCompletion(engine, clock, 1);

    const started = (await readEvents(boardId)).filter((e) => e.type === 'task.attempt.started');
    assert.deepEqual(
      started.map((e) => `${e.role}:${e.seedKind}`),
      ['builder:initial', 'builder:repair', 'tester:initial'],
    );
  });

  it('routes every outcome in the six-way union to the right next action', async () => {
    const cases = [
      ['pass', ['builder:initial', 'tester:initial']],
      ['fail', ['builder:initial', 'builder:failure-aware']],
      ['blocked', ['builder:initial', 'builder:repair']],
      ['no_report', ['builder:initial', 'builder:continue']],
      ['crashed', ['builder:initial', 'builder:continue']],
      ['timeout', ['builder:initial', 'builder:continue']],
    ];
    for (const [outcome, expected] of cases) {
      const { engine, boardId } = await harness({
        boardId: `o-${outcome}`,
        script: [
          { match: { role: 'builder', nth: 1 }, emit: { outcome } },
          { emit: { outcome: 'pass', delayMs: 9999 } },
        ],
      });
      await engine.startBoard(1);
      await settle();
      await engine.tick();
      await settle();

      const started = (await readEvents(boardId))
        .filter((e) => e.type === 'task.attempt.started')
        .map((e) => `${e.role}:${e.seedKind}`);
      assert.deepEqual(started.slice(0, 2), expected, outcome);
    }
  });
});

// ── Commands ─────────────────────────────────────────────────────────────────

describe('engine — commands', () => {
  it('records a stop and desires nothing afterwards', async () => {
    const { engine, effector } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(1);
    await settle();
    await engine.stopBoard('user');
    await settle();

    assert.equal(engine.getState().status, 'stopped');
    assert.equal(effector.inspect().length, 0);

    const before = effector.started.length;
    await engine.tick();
    await settle();
    assert.equal(effector.started.length, before, 'a stopped board started work');
  });

  it('starts one task on demand, outside the cap', async () => {
    const tasks = [task('A'), task('B')];
    const { engine, effector } = await harness({
      tasks,
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(1);
    await settle();
    assert.equal(effector.inspect().length, 1);

    assert.equal(await engine.startTask('B'), true);
    await settle();
    assert.deepEqual(
      effector.inspect().map((r) => r.taskId).sort(),
      ['A', 'B'],
    );
    assert.equal(await engine.startTask('B'), false);
  });

  it('emits every appended event to subscribers, in order', async () => {
/** @type {string[]} */
    const seen = [];
    const { engine, clock } = await harness();
    engine.subscribe((event) => seen.push(String(event.type)));
    await runToCompletion(engine, clock, 1);
    assert.deepEqual(seen.slice(0, 3), ['board.started', 'task.attempt.started', 'task.attempt.ended']);
    assert.ok(seen.includes('board.stopped'), 'end-of-run must journal board.stopped');
    assert.equal(seen.at(-1), 'run.report.written');
  });

  it('keeps a hand-started attempt running on a stopped board', async () => {
    const { engine, effector } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    assert.equal(engine.getState().status, 'created');

    assert.equal(await engine.startTask('A'), true);
    await settle();
    await engine.tick();
    await settle();

    assert.equal(effector.inspect().length, 1, 'the tick stopped what startTask began');
    const attempt = engine.getState().tasks.get('A').attempts.at(-1);
    assert.equal(attempt.manual, true);
    assert.equal(attempt.ended, false);
    assert.equal(engine.getState().tasks.get('A').phase, 'building');
  });

  it('picks up nothing else while stopped, however many ticks run', async () => {
    const { engine, effector } = await harness({
      tasks: [task('A'), task('B')],
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startTask('A');
    await settle();

    for (let i = 0; i < 5; i += 1) {
      await engine.tick();
      await settle();
    }
    assert.deepEqual(effector.started.map((s) => s.taskId), ['A']);
  });

  it('stops a hand-started attempt when the board is stopped', async () => {
    const { engine, effector } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startTask('A');
    await settle();
    assert.equal(effector.inspect().length, 1);

    await engine.stopBoard('user');
    await settle();
    assert.equal(effector.inspect().length, 0);
    assert.equal(engine.getState().tasks.get('A').attempts.at(-1).manual, false);

    await engine.tick();
    await settle();
    assert.equal(effector.inspect().length, 0, 'a stopped attempt came back');
  });

  it('lets a hand-started attempt finish, then advances nothing', async () => {
    const { engine, effector } = await harness();
    await engine.startTask('A');
    await settle();
    await engine.tick();
    await settle();

    const state = engine.getState();
    assert.equal(state.tasks.get('A').attempts.at(-1).outcome, 'pass');
    assert.equal(state.tasks.get('A').phase, 'idle');
    assert.deepEqual(effector.started.map((s) => s.role), ['builder']);
    assert.equal(state.status, 'created');

    assert.equal(await engine.startTask('A'), true);
    await settle();
    assert.deepEqual(effector.started.map((s) => s.role), ['builder', 'tester']);
  });

  it('reaps a hand-started attempt that vanishes, with no board running', async () => {
    const { engine, effector, clock } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startTask('A');
    await settle();

    effector.vanishAll();
    assert.ok(clock.pending > 0, 'no timer was armed for the manual attempt');
    await clock.advance(10_000);
    await settle();

    const attempt = engine.getState().tasks.get('A').attempts.at(-1);
    assert.equal(attempt.ended, true);
    assert.equal(attempt.outcome, 'crashed');
  });

  it('stops ticking once disposed', async () => {
    const { engine, effector, clock } = await harness({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
    });
    await engine.startBoard(1);
    await settle();
    const before = effector.started.length;

    engine.dispose();
    await engine.tick();
    await clock.advance(60_000);
    assert.equal(effector.started.length, before);
  });
});

// ── Registry ─────────────────────────────────────────────────────────────────

describe('engine — the registry', () => {
  async function coldBoard(boardId = 'reg') {
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', {
        boardId,
        planPath: 'plan.md',
        tasks: [task('A')],
        waves: [],
      }),
    );
    await appendEvent(boardId, makeEvent('board.started', { concurrency: 1 }));
    return boardId;
  }

  const effectorFactory = () =>
    createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 9999 } }] });

  it('never hands out an engine that has not finished loading', async () => {
    const boardId = await coldBoard();

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        const engine = await getEngine(boardId, effectorFactory, { tickMs: 60_000 });
        await engine.stopBoard('user');
        return engine.getState().status;
      }),
    );

    for (const result of results) {
      assert.equal(
        result.status,
        'fulfilled',
        `a concurrent caller failed: ${result.reason?.message}`,
      );
      assert.equal(result.value, 'stopped');
    }
  });

  it('gives every concurrent caller the same engine', async () => {
    const boardId = await coldBoard();
    const engines = await Promise.all(
      Array.from({ length: 4 }, () => getEngine(boardId, effectorFactory, { tickMs: 60_000 })),
    );
    for (const engine of engines) assert.equal(engine, engines[0]);
  });

  it('peeks nothing while a load is in flight', async () => {
    const boardId = await coldBoard();
    const loading = getEngine(boardId, effectorFactory, { tickMs: 60_000 });
    assert.equal(peekEngine(boardId), undefined);
    const engine = await loading;
    assert.equal(peekEngine(boardId), engine);
    assert.doesNotThrow(() => engine.getState());
  });

  it('retries a board whose load failed rather than caching the failure', async () => {
    await createBoard('broken');
    await appendEvent(
      'broken',
      makeEvent('board.created', {
        boardId: 'broken',
        planPath: 'plan.md',
        tasks: [task('A')],
        waves: [],
      }),
    );

    let attempts = 0;
    const failOnce = () => {
      attempts += 1;
      if (attempts > 1) return effectorFactory();
      return {
        inspect: () => [],
        start: async () => ({ attemptId: 'x' }),
        stop: async () => {},
        onEnd: () => {
          throw new Error('effector unavailable');
        },
      };
    };

    await assert.rejects(() => getEngine('broken', failOnce, { tickMs: 60_000 }));
    const engine = await getEngine('broken', failOnce, { tickMs: 60_000 });
    assert.equal(engine.getState().boardId, 'broken');
  });
});

// ── Dead ends ────────────────────────────────────────────────────────────────

describe('engine — dead ends never stall the run (MIN-712)', () => {
  it('skips a diamond DAG behind the abandoned root only', async () => {
    const tasks = [
      task('A'),
      task('B', { wave: 2, dependsOn: ['A'], touches: ['src/b/**'] }),
      task('C', { wave: 2, dependsOn: ['A'], touches: ['src/c/**'] }),
      task('D', { wave: 3, dependsOn: ['B', 'C'], touches: ['src/d/**'] }),
      task('E', { wave: 2, touches: ['src/e/**'] }),
    ];
    const { engine, clock, boardId } = await harness({
      tasks,
      script: [{ match: { taskId: 'A' }, emit: { outcome: 'fail' } }, { emit: { outcome: 'pass' } }],
    });
    await runToCompletion(engine, clock, 4);

    const state = engine.getState();
    assert.equal(state.tasks.get('A').phase, 'abandoned');
    assert.equal(state.tasks.get('B').phase, 'skipped');
    assert.equal(state.tasks.get('C').phase, 'skipped');
    assert.equal(state.tasks.get('D').phase, 'skipped');
    assert.equal(state.tasks.get('B').skippedBy, 'A');
    assert.equal(state.tasks.get('C').skippedBy, 'A');
    assert.equal(state.tasks.get('D').skippedBy, 'A');
    assert.equal(state.tasks.get('E').phase, 'merged');
    assert.equal(state.finished, true);

    const skips = (await readEvents(boardId)).filter((e) => e.type === 'task.skipped');
    assert.deepEqual(
      skips.map((e) => ({ taskId: e.taskId, blockedBy: e.blockedBy })),
      [
        { taskId: 'B', blockedBy: 'A' },
        { taskId: 'C', blockedBy: 'A' },
        { taskId: 'D', blockedBy: 'A' },
      ],
    );
  });

  it('starts an unrelated task on the tick immediately after abandonment', async () => {
    const tasks = [
      task('A'),
      task('B', { dependsOn: ['A'], touches: ['src/b/**'] }),
      task('C', { touches: ['src/c/**'] }),
    ];
    const { engine, clock, effector } = await harness({
      tasks,
      script: [{ match: { taskId: 'A' }, emit: { outcome: 'fail' } }, { emit: { outcome: 'pass' } }],
    });
    await engine.startBoard(1);
    for (let i = 0; i < 80; i += 1) {
      await settle();
      const st = engine.getState();
      if (st.finished) break;
      const startedC = effector.started.some((s) => s.taskId === 'C');
      if (st.tasks.get('A').phase === 'abandoned' && startedC) break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    const startedIds = effector.started.map((s) => s.taskId);
    const lastA = startedIds.lastIndexOf('A');
    const firstC = startedIds.indexOf('C');
    assert.ok(firstC > lastA, 'C must start after A was given up on');
    assert.deepEqual(
      startedIds.slice(lastA + 1, firstC),
      [],
      'the tick after abandonment started something other than C',
    );
    assert.equal(engine.getState().tasks.get('B').phase, 'skipped');

    for (let i = 0; i < 80 && !(await finishedWithReport(engine)); i += 1) {
      await settle();
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    assert.equal(engine.getState().tasks.get('C').phase, 'merged');
    assert.equal(engine.getState().finished, true);
  });

  it('reaches run.finished after abandoning the last runnable task', async () => {
    const { engine, clock, boardId } = await harness({
      tasks: [task('A')],
      script: [{ emit: { outcome: 'fail' } }],
    });
    await runToCompletion(engine, clock, 1);
    const state = engine.getState();
    assert.equal(state.tasks.get('A').phase, 'abandoned');
    assert.equal(state.finished, true);
    const types = (await readEvents(boardId)).map((e) => e.type);
    assert.ok(types.includes('task.abandoned'));
    assert.ok(types.includes('run.finished'), 'V1 silent-stall: the board idled instead of finishing');
  });

  it('does not skip a task that only shares a wave', async () => {
    const { engine, clock } = await harness({
      tasks: [task('A', { wave: 1 }), task('B', { wave: 1, touches: ['src/b/**'] })],
      script: [{ match: { taskId: 'A' }, emit: { outcome: 'fail' } }, { emit: { outcome: 'pass' } }],
    });
    await runToCompletion(engine, clock, 2);
    assert.equal(engine.getState().tasks.get('A').phase, 'abandoned');
    assert.equal(engine.getState().tasks.get('B').phase, 'merged');
    assert.equal(engine.getState().finished, true);
  });

  it('journals complete evidence on every task.abandoned and reconstructs it from the journal', async () => {
    const { engine, clock, boardId } = await harness({
      tasks: [task('A'), task('B', { touches: ['src/b/**'] })],
      script: [
        {
          match: { taskId: 'A' },
          emit: {
            outcome: 'fail',
            summary: 'types still fail',
            evidence: { testOutput: 'TS2339', blockers: ['src/a.ts'] },
          },
        },
        { emit: { outcome: 'pass' } },
      ],
    });
    await runToCompletion(engine, clock, 2);
    const events = await readEvents(boardId);
    const abandons = events.filter((e) => e.type === 'task.abandoned');
    assert.equal(abandons.length, 1);
    for (const event of abandons) {
      assert.ok(Array.isArray(event.evidence.attempts) && event.evidence.attempts.length > 0);
      assert.ok(abandonmentEvidenceIsComplete(event.evidence));
    }
    const queried = await loadAbandonments(boardId);
    assert.equal(queried.length, 1);
    assert.equal(queried[0].taskId, 'A');
    assert.ok(queried[0].evidence.attempts.length >= 3);
    assert.equal(queried[0].evidence.attempts[0].testOutput, 'TS2339');
    assert.ok(abandonmentEvidenceIsComplete(queried[0].evidence));
  });
});

// ── Exclusions ───────────────────────────────────────────────────────────────

describe('engine — what must not be in it', () => {
  it('has exactly one timer', async () => {
    const source = await fs.readFile(ENGINE_SOURCE, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.equal((code.match(/setTimeout\s*\(/g) ?? []).length, 1);
    assert.equal((code.match(/setInterval\s*\(/g) ?? []).length, 0);
    assert.equal((code.match(/setImmediate\s*\(/g) ?? []).length, 0);
    assert.equal((code.match(/queueMicrotask\s*\(/g) ?? []).length, 0);
  });

  it('contains no repair subsystem, by name', async () => {
    const source = await fs.readFile(ENGINE_SOURCE, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const banned of [
      'stallRecovery',
      'watchdog',
      'nudge',
      'selfHeal',
      'bootResume',
      'displayWake',
      'oomRecovery',
      'reconcileRunning',
      'PipelineHold',
      'reserveLaunchSlot',
    ]) {
      assert.equal(code.includes(banned), false, `engine.js contains ${banned}`);
    }
  });

  it('keeps no retry counters', async () => {
    const source = await fs.readFile(ENGINE_SOURCE, 'utf8');
    for (const banned of ['buildAttempts', 'testAttempts', 'fixerAttempts', 'envFixAttempts']) {
      assert.equal(source.includes(banned), false, `engine.js contains ${banned}`);
    }
  });

  it('does not statically import core/plan.js or core/derive.js', async () => {
    const source = await fs.readFile(ENGINE_SOURCE, 'utf8');
    assert.doesNotMatch(source, /from\s+['"]\.\/core\/plan\.js['"]/);
    assert.doesNotMatch(source, /from\s+['"]\.\/core\/derive\.js['"]/);
  });
});

// ── Reopen ───────────────────────────────────────────────────────────────────

describe('engine — reopen after finish', { concurrency: 1 }, () => {
  const slowPass = [{ emit: { outcome: 'pass', delayMs: 9999 } }];

  it('reopen puts an abandoned task back on the board', async () => {
    const { engine, clock } = await harness({
      boardId: 'reopen-abandoned',
      script: slowPass,
    });
    await engine.startBoard(1);
    await settle();
    const abandoned = await engine.abandonTask('A');
    assert.equal(abandoned, true);
    for (let i = 0; i < 40; i += 1) {
      await settle();
      if (engine.getState().finished || engine.getState().stopReason === 'user') break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    await drainReportWrite(engine);
    assert.equal(engine.getState().tasks.get('A').phase, 'abandoned');
    assert.equal(engine.getState().stopReason, 'terminal');

    const result = await engine.reopen();
    assert.equal(result.ok, true);
    assert.deepEqual(result.taskIds, ['A']);
    const state = engine.getState();
    assert.equal(state.finished, false);
    assert.equal(state.status, 'running');
    assert.equal(state.tasks.get('A').abandonedReason, null);
    assert.equal(['idle', 'building'].includes(state.tasks.get('A').phase), true);
  });

  it('reopen writes a second report after the next run.finished', async () => {
    const { engine, clock } = await harness({
      boardId: 'reopen-report',
      script: slowPass,
    });
    await engine.startBoard(1);
    await settle();
    assert.equal(await engine.abandonTask('A'), true);
    for (let i = 0; i < 40; i += 1) {
      await settle();
      if (engine.getState().finished) break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    await drainReportWrite(engine);
    assert.equal(journalHasReport(await engine.getEvents()), true);

    const result = await engine.reopen();
    assert.equal(result.ok, true);
    assert.equal(journalHasReport(await engine.getEvents()), false);

    for (let i = 0; i < 80; i += 1) {
      await settle();
      if (await finishedWithReport(engine)) break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    assert.equal(engine.getState().finished, true);
    assert.equal(journalHasReport(await engine.getEvents()), true);
    const types = (await engine.getEvents()).map((event) => event.type);
    assert.equal(types.filter((type) => type === 'run.finished').length, 2);
    assert.equal(types.filter((type) => type === REPORT_EVENT_TYPE).length, 2);
  });

  it('completes the board after fixing and re-verifying a failed integration check', async () => {
    const { engine, clock } = await harness({
      boardId: 'recheck-pass',
      script: [{ match: { role: 'final', nth: 1 }, emit: { outcome: 'fail' } }],
    });
    await runToCompletion(engine, clock);
    assert.equal(engine.getState().finalTest?.outcome, 'fail');
    assert.equal(engine.getState().stopReason, 'terminal');
    assert.equal((await engine.reopen()).ok, true);
    await runToCompletion(engine, clock);
    assert.equal(engine.getState().tasks.get('FIX-1').phase, 'merged');
    assert.equal(engine.getState().finalTest?.outcome, 'pass');
    assert.equal(engine.getState().stopReason, 'complete');
    assert.match(engine.getState().runSummary, /final test pass/);
    await engine.reload();
    assert.equal(engine.getState().finalTest?.outcome, 'pass');
  });

  it('reopen on an all-merged failed ladder adds FIX-1', async () => {
    const { engine, boardId, clock } = await harness({ boardId: 'reopen-fix' });
    await runToCompletion(engine, clock);
    await appendEvent(
      boardId,
      makeEvent('final.test.ended', { outcome: 'fail', runInstructions: 'command: npx tsc --noEmit\ncwd: /tmp' }),
      { now: clock.now },
    );
    await engine.reload();
    assert.equal(engine.getState().finalTest?.outcome, 'fail');

    const result = await engine.reopen();
    assert.equal(result.ok, true);
    assert.deepEqual(result.taskIds, ['FIX-1']);
    const state = engine.getState();
    assert.equal(state.finished, false);
    assert.equal(state.tasks.has('FIX-1'), true);
    assert.equal(state.tasks.get('FIX-1').title, 'Fix final integration test failure');
  });

  it('startBoard refuses a finished board', async () => {
    const { engine, clock } = await harness({ boardId: 'reopen-start-guard' });
    await runToCompletion(engine, clock);
    assert.equal(engine.getState().finished, true);
    assert.equal(await engine.startBoard(1), false);
    assert.equal(engine.getState().finished, true);
  });

  it('a failed ladder journals board.stopped { reason: terminal }', async () => {
    const { engine, clock } = await harness({
      boardId: 'reopen-terminal',
      script: slowPass,
    });
    await engine.startBoard(1);
    await settle();
    assert.equal(await engine.abandonTask('A'), true);
    for (let i = 0; i < 40; i += 1) {
      await settle();
      if (engine.getState().finished) break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    await drainReportWrite(engine);
    assert.equal(engine.getState().finished, true);
    assert.equal(engine.getState().stopReason, 'terminal');
  });
});

describe('engine — reset and rewind', { concurrency: 1 }, () => {
  const slowPass = [{ emit: { outcome: 'pass', delayMs: 9999 } }];

  it('resetTask wipes an abandoned card back to idle', async () => {
    const { engine } = await harness({
      boardId: 'reset-abandoned',
      script: slowPass,
    });
    await engine.startBoard(1);
    await settle();
    assert.equal(await engine.abandonTask('A'), true);
    // A running board would pick the idle card on the next tick. Stop first so
    // the assertion is "sits Planned", not "immediately started again".
    await engine.stopBoard('user');
    const result = await engine.resetTask('A');
    assert.equal(result.ok, true);
    assert.deepEqual(result.taskIds, ['A']);
    const task = engine.getState().tasks.get('A');
    assert.equal(task.phase, 'idle');
    assert.equal(task.attempts.length, 0);
    assert.equal(engine.getState().finished, false);
    const types = (await engine.getEvents()).map((event) => event.type);
    assert.ok(types.includes('task.reset'));
  });

  it('resetTask refuses a merged card', async () => {
    const { engine, clock } = await harness({ boardId: 'reset-merged' });
    await runToCompletion(engine, clock);
    const result = await engine.resetTask('A');
    assert.equal(result.ok, false);
    assert.match(result.reason, /Rewind/);
  });

  it('rewindFrom refuses a card that is not merged', async () => {
    const { engine } = await harness({ boardId: 'rewind-idle', script: slowPass });
    const result = await engine.rewindFrom('A');
    assert.equal(result.ok, false);
    assert.match(result.reason, /Reset/);
    const types = (await engine.getEvents()).map((event) => event.type);
    assert.equal(types.includes('board.rewound'), false);
  });

  it('rewindFrom does not journal when integration restore fails', async () => {
    const { engine, boardId } = await harness({ boardId: 'rewind-restore-miss' });
    // Merged in the journal, but there is no integration worktree in this harness.
    await appendEvent(
      boardId,
      makeEvent('merge.succeeded', { taskId: 'A', sha: 'deadbeef', beforeSha: 'abc123' }),
    );
    await engine.reload();
    const result = await engine.rewindFrom('A');
    assert.equal(result.ok, false);
    assert.match(result.reason, /integration/i);
    const types = (await engine.getEvents()).map((event) => event.type);
    assert.equal(types.includes('board.rewound'), false);
  });
});
