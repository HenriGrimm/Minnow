import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';

import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { footprintsClash } from '../../server/orchestrator/core/plan.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';

const CASES = Number(process.env.MINNOW_CONFORMANCE_CASES ?? 500);
const ONLY_SEED = process.env.MINNOW_CONFORMANCE_SEED
  ? Number(process.env.MINNOW_CONFORMANCE_SEED)
  : null;

/** @type {typeof globalThis.fetch} */
let realFetch;
/** @type {string | undefined} */
let previousHome;
/** @type {string} */
let scratchHome;

before(() => {
  // The journal is in memory, but the engine still persists report.md under
  // MINNOW_HOME; keep thousands of generated boards out of the real ~/.minnow.
  previousHome = process.env.MINNOW_HOME;
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-conformance-'));
  process.env.MINNOW_HOME = scratchHome;
  resetMinnowHomeCache();
  realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the scheduler suite made a network call');
  };
});

after(() => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OUTCOMES = ['pass', 'fail', 'blocked', 'no_report', 'crashed', 'timeout'];

/**
 * @param {number} seed
 */
function generateCase(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];

  const taskCount = 3 + Math.floor(r() * 18);
  const waveCount = 1 + Math.floor(r() * 4);
  const sharedGlobs = ['src/shared/**', 'src/common/*.ts', 'package.json'];

/** @type {any[]} */
  const tasks = [];
  for (let i = 0; i < taskCount; i += 1) {
    const wave = 1 + Math.floor((i / taskCount) * waveCount);
/** @type {string[]} */
    const dependsOn = [];
    for (let j = 0; j < i; j += 1) {
      if (tasks[j].wave < wave && r() < 0.25) dependsOn.push(tasks[j].id);
    }
    const touches = r() < 0.3 ? [pick(sharedGlobs)] : [`src/t${i}/**`];
    tasks.push({
      id: `T${i}`,
      title: `Task ${i}`,
      wave,
      dependsOn,
      touches,
      build: 'b',
      test: 't',
      accept: 'a',
    });
  }

/** @type {any[]} */
  const script = [];
  for (const task of tasks) {
    const roll = r();
    if (roll < 0.45) {
      script.push({ match: { taskId: task.id }, emit: { outcome: 'pass', delayMs: 1 + Math.floor(r() * 50) } });
    } else if (roll < 0.6) {
      script.push({ match: { taskId: task.id, nth: 1 }, emit: { outcome: pick(OUTCOMES) } });
      script.push({ match: { taskId: task.id }, emit: { outcome: 'pass', delayMs: 1 } });
    } else if (roll < 0.72) {
      script.push({ match: { taskId: task.id }, emit: { outcome: pick(['fail', 'blocked', 'timeout']) } });
    } else if (roll < 0.82) {
      script.push({ match: { taskId: task.id, nth: 1 }, emit: { vanish: true } });
      script.push({ match: { taskId: task.id }, emit: { outcome: 'pass', delayMs: 1 } });
    } else if (roll < 0.9) {
      script.push({ match: { taskId: task.id, role: 'merge', nth: 1 }, emit: { outcome: 'conflicted', files: ['src/x.ts'] } });
      script.push({ match: { taskId: task.id }, emit: { outcome: 'pass', delayMs: 1 } });
    } else {
      script.push({ match: { taskId: task.id }, emit: { outcome: pick(OUTCOMES), delayMs: 1 } });
    }
  }
  script.push({ emit: { outcome: 'pass', delayMs: 1 } });

  return { tasks, script };
}

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
    /**
     * Advance wall time and await any timer callbacks that return a Promise
     * (the engine tick is async). Callers must `await clock.advance(...)`.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    async advance(ms) {
      now += ms;
      /** @type {Promise<unknown>[]} */
      const pending = [];
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(handle);
          const result = timer.fn();
          if (result && typeof /** @type {{ then?: unknown }} */ (result).then === 'function') {
            pending.push(/** @type {Promise<unknown>} */ (result));
          }
        }
      }
      if (pending.length > 0) await Promise.all(pending);
    },
    get pending() {
      return timers.size;
    },
  };
}

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {import('../../server/orchestrator/core/types').BoardState} state
 * @param {Array<{ taskId: string | null, role: string, attemptId?: string }>} live
 * @param {number} cap
 * @param {Set<string>} [wereLive]  attempt ids live at the previous check
 * @returns {string | null} the violated invariant, or null
 */
function checkInvariants(state, live, cap, wereLive = new Set()) {
  const nonMerge = live.filter((r) => r.role !== 'merge' && r.role !== 'final');

  if (state.status === 'running' && nonMerge.length > cap) {
    const fresh = nonMerge.filter((r) => r.attemptId !== undefined && !wereLive.has(r.attemptId));
    if (fresh.length > 0) {
      return `cap: a tick started ${fresh.length} attempt(s) with ${nonMerge.length} live at N=${cap}`;
    }
  }

  const byTask = new Map();
  for (const entry of live) {
    if (entry.taskId === null) continue;
    byTask.set(entry.taskId, (byTask.get(entry.taskId) ?? 0) + 1);
  }
  for (const [taskId, count] of byTask) {
    if (count > 1) return `exclusivity: ${count} attempts on ${taskId}`;
  }

  const ids = nonMerge.map((r) => r.taskId).filter(Boolean);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = state.tasks.get(/** @type {string} */ (ids[i]));
      const b = state.tasks.get(/** @type {string} */ (ids[j]));
      if (a && b && footprintsClash(a, b)) {
        return `touches: ${ids[i]} and ${ids[j]} overlap`;
      }
    }
  }

  const merges = live.filter((r) => r.role === 'merge');
  if (merges.length > 1) return `merge: ${merges.length} merges in flight`;

  for (const task of state.tasks.values()) {
    if (task.attempts.length === 0) continue;
    for (const dep of task.dependsOn) {
      const upstream = state.tasks.get(dep);
      if (upstream && upstream.phase !== 'merged' && upstream.mergedSha === null) {
        return `dependency: ${task.id} started before ${dep} merged`;
      }
    }
  }

  return null;
}

/**
 * @param {import('../../server/orchestrator/core/types').BoardState} state
 * @returns {string | null}
 */
function checkProgress(state) {
/** @param {string} id @param {Set<string>} seen */
  const dependsOnTransitively = (id, target, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const task = state.tasks.get(id);
    if (!task) return false;
    if (task.dependsOn.includes(target)) return true;
    return task.dependsOn.some((dep) => dependsOnTransitively(dep, target, seen));
  };

  const broken = [...state.tasks.values()].filter((t) => t.phase === 'abandoned');
  for (const task of state.tasks.values()) {
    if (task.phase !== 'skipped') continue;
    const because = broken.some((b) => dependsOnTransitively(task.id, b.id));
    const chained = task.skippedBy !== null;
    if (!because && !chained) return `progress: ${task.id} was skipped by nothing it depends on`;
  }
  return null;
}

/**
 * @param {number} seed
 * @param {number} cap
 * @param {{ perturb?: boolean, wrapEffector?: (inner: any) => any }} [options]
 * @returns {Promise<{ journal: any[], ticks: number }>}
 */
async function runCase(seed, cap, options = {}) {
  const { tasks, script } = generateCase(seed);
  const boardId = `c${seed}-${cap}${options.perturb ? '-p' : ''}`;
  const clock = fakeClock();
  const journal = createMemoryJournal();

  await journal.createBoard(boardId);
  await journal.appendEvent(
    boardId,
    makeEvent('board.created', { boardId, planPath: 'gen.md', tasks, waves: [] }),
    { now: clock.now },
  );

  const truth = createScriptedEffector({ script, clock });
  const effector = options.wrapEffector ? options.wrapEffector(truth) : truth;
  const engine = createEngine({
    boardId,
    effector,
    clock,
    tickMs: 1000,
    journal,
    complete: async () => '',
  });
  await engine.load();

  let wereLive = new Set();

  let commandedCap = cap;

/** @param {string} stage */
  const check = (stage) => {
    const state = engine.getState();
    const live = truth.inspect();
    const violated =
      checkInvariants(state, live, commandedCap, wereLive) ?? checkProgress(state);
    wereLive = new Set(live.map((r) => r.attemptId));
    if (violated) {
      return `seed ${seed} cap ${cap} at ${stage}: ${violated}`;
    }
    return null;
  };

  const r = rng(seed ^ 0x5eed);
/**
 * @param {number} i  the tick number
 * @returns {Promise<void>}
 */
  const perturb = async (i) => {
    if (!options.perturb) return;
    const roll = r();
    const state = engine.getState();
    if (roll < 0.12) {
      commandedCap = 1 + Math.floor(r() * 4);
      await engine.setConcurrency(commandedCap);
    } else if (roll < 0.18 && state.status === 'running') {
      await engine.stopBoard('user');
    } else if (roll < 0.26 && state.status !== 'running' && !state.finished) {
      const ids = [...state.tasks.keys()];
      if (ids.length > 0) await engine.startTask(ids[Math.floor(r() * ids.length)]);
      await settle();
      commandedCap = 1 + Math.floor(r() * 4);
      await engine.startBoard(commandedCap);
    } else if (state.status !== 'running' && !state.finished && i > 3) {
      commandedCap = cap;
      await engine.startBoard(commandedCap);
    }
    await settle();
  };

  try {
    await engine.startBoard(cap);
    await settle();
    let failure = check('start');
    if (failure) return { failure, engine, boardId, events: journal.readEventsSync(boardId) };

    const maxTicks = 60 + tasks.length * 30;
    for (let i = 0; i < maxTicks; i += 1) {
      if (engine.getState().finished) {
        const before = journal.readEventsSync(boardId);
        await engine.tick();
        await engine.tick();
        await settle();
        const afterEvents = journal.readEventsSync(boardId);
        if (afterEvents.length !== before.length) {
          return {
            failure: `seed ${seed} cap ${cap}: extra ticks appended ${afterEvents.length - before.length} events`,
            engine,
            boardId,
            events: afterEvents,
          };
        }
        return { journal: afterEvents, ticks: i, engine, boardId };
      }

      await engine.tick();
      await settle();
      failure = check(`tick ${i}`);
      if (failure) return { failure, engine, boardId, events: journal.readEventsSync(boardId) };

      await perturb(i);
      failure = check(`perturb ${i}`);
      if (failure) return { failure, engine, boardId, events: journal.readEventsSync(boardId) };

      if (clock.pending > 0) {
        await clock.advance(200);
        await settle();
        failure = check(`timers ${i}`);
        if (failure) return { failure, engine, boardId, events: journal.readEventsSync(boardId) };
      }
    }

    return {
      failure: `seed ${seed} cap ${cap}: did not reach run.finished in ${maxTicks} ticks`,
      engine,
      boardId,
      events: journal.readEventsSync(boardId),
    };
  } finally {
    engine.dispose();
  }
}

/**
 * @param {string} failure
 * @param {string} boardId
 * @param {Record<string, unknown>[]} journal
 */
function explain(failure, boardId, journal) {
  const lines = journal.map((e) => `  ${e.seq} ${e.type} ${JSON.stringify({ ...e, v: undefined, seq: undefined, ts: undefined, type: undefined })}`);
  return [
    failure,
    `rerun with: MINNOW_CONFORMANCE_SEED=${/c(\d+)-/.exec(boardId)?.[1] ?? '?'}`,
    'journal:',
    ...lines,
  ].join('\n');
}

describe('scheduler conformance', () => {
  const seeds = ONLY_SEED === null
    ? Array.from({ length: CASES }, (_, i) => i + 1)
    : [ONLY_SEED];

  for (const cap of [1, 2, 4]) {
    it(`holds all eight invariants at N=${cap} across ${seeds.length} generated DAGs`, async () => {
      let finished = 0;
      for (const seed of seeds) {
        const result = await runCase(seed, cap);
        if (result.failure) {
          assert.fail(explain(result.failure, result.boardId, result.events ?? []));
        }
        finished += 1;
      }
      assert.equal(finished, seeds.length);
    });
  }

  it('holds them all while N, stop/start, and manual starts are moved mid-run', async () => {
    const perturbed = ONLY_SEED === null
      ? Array.from({ length: Math.min(seeds.length, 150) }, (_, i) => i + 1)
      : [ONLY_SEED];
    for (const seed of perturbed) {
      const result = await runCase(seed, 2, { perturb: true });
      if (result.failure) {
        assert.fail(explain(result.failure, result.boardId, result.events ?? []));
      }
    }
  });

  it('reproduces a seed to an identical journal, 50 times over', async () => {
    const strip = (events) =>
      events.map((e) => ({
        type: e.type,
        taskId: e.taskId,
        role: e.role,
        outcome: e.outcome,
        reason: e.reason,
      }));

    for (let seed = 90_001; seed <= 90_050; seed += 1) {
      const first = await runCase(seed, 2);
      assert.equal(first.failure, undefined, String(first.failure));
      const rerun = await runCase(seed, 2);
      assert.equal(rerun.failure, undefined, String(rerun.failure));
      assert.deepEqual(strip(rerun.journal), strip(first.journal), `seed ${seed}`);
    }
  });

  it('fails a real run that over-starts, through the driver itself', async () => {
    const result = await runCase(4_242, 1, {
      wrapEffector: (inner) => ({
        start: (d) => inner.start(d),
        stop: (id) => inner.stop(id),
        onEnd: (h) => inner.onEnd(h),
        inspect() {
          const all = inner.inspect();
          const hidden = all.find((entry) => entry.role === 'builder' || entry.role === 'tester');
          return hidden ? all.filter((entry) => entry !== hidden) : all;
        },
      }),
    });

    assert.ok(result.failure, 'the driver passed a board that over-started');
    assert.match(result.failure, /cap: a tick started/);
  });

  it('rejects an over-started board on the invariant check itself', async () => {
    const state = derive([
      {
        v: 1,
        seq: 1,
        ts: 1,
        type: 'board.created',
        boardId: 'x',
        planPath: 'p',
        waves: [],
        tasks: [
          { id: 'A', title: 'A', wave: 1, dependsOn: [], touches: ['src/a/**'] },
          { id: 'B', title: 'B', wave: 1, dependsOn: [], touches: ['src/b/**'] },
        ],
      },
      { v: 1, seq: 2, ts: 2, type: 'board.started', concurrency: 1 },
    ]);
    const live = [
      { taskId: 'A', role: 'builder', attemptId: 'a1' },
      { taskId: 'B', role: 'builder', attemptId: 'b1' },
    ];
    assert.match(checkInvariants(state, live, 1) ?? '', /^cap: a tick started 2/);
    assert.equal(checkInvariants(state, live, 2), null);

    assert.equal(checkInvariants(state, live, 1, new Set(['a1', 'b1'])), null);
    assert.match(
      checkInvariants(
        state,
        [...live, { taskId: 'C', role: 'builder', attemptId: 'c1' }],
        1,
        new Set(['a1', 'b1']),
      ) ?? '',
      /^cap: a tick started 1/,
    );
  });

  it('catches each of the other structural violations', async () => {
    const state = derive([
      {
        v: 1,
        seq: 1,
        ts: 1,
        type: 'board.created',
        boardId: 'x',
        planPath: 'p',
        waves: [],
        tasks: [
          { id: 'A', title: 'A', wave: 1, dependsOn: [], touches: ['src/shared/**'] },
          { id: 'B', title: 'B', wave: 1, dependsOn: [], touches: ['src/shared/x.ts'] },
          { id: 'C', title: 'C', wave: 2, dependsOn: ['A'], touches: ['src/c/**'] },
        ],
      },
    ]);

    assert.match(
      checkInvariants(state, [
        { taskId: 'A', role: 'builder' },
        { taskId: 'A', role: 'tester' },
      ], 4) ?? '',
      /^exclusivity/,
    );
    assert.match(
      checkInvariants(state, [
        { taskId: 'A', role: 'builder' },
        { taskId: 'B', role: 'builder' },
      ], 4) ?? '',
      /^touches/,
    );
    assert.match(
      checkInvariants(state, [
        { taskId: 'A', role: 'merge' },
        { taskId: 'B', role: 'merge' },
      ], 4) ?? '',
      /^merge/,
    );
  });

  it('makes no network call', () => {
    assert.throws(() => globalThis.fetch('http://example.com'), /network call/);
  });
});
