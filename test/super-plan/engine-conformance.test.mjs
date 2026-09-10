/**
 * W3-A — Super Plan engine conformance.
 *
 * Drives `createEngine` with the Super Plan graph (`server/super-plan/graph.js`)
 * and the scripted effector (`server/orchestrator/effector-scripted.js`), which
 * proves the Effector seam: a role-agnostic effector can run the whole
 * pipeline headlessly. The split effector (`server/super-plan/effector-split.js`)
 * must be swappable for it, so the full-pipeline test runs both and asserts the
 * same journal outcome.
 *
 * Covered, per the W3-A Test section:
 * - full pipeline under scripted outcomes reaches `run.finished` with
 *   `planPath` artifacts written
 * - crash-and-reload: `load()` twice produces no duplicate `stage.started`
 * - reap-vanished attempt → `crashed` + replan (continue seed)
 * - tick-quiescence: a finished run appends nothing on extra ticks (V2
 *   conformance assertion)
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createEngine } from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { derive } from '../../server/super-plan/derive.js';
import { makeEvent, validateEvent } from '../../server/super-plan/events.js';
import { superPlanGraph } from '../../server/super-plan/graph.js';
import { createSplitEffector } from '../../server/super-plan/effector-split.js';
import { createHeadlessEffector, HEADLESS_ROLES } from '../../server/super-plan/effector-headless.js';

const RUN_ID = 'run-1';
const PROMPT = 'Build a Kanban UI';
const WORKSPACE = '/tmp/kanban';
const SPEC_PATH = 'documentation/plans/references/kanban-spec.md';
const RESEARCH_PATH = 'documentation/research/kanban.md';
const PLAN_PATH = 'documentation/plans/kanban.md';
const CONFIG = { reviewRounds: 1, research: true, interview: true, polish: 'always' };

function fakeClock() {
  let now = 1_700_000_000_000;
/** @type {Map<number, { at: number, fn: () => void | Promise<void> }>} */
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
     * @param {number} ms
     * @returns {Promise<void>}
     */
    async advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(handle);
          const result = timer.fn();
          if (result && typeof /** @type {{ then?: unknown }} */ (result).then === 'function') {
            await result;
          }
        }
      }
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * In-memory journal folded by the Super Plan derive, mirroring the sub-agent
 * conformance suite's journal but with a sync reader for the quiescence check.
 */
function createMemoryJournal() {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let seq = 0;
  return {
    async loadState() {
      return derive(events);
    },
    async readHighestSeq() {
      return seq;
    },
    async readEvents() {
      return events.slice();
    },
    async appendEvent(_id, event, _opts = {}) {
      seq += 1;
      const stamped = { v: 1, ...event, seq, ts: seq };
      const checked = validateEvent(stamped);
      if (!checked.ok) throw new Error(`refusing to journal an invalid event: ${checked.error}`);
      const line = JSON.parse(JSON.stringify(stamped));
      events.push(line);
      return line;
    },
    async appendEvents(id, list, opts = {}) {
      const out = [];
      for (const event of list) out.push(await this.appendEvent(id, event, opts));
      return out;
    },
    readEventsSync() {
      return events.slice();
    },
  };
}

/**
 * Open a run and load an engine over the given effector.
 *
 * @param {{ effector: any, script?: any[], clock?: ReturnType<typeof fakeClock> }} opts
 */
async function openRun(opts) {
  const journal = createMemoryJournal();
  const clock = opts.clock ?? fakeClock();
  const effector =
    opts.effector ??
    createScriptedEffector({ script: [{ match: { role: 'gate' }, emit: { outcome: 'pass', delayMs: 1000 } }, { match: { role: 'review' }, emit: { outcome: 'pass', evidence: { findings: [] } } }, ...(opts.script ?? [{ emit: { outcome: 'pass' } }])], clock });
  const engine = createEngine({
    boardId: RUN_ID,
    graph: superPlanGraph,
    effector,
    clock,
    tickMs: 60_000,
    journal,
  });
  await engine.load();
  await engine.append([
    makeEvent('run.created', { runId: RUN_ID, prompt: PROMPT, workspacePath: WORKSPACE, config: CONFIG }),
    makeEvent('run.started', {}),
  ]);
  return { engine, journal, clock, effector };
}

/**
 * Drive a run to completion, playing the controller role the renderer owns in
 * the product: journal artifact events after their stage succeeds and answer
 * gates when they open. The engine only journals stage starts/ends and the
 * graph's implied gate-opened / run-finished events.
 *
 * @param {ReturnType<typeof openRun>} h
 * @param {{ maxTicks?: number }} [opts]
 */
async function driveToFinished(h, opts = {}) {
  const { engine, clock } = h;
  const seen = new Set();
  for (let i = 0; i < (opts.maxTicks ?? 300); i += 1) {
    await settle();
    const state = engine.getState();
    if (state.finished) return state;

    // A stage record is durable once its stage has ended ok, so drive the
    // artifacts from any *recorded* ok fact — the latest record is only the
    // most recent one, not the one the controller reacts to.
    for (const record of state.stageRecords) {
      if (record.outcome !== 'ok') continue;
      if (record.stage === 'interview' && !seen.has('spec')) {
        seen.add('spec');
        await engine.append([makeEvent('spec.written', { path: SPEC_PATH })]);
      }
      if (record.stage === 'research' && !seen.has('research')) {
        seen.add('research');
        await engine.append([makeEvent('research.written', { path: RESEARCH_PATH })]);
      }
      if (record.stage === 'draft' && !seen.has('plan')) {
        seen.add('plan');
        await engine.append([makeEvent('plan.written', { path: PLAN_PATH })]);
      }
      if (record.stage === 'review' && !seen.has('review') && state.reviews.length === 0) {
        seen.add('review');
        await engine.append([makeEvent('review.recorded', { round: 1, findings: [] })]);
      }
    }

    if (state.pendingGate && !state.gate) await engine.append([makeEvent('gate.opened', { kind: state.pendingGate })]);
    if (engine.getState().gate?.status === 'open') {
      const kind = engine.getState().gate.kind;
      const verdict = kind === 'spec' ? 'confirm' : 'accept';
      await engine.append([makeEvent('gate.answered', { kind, verdict })]);
    }

    await engine.tick();
    await settle();
    if (clock.pending > 0) await clock.advance(10_000);
    await settle();
  }
  assert.fail(`run ${RUN_ID} did not finish in ${opts.maxTicks} ticks`);
}

/** @type {Array<{ dispose: () => void }>} */
const live = [];

after(() => {
  for (const engine of live) engine.dispose();
  live.length = 0;
});

beforeEach(() => {
  for (const engine of live) engine.dispose();
  live.length = 0;
});

describe('super-plan engine conformance', () => {
  it('scripted full pipeline reaches run.finished with planPath artifacts written', async () => {
    const h = await openRun({});
    live.push(h.engine);
    const state = await driveToFinished(h);

    assert.equal(state.finished, true);
    assert.equal(state.runOutcome, 'pass');
    assert.equal(state.stopReason, 'complete');
    assert.equal(state.planPath, PLAN_PATH);
    assert.equal(state.specPath, SPEC_PATH);
    assert.equal(state.researchPath, RESEARCH_PATH);

    const events = h.journal.readEventsSync();
    const types = events.map((e) => e.type);
    const stages = events
      .filter((e) => e.type === 'stage.started')
      .map((e) => e.stage);
    assert.deepEqual(stages, ['interview', 'gate', 'research', 'draft', 'review', 'polish', 'gate']);
    assert.ok(types.includes('review.recorded'));
    assert.ok(types.includes('gate.opened'));
    assert.ok(types.includes('gate.answered'));
    assert.ok(types.includes('run.finished'));
  });

  it('split effector is swappable for the scripted effector on the full pipeline', async () => {
    const clock = fakeClock();
    const script = [{ match: { role: 'gate' }, emit: { outcome: 'pass', delayMs: 1000 } }, { match: { role: 'review' }, emit: { outcome: 'pass', evidence: { findings: [] } } }, { emit: { outcome: 'pass' } }];
    const h = await openRun({
      clock,
      effector: createSplitEffector({ script, clock }),
    });
    live.push(h.engine);
    const state = await driveToFinished(h);

    assert.equal(state.finished, true);
    assert.equal(state.planPath, PLAN_PATH);
    const events = h.journal.readEventsSync();
    assert.deepEqual(
      events.filter((e) => e.type === 'stage.started').map((e) => e.stage),
      ['interview', 'gate', 'research', 'draft', 'review', 'polish', 'gate'],
    );
    assert.equal(
      h.effector.started.length,
      7,
      `split started ${h.effector.started.length} attempts`,
    );
  });

  it('crash-and-reload: load() twice produces no duplicate stage.started', async () => {
    const clock = fakeClock();
    const journal = createMemoryJournal();
    const slow = createScriptedEffector({
      script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }],
      clock,
    });
    const first = createEngine({
      boardId: RUN_ID,
      graph: superPlanGraph,
      effector: slow,
      clock,
      tickMs: 60_000,
      journal,
    });
    live.push(first);
    await first.load();
    await first.append([
      makeEvent('run.created', { runId: RUN_ID, prompt: PROMPT, workspacePath: WORKSPACE, config: CONFIG }),
      makeEvent('run.started', {}),
    ]);
    await first.tick();
    await settle();
    assert.equal(
      journal.readEventsSync().filter((e) => e.type === 'stage.started').length,
      1,
      'the first engine did not start the interview',
    );

    // Double-load the SAME engine: the load seam must be idempotent. The open
    // interview attempt is still in the effector's inspect(), so a tick must
    // not journal a second stage.started for it.
    await first.load();
    await first.load();
    await first.tick();
    await settle();
    assert.equal(
      journal.readEventsSync().filter((e) => e.type === 'stage.started').length,
      1,
      'load() twice re-journaled the open stage.started',
    );

    // Crash: the attempt vanishes without an end. Reload the same journal with
    // a fresh engine; load() twice must not re-journal the same stage.started,
    // and the vanished attempt must be reaped as crashed before a replan.
    slow.vanishAll();
    first.dispose();

    const resumed = createScriptedEffector({
      script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }],
      clock,
    });
    const second = createEngine({
      boardId: RUN_ID,
      graph: superPlanGraph,
      effector: resumed,
      clock,
      tickMs: 60_000,
      journal,
    });
    live.push(second);
    await second.load();
    await second.load(); // double-load: the reload seam must be idempotent
    await second.tick();
    await settle();

    const startedEvents = journal
      .readEventsSync()
      .filter((e) => e.type === 'stage.started');
    const interviewStarts = startedEvents.filter((e) => e.stage === 'interview');
    // The scripted effector restarts its counter at s1, so the replan shares
    // the id — the invariant is the seed: one initial, one continue.
    assert.equal(interviewStarts.length, 2, 'interview must start once, then replan once');
    assert.equal(
      interviewStarts.filter((e) => e.seedKind === 'initial').length,
      1,
      'the original stage.started must not be re-journaled as initial',
    );
    assert.equal(
      interviewStarts.filter((e) => e.seedKind === 'continue').length,
      1,
      'the replan must carry the continue seed',
    );
    const crashed = journal
      .readEventsSync()
      .filter((e) => e.type === 'stage.ended' && e.outcome === 'crashed');
    assert.equal(crashed.length, 1, 'the vanished attempt must be reaped as crashed');
    assert.equal(crashed[0].stage, 'interview');
  });

  it('reap-vanished attempt → crashed + replan with a continue seed', async () => {
    const h = await openRun({
      script: [{ emit: { outcome: 'pass', delayMs: 60_000 } }],
    });
    live.push(h.engine);
    await h.engine.tick();
    await settle();
    assert.equal(h.effector.inspect().length, 1);

    h.effector.vanishAll();
    assert.equal(h.effector.inspect().length, 0);
    await h.engine.tick();
    await settle();

    const events = h.journal.readEventsSync();
    const crashed = events.filter((e) => e.type === 'stage.ended' && e.outcome === 'crashed');
    assert.equal(crashed.length, 1);
    assert.equal(crashed[0].stage, 'interview');
    const started = events.filter((e) => e.type === 'stage.started');
    assert.equal(started.length, 2, 'the vanished attempt must replan');
    assert.equal(started[1].stage, 'interview');
    assert.equal(started[1].seedKind, 'continue');
  });

  it('a finished run appends nothing on extra ticks (V2 conformance assertion)', async () => {
    const h = await openRun({});
    live.push(h.engine);
    await driveToFinished(h);
    assert.equal(h.engine.getState().finished, true);

    const before = h.journal.readEventsSync().length;
    await h.engine.tick();
    await h.engine.tick();
    await settle();
    assert.equal(
      h.journal.readEventsSync().length,
      before,
      `extra ticks appended ${h.journal.readEventsSync().length - before} events`,
    );
  });
});

describe('super-plan effector-headless', () => {
  it('exports the headless roles and the Effector surface', () => {
    assert.deepEqual([...HEADLESS_ROLES], ['research', 'review', 'polish']);
    const eff = createHeadlessEffector({ getState: () => derive([]) });
    assert.equal(typeof eff.inspect, 'function');
    assert.equal(typeof eff.start, 'function');
    assert.equal(typeof eff.stop, 'function');
    assert.equal(typeof eff.onEnd, 'function');
    assert.deepEqual(eff.inspect(), []);
  });

  it('rejects a non-headless role at start', async () => {
    const eff = createHeadlessEffector({ getState: () => derive([]) });
    await assert.rejects(
      () => eff.start({ taskId: RUN_ID, role: 'interview', seedKind: 'initial' }),
      /unsupported role interview/,
    );
  });
});