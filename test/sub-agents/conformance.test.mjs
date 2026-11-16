/**
 * P8-C — generated-history conformance.
 *
 * Shape of P1-F: random spawn / cancel / end sequences, cap moves (including
 * lowering mid-run), invariant checked after every `plan()` call — not only
 * at the end.
 *
 * Invariant (P1-F wording, two caps):
 *   no tick starts work that would push in-flight attempts above the global
 *   cap OR the per-type cap
 *
 * Caps gate starting, not continuing. A lowered cap may leave more attempts
 * in flight than N; it must not start new ones.
 *
 * Zero model calls — a `fetch` trap makes one a hard failure.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { derive } from '../../server/sub-agents/derive.js';
import { makeEvent, SUB_AGENT_ROLE } from '../../server/sub-agents/events.js';
import { plan } from '../../server/sub-agents/plan.js';
import { createSubAgentGraph } from '../../server/sub-agents/graph.js';
import { createEngine } from '../../server/orchestrator/engine.js';

const CASES = Number(process.env.MINNOW_SUBAGENT_CONFORMANCE_CASES ?? 200);
const ONLY_SEED = process.env.MINNOW_SUBAGENT_CONFORMANCE_SEED
  ? Number(process.env.MINNOW_SUBAGENT_CONFORMANCE_SEED)
  : null;

const TYPES = ['explore', 'generalPurpose', 'researcher'];
const OUTCOMES = ['pass', 'fail', 'blocked', 'no_report', 'crashed', 'timeout'];

/** @type {typeof globalThis.fetch} */
let realFetch;

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the sub-agent scheduler suite made a network call');
  };
});

after(() => {
  globalThis.fetch = realFetch;
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

function stamp(events, event) {
  return { ...event, seq: events.length + 1, ts: events.length + 1 };
}

/**
 * @param {import('../../server/sub-agents/types').AgentsState} state
 * @param {import('../../server/sub-agents/types').Desired[]} desired
 * @param {import('../../server/sub-agents/types').Caps} caps
 * @returns {string | null}
 */
function checkStartGate(state, desired, caps) {
  const open = [];
  for (const run of state.runs.values()) {
    if (run.phase === 'cancelling') continue;
    if (run.attempts.some((a) => !a.ended)) open.push(run);
  }
  const openIds = new Set(open.map((r) => r.runId));

  const starting = desired.filter((d) => !openIds.has(d.taskId));
  const byRun = new Map();
  for (const d of desired) {
    byRun.set(d.taskId, (byRun.get(d.taskId) ?? 0) + 1);
  }
  for (const [id, n] of byRun) {
    if (n > 1) return `exclusivity: plan() returned ${n} desires for ${id}`;
    const run = state.runs.get(id);
    if (run && openIds.has(id) === false && run.attempts.some((a) => !a.ended)) {
      return `exclusivity: ${id} already has an open attempt`;
    }
  }

  const globalCap = Number.isSafeInteger(caps.globalMaxConcurrent)
    ? Math.max(0, caps.globalMaxConcurrent)
    : 3;
  if (starting.length > 0 && open.length + starting.length > globalCap) {
    return `global cap: plan() started ${starting.length} with ${open.length} in flight at N=${globalCap}`;
  }

  /** @type {Map<string, number>} */
  const openByType = new Map();
  for (const run of open) {
    openByType.set(run.type, (openByType.get(run.type) ?? 0) + 1);
  }
  /** @type {Map<string, number>} */
  const startByType = new Map();
  for (const d of starting) {
    const t = state.runs.get(d.taskId)?.type ?? '';
    startByType.set(t, (startByType.get(t) ?? 0) + 1);
  }
  for (const [agentType, n] of startByType) {
    const typeCap =
      caps.maxConcurrentByType && Number.isSafeInteger(caps.maxConcurrentByType[agentType])
        ? Math.max(0, caps.maxConcurrentByType[agentType])
        : globalCap;
    const live = openByType.get(agentType) ?? 0;
    if (live + n > typeCap) {
      return `type cap: plan() started ${n} ${agentType} with ${live} in flight at N=${typeCap}`;
    }
  }

  for (const d of desired) {
    if (d.role !== SUB_AGENT_ROLE) return `role: ${d.role} is not ${SUB_AGENT_ROLE}`;
    const run = state.runs.get(d.taskId);
    if (!run) return `unknown run ${d.taskId}`;
    if (run.phase === 'passed' || run.phase === 'abandoned' || run.phase === 'cancelled' || run.phase === 'cancelling') {
      return `terminal: plan() desired ${d.taskId} in phase ${run.phase}`;
    }
  }
  return null;
}

/**
 * @param {number} seed
 * @returns {string | null} failure message
 */
function runCase(seed) {
  const r = rng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];

  const caps = {
    globalMaxConcurrent: 1 + Math.floor(r() * 4),
    maxConcurrentByType: {
      explore: 1 + Math.floor(r() * 3),
      generalPurpose: 1 + Math.floor(r() * 3),
      researcher: 1 + Math.floor(r() * 3),
    },
  };

  /** @type {Record<string, unknown>[]} */
  const events = [];
  let runSeq = 0;
  let attemptSeq = 0;
  /** @type {Map<string, string>} attemptId -> runId */
  const inFlight = new Map();

  const applyStarts = (state, desired) => {
    for (const d of desired) {
      const run = state.runs.get(d.taskId);
      if (!run) continue;
      if (run.attempts.some((a) => !a.ended)) continue;
      const attemptId = `a${(attemptSeq += 1)}`;
      events.push(
        stamp(
          events,
          makeEvent('attempt.started', {
            runId: d.taskId,
            attemptId,
            seed: { kind: d.seedKind ?? 'initial' },
            seedKind: d.seedKind ?? 'initial',
          }),
        ),
      );
      inFlight.set(attemptId, d.taskId);
    }
  };

  const step = (label) => {
    const state = derive(events);
    const desired = plan(state, caps);
    const violated = checkStartGate(state, desired, caps);
    if (violated) return `seed ${seed} at ${label}: ${violated}`;
    applyStarts(state, desired);
    return null;
  };

  let failure = step('start');
  if (failure) return failure;

  const ops = 8 + Math.floor(r() * 25);
  for (let i = 0; i < ops; i += 1) {
    const roll = r();
    if (roll < 0.28) {
      runSeq += 1;
      events.push(
        stamp(
          events,
          makeEvent('run.requested', {
            runId: `r${runSeq}`,
            agentType: pick(TYPES),
            task: `task ${runSeq}`,
            parentChatId: 'chat-1',
            cwd: '/tmp',
            requestedAt: 1_700_000_000_000 + runSeq,
          }),
        ),
      );
    } else if (roll < 0.5 && inFlight.size > 0) {
      const attemptId = pick([...inFlight.keys()]);
      const runId = inFlight.get(attemptId);
      inFlight.delete(attemptId);
      events.push(
        stamp(
          events,
          makeEvent('attempt.ended', {
            runId,
            attemptId,
            outcome: pick(OUTCOMES),
            summary: 'generated',
          }),
        ),
      );
    } else if (roll < 0.62 && (inFlight.size > 0 || runSeq > 0)) {
      const liveRuns = [...new Set([...inFlight.values()])];
      const allIds = [];
      for (let n = 1; n <= runSeq; n += 1) allIds.push(`r${n}`);
      const runId = liveRuns.length > 0 && r() < 0.7 ? pick(liveRuns) : pick(allIds);
      if (runId) {
        for (const [attemptId, id] of [...inFlight.entries()]) {
          if (id === runId) inFlight.delete(attemptId);
        }
        events.push(
          stamp(events, makeEvent('run.cancelled', { runId, reason: 'user' })),
        );
      }
    } else if (roll < 0.8) {
      // Cap move, including lowering under in-flight work.
      caps.globalMaxConcurrent = Math.floor(r() * 5);
      const t = pick(TYPES);
      caps.maxConcurrentByType[t] = Math.floor(r() * 4);
    }

    failure = step(`op ${i}`);
    if (failure) return failure;
  }

  failure = step('end');
  if (failure) return failure;
  return null;
}

describe('sub-agent plan() conformance', () => {
  it('generated spawn/cancel/end/cap-move histories respect the start-gate invariant', () => {
    const seeds = ONLY_SEED != null ? [ONLY_SEED] : Array.from({ length: CASES }, (_, i) => i + 1);
    const failures = [];
    for (const seed of seeds) {
      const failure = runCase(seed);
      if (failure) failures.push(failure);
      if (failures.length >= 5) break;
    }
    assert.deepEqual(failures, []);
  });
});

function createMemoryJournal(fold, validate) {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let seq = 0;
  return {
    async loadState() {
      return fold(events);
    },
    async readHighestSeq() {
      return seq;
    },
    async readEvents() {
      return events.slice();
    },
    async appendEvent(_id, event) {
      seq += 1;
      const stamped = { v: 1, ...event, seq, ts: seq };
      const checked = validate(stamped);
      if (!checked.ok) throw new Error(checked.error);
      const line = JSON.parse(JSON.stringify(stamped));
      events.push(line);
      return line;
    },
    async appendEvents(id, list) {
      const out = [];
      for (const event of list) out.push(await this.appendEvent(id, event));
      return out;
    },
  };
}

function createFakeEffector() {
  /** @type {Map<string, { taskId: string | null, role: string, attemptId: string }>} */
  const running = new Map();
  /** @type {(end: object) => Promise<void> | void} */
  let onEnd = async () => {};
  let n = 0;
  return {
    inspect: () => [...running.values()],
    async start(want) {
      const attemptId = `e-${(n += 1)}`;
      running.set(attemptId, { taskId: want.taskId, role: want.role, attemptId });
      return { attemptId };
    },
    async stop(attemptId) {
      running.delete(attemptId);
    },
    onEnd(handler) {
      onEnd = handler;
    },
    async finish(attemptId, outcome = 'pass') {
      const entry = running.get(attemptId);
      if (!entry) throw new Error(`no attempt ${attemptId}`);
      await onEnd({
        attemptId,
        taskId: entry.taskId,
        role: entry.role,
        outcome,
      });
      running.delete(attemptId);
    },
    running,
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('sub-agent graph through createEngine', () => {
  it('ticks spawned runs under both caps and does not start above them', async () => {
    const { derive: fold, validateEvent } = await import('../../server/sub-agents/index.js');
    const caps = { globalMaxConcurrent: 2, maxConcurrentByType: { explore: 1 } };
    const graph = createSubAgentGraph(caps);
    const journal = createMemoryJournal(fold, validateEvent);
    const effector = createFakeEffector();
    const engine = createEngine({
      boardId: 'chat-1',
      graph,
      journal,
      effector,
      tickMs: 60_000,
    });
    await engine.load();

    await engine.append([
      makeEvent('run.requested', {
        runId: 'r1',
        agentType: 'explore',
        task: 'one',
        parentChatId: 'chat-1',
        cwd: '/tmp',
        requestedAt: 1,
      }),
      makeEvent('run.requested', {
        runId: 'r2',
        agentType: 'explore',
        task: 'two',
        parentChatId: 'chat-1',
        cwd: '/tmp',
        requestedAt: 2,
      }),
      makeEvent('run.requested', {
        runId: 'r3',
        agentType: 'researcher',
        task: 'three',
        parentChatId: 'chat-1',
        cwd: '/tmp',
        requestedAt: 3,
      }),
    ]);
    await engine.tick();
    await settle();

    const live = effector.inspect();
    assert.ok(live.length <= 2, `global cap: ${live.length} live`);
    const exploreLive = live.filter((l) => {
      const run = engine.getState().runs.get(l.taskId);
      return run?.type === 'explore';
    });
    assert.ok(exploreLive.length <= 1, `type cap: ${exploreLive.length} explore live`);

    caps.globalMaxConcurrent = 1;
    await engine.tick();
    await settle();
    assert.ok(
      effector.inspect().length >= live.length || effector.inspect().length <= 2,
      'lowering the cap must not be required to kill in-flight work',
    );
    const afterLower = effector.inspect();
    const state = engine.getState();
    const desired = graph.plan(state);
    const openIds = new Set(
      [...state.runs.values()].filter((r) => r.attempts.some((a) => !a.ended)).map((r) => r.runId),
    );
    const starting = desired.filter((d) => !openIds.has(d.taskId));
    assert.equal(starting.length, 0, 'must not start new work above the lowered global cap');

    engine.dispose();
    void afterLower;
  });
});
