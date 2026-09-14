import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import {
  abandonmentEvidenceIsComplete,
} from '../../server/orchestrator/core/evidence.js';
import {
  isReadyForFinalTest,
  manualStart,
  nextAction,
  orderedTaskIds,
  pendingAbandonments,
  pendingEnqueues,
  pendingSkips,
  plan,
  reopenTargets,
  buildIntegrationFixTask,
  footprintsClash,
  globsIntersect,
  touchesOverlap,
} from '../../server/orchestrator/core/plan.js';

let seq = 0;
const stamp = (e) => ({ ...e, seq: (seq += 1), ts: seq });

/**
 * @param {{ tasks: Array<object>, concurrency?: number, running?: boolean }} setup
 * @param {...object} tail
 */
function boardOf(setup, ...tail) {
  seq = 0;
  const events = [
    stamp(makeEvent('board.created', {
      boardId: 'b',
      planPath: 'p.md',
      tasks: setup.tasks,
      waves: [],
    })),
  ];
  if (setup.running !== false) {
    events.push(stamp(makeEvent('board.started', { concurrency: setup.concurrency ?? 1 })));
  }
  for (const e of tail) events.push(stamp(e));
  return derive(events);
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

const started = (taskId, attemptId, role, extra = {}) =>
  makeEvent('task.attempt.started', { taskId, attemptId, role, ...extra });
const ended = (taskId, attemptId, role, outcome) =>
  makeEvent('task.attempt.ended', { taskId, attemptId, role, outcome });
const attempt = (taskId, attemptId, role, outcome) => [
  started(taskId, attemptId, role),
  ended(taskId, attemptId, role, outcome),
];
const merged = (taskId, sha) => [
  ...attempt(taskId, `${taskId}-b`, 'builder', 'pass'),
  ...attempt(taskId, `${taskId}-t`, 'tester', 'pass'),
  makeEvent('merge.enqueued', { taskId }),
  makeEvent('merge.succeeded', { taskId, sha }),
];

const nonMerge = (desires) => desires.filter((d) => d.role !== 'merge');

// ── Six rules ────────────────────────────────────────────────────────────────

describe('plan — the six rules', () => {
  it('rule 6: a board that is not running desires nothing', () => {
    const created = boardOf({ tasks: [task('A'), task('B')], running: false });
    assert.deepEqual(plan(created), []);

    const stopped = boardOf(
      { tasks: [task('A')], concurrency: 4 },
      makeEvent('board.stopped', { reason: 'user' }),
    );
    assert.deepEqual(plan(stopped), []);

    const stoppedMidRun = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 4 },
      started('A', 'a1', 'builder'),
      makeEvent('merge.enqueued', { taskId: 'B' }),
      makeEvent('board.stopped', { reason: 'user' }),
    );
    assert.deepEqual(plan(stoppedMidRun), []);
  });

  it('rule 1: holds a task until every dependency has merged', () => {
    const tasks = [task('A'), task('B'), task('C', { wave: 2, dependsOn: ['A', 'B'] })];
    const none = boardOf({ tasks, concurrency: 4 });
    assert.deepEqual(nonMerge(plan(none)).map((d) => d.taskId), ['A', 'B']);

    const one = boardOf({ tasks, concurrency: 4 }, ...merged('A', 's1'));
    assert.deepEqual(nonMerge(plan(one)).map((d) => d.taskId), ['B']);

    const both = boardOf({ tasks, concurrency: 4 }, ...merged('A', 's1'), ...merged('B', 's2'));
    assert.deepEqual(nonMerge(plan(both)).map((d) => d.taskId), ['C']);
  });

  it('rule 2: never two concurrent attempts on one task', () => {
    const state = boardOf({ tasks: [task('A')], concurrency: 4 }, started('A', 'a1', 'builder'));
    const desires = nonMerge(plan(state));
    assert.equal(desires.length, 1);
    assert.deepEqual(desires[0], { taskId: 'A', role: 'builder', seedKind: 'initial', sameWorktree: false });
  });

  it('rule 3: excludes overlapping touches even when dependsOn permits', () => {
    const overlapping = [
      task('A', { touches: ['src/shared/**'] }),
      task('B', { touches: ['src/shared/thing.ts'] }),
    ];
    const state = boardOf({ tasks: overlapping, concurrency: 4 });
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['A']);

    const disjoint = [
      task('A', { touches: ['src/a/**'] }),
      task('B', { touches: ['src/b/**'] }),
    ];
    const free = boardOf({ tasks: disjoint, concurrency: 2 });
    assert.deepEqual(nonMerge(plan(free)).map((d) => d.taskId), ['A', 'B']);
  });

  it('rule 3: expanded file overlap serialises even when declared globs look disjoint', () => {
    const tasks = [
      task('A', { touches: ['src/a/**'], touchesExpanded: ['src/shared/x.ts', 'src/a/one.ts'] }),
      task('B', { touches: ['src/b/**'], touchesExpanded: ['src/shared/x.ts', 'src/b/two.ts'] }),
    ];
    const state = boardOf({ tasks, concurrency: 2 });
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['A']);
  });

  it('rule 3: frozen expansion does not change when later files would overlap', () => {
    const tasks = [
      task('A', { touches: ['src/a/**'], touchesExpanded: ['src/a/one.ts'] }),
      task('B', { touches: ['src/b/**'], touchesExpanded: ['src/b/two.ts'] }),
    ];
    const state = boardOf({ tasks, concurrency: 2 });
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['A', 'B']);
    assert.equal(
      footprintsClash(
        { touches: ['src/a/**'], touchesExpanded: ['src/a/one.ts'] },
        { touches: ['src/b/**'], touchesExpanded: ['src/b/two.ts'] },
      ),
      false,
    );
  });

  it('rule 3: empty expansion overlaps nothing extra (declared globs still apply)', () => {
    const empty = [
      task('A', { touches: ['nope/a/**'], touchesExpanded: [] }),
      task('B', { touches: ['nope/b/**'], touchesExpanded: [] }),
    ];
    const free = boardOf({ tasks: empty, concurrency: 2 });
    assert.deepEqual(nonMerge(plan(free)).map((d) => d.taskId), ['A', 'B']);

    const stillDeclared = [
      task('A', { touches: ['src/shared/**'], touchesExpanded: [] }),
      task('B', { touches: ['src/shared/x.ts'], touchesExpanded: [] }),
    ];
    const serial = boardOf({ tasks: stillDeclared, concurrency: 2 });
    assert.deepEqual(nonMerge(plan(serial)).map((d) => d.taskId), ['A']);
  });

  it('rule 4: respects the concurrency cap', () => {
    const tasks = [task('A'), task('B'), task('C'), task('D')];
    for (const cap of [0, 1, 2, 3, 4, 8]) {
      const state = boardOf({ tasks, concurrency: Math.max(1, cap) });
      state.concurrency = cap;
      assert.ok(nonMerge(plan(state)).length <= cap, `cap ${cap} exceeded`);
      assert.equal(nonMerge(plan(state)).length, Math.min(cap, 4));
    }
  });

  it('rule 5: at most one merge is ever desired, whatever the cap', () => {
    const tasks = [task('A'), task('B'), task('C')];
    const state = boardOf(
      { tasks, concurrency: 4 },
      makeEvent('merge.enqueued', { taskId: 'A' }),
      makeEvent('merge.enqueued', { taskId: 'B' }),
      makeEvent('merge.enqueued', { taskId: 'C' }),
    );
    const merges = plan(state).filter((d) => d.role === 'merge');
    assert.equal(merges.length, 1);
    assert.equal(merges[0].taskId, 'A', 'the queue head, in enqueue order');
  });

  it('rule 5: the merge head is desired even when the cap is full', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 1 },
      makeEvent('merge.enqueued', { taskId: 'A' }),
      started('B', 'b1', 'builder'),
    );
    const desires = plan(state);
    assert.equal(desires.filter((d) => d.role === 'merge').length, 1);
    assert.equal(nonMerge(desires).length, 1);
  });
});

// ── Matrix ───────────────────────────────────────────────────────────────────

describe('plan — the matrix', () => {
  const CAPS = [1, 2, 4];
  const READY = [0, 1, 3, 10];
  const OVERLAP = ['none', 'partial', 'total'];
  const MERGE = [true, false];

  const touchesFor = (n, overlap) =>
    Array.from({ length: n }, (_, i) => {
      if (overlap === 'total') return ['src/shared/**'];
      if (overlap === 'partial') return i % 2 === 0 ? ['src/shared/**'] : [`src/t${i}/**`];
      return [`src/t${i}/**`];
    });

  for (const cap of CAPS) {
    for (const readyCount of READY) {
      for (const overlap of OVERLAP) {
        for (const mergeInFlight of MERGE) {
          const label = `cap=${cap} ready=${readyCount} overlap=${overlap} merge=${mergeInFlight}`;
          it(`holds every rule at ${label}`, () => {
            const globs = touchesFor(readyCount, overlap);
            const tasks = Array.from({ length: readyCount }, (_, i) =>
              task(`T${i}`, { touches: globs[i] }),
            );
            const tail = [];
            if (mergeInFlight) {
              tasks.push(task('M', { touches: ['src/m/**'] }));
              tail.push(...attempt('M', 'm-b', 'builder', 'pass'));
              tail.push(...attempt('M', 'm-t', 'tester', 'pass'));
              tail.push(makeEvent('merge.enqueued', { taskId: 'M' }));
            }
            const state = boardOf({ tasks, concurrency: cap }, ...tail);
            const desires = plan(state);

            assert.ok(nonMerge(desires).length <= cap, `${label}: cap exceeded`);
            assert.ok(
              desires.filter((d) => d.role === 'merge').length <= 1,
              `${label}: more than one merge`,
            );
            assert.equal(
              desires.filter((d) => d.role === 'merge').length,
              mergeInFlight ? 1 : 0,
              `${label}: merge desire mismatch`,
            );
            const ids = nonMerge(desires).map((d) => d.taskId);
            assert.equal(new Set(ids).size, ids.length, `${label}: duplicate task`);
            for (let i = 0; i < ids.length; i += 1) {
              for (let j = i + 1; j < ids.length; j += 1) {
                assert.equal(
                  touchesOverlap(state.tasks.get(ids[i]).touches, state.tasks.get(ids[j]).touches),
                  false,
                  `${label}: ${ids[i]} and ${ids[j]} overlap`,
                );
              }
            }
            assert.deepEqual(plan(state), desires, `${label}: not idempotent`);

            if (overlap === 'total' && readyCount > 0) {
              assert.equal(ids.length, 1, `${label}: total overlap must serialise`);
            } else if (overlap === 'none') {
              assert.equal(ids.length, Math.min(cap, readyCount), `${label}: under-scheduled`);
            }
          });
        }
      }
    }
  }
});

// ── Deadlock ─────────────────────────────────────────────────────────────────

describe('plan — the sequential deadlock regression', () => {
  it('yields the tester desire on the very next call at N = 1', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
    );
    assert.deepEqual(plan(state), [
      { taskId: 'A', role: 'tester', seedKind: 'initial', sameWorktree: false },
    ]);
  });

  it('never freezes across a full single-task lifecycle at N = 1', () => {
    const tail = [];
    const push = (...events) => tail.push(...events);
    const at = () => plan(boardOf({ tasks: [task('A')], concurrency: 1 }, ...tail));

    assert.deepEqual(at().map((d) => d.role), ['builder']);
    push(started('A', 'a1', 'builder'));
    assert.deepEqual(at().map((d) => d.role), ['builder'], 'builder in flight');
    push(ended('A', 'a1', 'builder', 'pass'));
    assert.deepEqual(at().map((d) => d.role), ['tester'], 'the frozen step');
    push(started('A', 't1', 'tester'));
    assert.deepEqual(at().map((d) => d.role), ['tester']);
    push(ended('A', 't1', 'tester', 'pass'));
    assert.deepEqual(at(), [], 'nothing to start — the engine must enqueue the merge');
    assert.deepEqual(pendingEnqueues(boardOf({ tasks: [task('A')], concurrency: 1 }, ...tail)), ['A']);
    push(makeEvent('merge.enqueued', { taskId: 'A' }));
    assert.deepEqual(at().map((d) => d.role), ['merge']);
    push(makeEvent('merge.succeeded', { taskId: 'A', sha: 's' }));
    assert.deepEqual(at().map((d) => d.role), ['final'], 'everything merged — verify the whole');
    push(makeEvent('final.test.ended', { outcome: 'pass' }));
    assert.deepEqual(at(), [], 'the run is done');
  });

  it('a failed final test does not re-desire builders, testers, or merges', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 4 },
      ...merged('A', 's1'),
      ...merged('B', 's2'),
      makeEvent('final.test.ended', {
        outcome: 'fail',
        runInstructions: 'command: npx tsc --noEmit\ncwd: /tmp/integration',
      }),
    );
    assert.deepEqual(plan(state), []);
    assert.equal(state.tasks.get('A').phase, 'merged');
    assert.equal(state.tasks.get('B').phase, 'merged');
    assert.equal(state.finalTest.outcome, 'fail');
  });

  it('recovers a slot the moment a blocked builder is retried, with the same worktree', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B', { touches: ['src/b/**'] })], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'blocked'),
    );
    assert.deepEqual(plan(state), [
      { taskId: 'A', role: 'builder', seedKind: 'repair', sameWorktree: true },
    ]);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe('plan — determinism and totality', () => {
  const tasks = [
    task('C', { wave: 2, dependsOn: [] }),
    task('A', { wave: 1 }),
    task('B', { wave: 1 }),
  ];

  it('orders output by wave, then declared order, then id', () => {
    const state = boardOf({ tasks, concurrency: 4 });
    assert.deepEqual(orderedTaskIds(state), ['A', 'B', 'C']);
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['A', 'B', 'C']);
  });

  it('returns deep-equal arrays on repeated calls', () => {
    const state = boardOf({ tasks, concurrency: 2 });
    const first = plan(state);
    for (let i = 0; i < 10; i += 1) assert.deepEqual(plan(state), first);
    assert.deepEqual(first.map((d) => d.taskId), plan(state).map((d) => d.taskId));
  });

  it('yields no desire for a task depending on an unknown id, rather than throwing', () => {
    const state = boardOf({
      tasks: [task('A'), task('B', { dependsOn: ['ghost'] })],
      concurrency: 4,
    });
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['A']);
  });

  it('is total over degenerate states', () => {
    assert.deepEqual(plan(derive([])), []);
    assert.deepEqual(plan(null), []);
    assert.deepEqual(plan(undefined), []);
    const noTasks = boardOf({ tasks: [], concurrency: 4 });
    assert.deepEqual(plan(noTasks), []);
  });

  it('survives a nonsense concurrency value', () => {
    const state = boardOf({ tasks: [task('A'), task('B')], concurrency: 2 });
    for (const bad of [Number.NaN, -3, 1.5, 'two', null, undefined]) {
      state.concurrency = bad;
      assert.doesNotThrow(() => plan(state), `concurrency ${String(bad)}`);
      assert.ok(nonMerge(plan(state)).length <= 2);
    }
  });

  it('desires no task work once every task is terminal', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B'), task('C')], concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
      makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      ...merged('C', 's'),
    );
    assert.deepEqual(plan(state), [
      { taskId: null, role: 'final', seedKind: 'initial', sameWorktree: false },
    ]);

    const verified = boardOf(
      { tasks: [task('A'), task('B'), task('C')], concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
      makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      ...merged('C', 's'),
      makeEvent('final.test.ended', { outcome: 'pass' }),
    );
    assert.deepEqual(plan(verified), []);
  });

  it('does not desire a final test when there is nothing to verify', () => {
    const allAbandoned = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
      makeEvent('task.abandoned', { taskId: 'B', reason: 'builder-failed' }),
    );
    assert.deepEqual(plan(allAbandoned), []);
  });

  it('does not desire a final test while any task is still live', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 4 },
      ...merged('A', 's'),
    );
    assert.equal(plan(state).some((d) => d.role === 'final'), false);
  });

  it('does not desire a final test while a merge is queued', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 4 },
      ...merged('A', 's'),
      makeEvent('task.abandoned', { taskId: 'B', reason: 'builder-failed' }),
      makeEvent('merge.enqueued', { taskId: 'A' }),
    );
    assert.equal(plan(state).some((d) => d.role === 'final'), false);
  });
});

// ── In-flight attempts ───────────────────────────────────────────────────────

describe('plan — in-flight attempts', () => {
  it('describes a resumed repair attempt the way the decision that made it did', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'blocked'),
      started('A', 'a2', 'builder', { seedKind: 'repair' }),
    );
    assert.deepEqual(plan(state), [
      { taskId: 'A', role: 'builder', seedKind: 'repair', sameWorktree: true },
    ]);
  });

  it('describes a resumed continue attempt as same-worktree too', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'crashed'),
      started('A', 'a2', 'builder', { seedKind: 'continue' }),
    );
    assert.deepEqual(plan(state), [
      { taskId: 'A', role: 'builder', seedKind: 'continue', sameWorktree: true },
    ]);
  });

  it('lets running work continue when the cap is lowered beneath it', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B'), task('C')], concurrency: 3 },
      started('A', 'a1', 'builder'),
      started('B', 'b1', 'builder'),
    );
    state.concurrency = 1;
    const desires = nonMerge(plan(state));
    assert.deepEqual(desires.map((d) => d.taskId), ['A', 'B'], 'running work was killed');
    assert.equal(desires.some((d) => d.taskId === 'C'), false);
  });

  it('holds the footprint of every running task against new starts', () => {
    const state = boardOf(
      {
        tasks: [
          task('A', { touches: ['src/shared/**'] }),
          task('B', { touches: ['src/b/**'] }),
          task('C', { touches: ['src/shared/x.ts'] }),
        ],
        concurrency: 4,
      },
      started('A', 'a1', 'builder'),
    );
    const desires = nonMerge(plan(state));
    assert.deepEqual(desires.map((d) => d.taskId), ['A', 'B']);
  });
});

describe('pendingSkips — dead ends never stall the run', () => {
  const chain = [
    task('A'),
    task('B', { wave: 2, dependsOn: ['A'] }),
    task('C', { wave: 3, dependsOn: ['B'] }),
    task('D'),
  ];

  it('closes out a branch behind an abandoned task, transitively', () => {
    const state = boardOf(
      { tasks: chain, concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
    );
    assert.deepEqual(pendingSkips(state), [
      { taskId: 'B', blockedBy: 'A' },
      { taskId: 'C', blockedBy: 'A' },
    ]);
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['D']);
  });

  it('stops proposing a skip once it is journaled', () => {
    const state = boardOf(
      { tasks: chain, concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
      makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      makeEvent('task.skipped', { taskId: 'C', blockedBy: 'A' }),
    );
    assert.deepEqual(pendingSkips(state), []);
  });

  it('never skips a task with work still in flight', () => {
    const state = boardOf(
      { tasks: chain, concurrency: 4 },
      started('B', 'b1', 'builder'),
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
    );
    assert.deepEqual(pendingSkips(state).map((s) => s.taskId), ['C']);
  });

  it('proposes nothing on a healthy board', () => {
    assert.deepEqual(pendingSkips(boardOf({ tasks: chain, concurrency: 4 })), []);
  });

  it('closes out a dependency cycle rather than stalling forever', () => {
    const cyclic = [
      task('A', { dependsOn: ['B'] }),
      task('B', { dependsOn: ['A'] }),
      task('E'),
    ];
    const state = boardOf({ tasks: cyclic, concurrency: 4 });
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['E']);
    assert.deepEqual(pendingSkips(state).map((s) => s.taskId), ['A', 'B']);
  });

  it('skips a diamond DAG behind the abandoned root, and nothing else', () => {
    const diamond = [
      task('A'),
      task('B', { wave: 2, dependsOn: ['A'] }),
      task('C', { wave: 2, dependsOn: ['A'] }),
      task('D', { wave: 3, dependsOn: ['B', 'C'] }),
      task('E', { wave: 2, touches: ['src/e/**'] }),
    ];
    const state = boardOf(
      { tasks: diamond, concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
    );
    assert.deepEqual(pendingSkips(state), [
      { taskId: 'B', blockedBy: 'A' },
      { taskId: 'C', blockedBy: 'A' },
      { taskId: 'D', blockedBy: 'A' },
    ]);
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['E']);
  });

  it('does not skip a task that only shares a wave', () => {
    const sameWave = [
      task('A', { wave: 1 }),
      task('B', { wave: 1, touches: ['src/b/**'] }),
    ];
    const state = boardOf(
      { tasks: sameWave, concurrency: 4 },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed' }),
    );
    assert.deepEqual(pendingSkips(state), []);
    assert.deepEqual(nonMerge(plan(state)).map((d) => d.taskId), ['B']);
  });
});

// ── Next action ──────────────────────────────────────────────────────────────

describe('nextAction — the single policy call site', () => {
  it('starts a builder on a task with no history', () => {
    const state = boardOf({ tasks: [task('A')], concurrency: 1 });
    assert.deepEqual(nextAction(state, 'A'), {
      kind: 'start', role: 'builder', seedKind: 'initial', sameWorktree: false,
    });
  });

  it('routes each outcome through the policy table', () => {
    const cases = [
      [['fail'], { kind: 'start', role: 'builder', seedKind: 'failure-aware', sameWorktree: false }],
      [['blocked'], { kind: 'start', role: 'builder', seedKind: 'repair', sameWorktree: true }],
      [['crashed'], { kind: 'start', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      [['timeout'], { kind: 'start', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      [['no_report'], { kind: 'start', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      [['pass'], { kind: 'start', role: 'tester', seedKind: 'initial', sameWorktree: false }],
    ];
    for (const [outcomes, expected] of cases) {
      const tail = outcomes.flatMap((o, i) => attempt('A', `a${i}`, 'builder', o));
      const state = boardOf({ tasks: [task('A')], concurrency: 1 }, ...tail);
      assert.deepEqual(nextAction(state, 'A'), expected, outcomes.join(','));
    }
  });

  it('gives fail two more tries and blocked one, then abandons', () => {
    const fails = (n) =>
      boardOf(
        { tasks: [task('A')], concurrency: 1 },
        ...Array.from({ length: n }, (_, i) => attempt('A', `a${i}`, 'builder', 'fail')).flat(),
      );
    assert.equal(nextAction(fails(1), 'A').kind, 'start');
    assert.equal(nextAction(fails(2), 'A').kind, 'start');
    assert.equal(nextAction(fails(3), 'A').kind, 'abandon');

    const blocks = (n) =>
      boardOf(
        { tasks: [task('A')], concurrency: 1 },
        ...Array.from({ length: n }, (_, i) => attempt('A', `a${i}`, 'builder', 'blocked')).flat(),
      );
    assert.equal(nextAction(blocks(1), 'A').kind, 'start');
    assert.equal(nextAction(blocks(2), 'A').kind, 'abandon');
  });

  it('abandons once the bound is reached, carrying evidence', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'fail'),
      ...attempt('A', 'a2', 'builder', 'fail'),
      ...attempt('A', 'a3', 'builder', 'fail'),
    );
    const next = nextAction(state, 'A');
    assert.equal(next.kind, 'abandon');
    assert.equal(next.reason, 'builder-failed');
    assert.equal(next.evidence.role, 'builder');
    assert.equal(next.evidence.outcome, 'fail');
    assert.equal(next.evidence.attemptCount, 2);
    assert.equal(next.evidence.attempts.length, 3, 'attempt history must not be truncated');
    assert.ok(abandonmentEvidenceIsComplete(next.evidence));
    assert.deepEqual(pendingAbandonments(state), [
      { taskId: 'A', reason: 'builder-failed', evidence: next.evidence },
    ]);
    assert.deepEqual(plan(state), []);
  });

  it('enqueues a merge after the tester passes, rather than starting one', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'pass'),
    );
    assert.deepEqual(nextAction(state, 'A'), { kind: 'enqueue' });
    assert.deepEqual(pendingEnqueues(state), ['A']);
    assert.deepEqual(plan(state), []);
  });

  it('re-opens the owning task with a rebase seed on a merge conflict', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'pass'),
      makeEvent('merge.enqueued', { taskId: 'A' }),
      makeEvent('merge.conflicted', { taskId: 'A', files: ['src/a.ts'] }),
    );
    assert.deepEqual(nextAction(state, 'A'), {
      kind: 'start', role: 'builder', seedKind: 'rebase', sameWorktree: true,
    });
    assert.deepEqual(plan(state).map((d) => d.seedKind), ['rebase']);
  });

  it('sends a builder that resolved a merge conflict straight back to the queue, no tester', () => {
    const conflict = [
      makeEvent('merge.enqueued', { taskId: 'A' }),
      makeEvent('merge.conflicted', { taskId: 'A', files: ['src/a.ts'] }),
    ];
    const resolved = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'pass'),
      ...conflict,
      ...attempt('A', 'a2', 'builder', 'pass'),
    );
    assert.deepEqual(nextAction(resolved, 'A'), { kind: 'enqueue' });
    assert.deepEqual(pendingEnqueues(resolved), ['A']);

    // A conflict fix that crashed and continued is still the same conflict fix.
    const continued = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'pass'),
      ...conflict,
      ...attempt('A', 'a2', 'builder', 'crashed'),
      ...attempt('A', 'a3', 'builder', 'pass'),
    );
    assert.deepEqual(nextAction(continued, 'A'), { kind: 'enqueue' });
  });

  it('still tests a builder the tester sent back', () => {
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'fail'),
      ...attempt('A', 'a2', 'builder', 'pass'),
    );
    assert.deepEqual(nextAction(state, 'A'), {
      kind: 'start', role: 'tester', seedKind: 'initial', sameWorktree: false,
    });
  });

  it('abandons after a third merge conflict', () => {
    const conflictOnce = [
      makeEvent('merge.enqueued', { taskId: 'A' }),
      makeEvent('merge.conflicted', { taskId: 'A', files: ['src/a.ts'] }),
    ];
    const state = boardOf(
      { tasks: [task('A')], concurrency: 1 },
      ...attempt('A', 'a1', 'builder', 'pass'),
      ...attempt('A', 't1', 'tester', 'pass'),
      ...conflictOnce,
      ...conflictOnce,
      ...conflictOnce,
    );
    assert.equal(nextAction(state, 'A').kind, 'abandon');
    assert.equal(nextAction(state, 'A').reason, 'merge-conflicted');
  });

  it('says nothing about a task that has work in flight', () => {
    const state = boardOf({ tasks: [task('A')], concurrency: 1 }, started('A', 'a1', 'builder'));
    assert.deepEqual(nextAction(state, 'A'), { kind: 'none' });
    assert.deepEqual(nextAction(state, 'ghost'), { kind: 'none' });
  });
});

// ── Touches overlap ──────────────────────────────────────────────────────────

describe('touchesOverlap — pure glob-set intersection', () => {
  const overlaps = [
    ['src/a.ts', 'src/a.ts'],
    ['src/**', 'src/a/b.ts'],
    ['src/**', 'src/**'],
    ['src/**/*.ts', 'src/a/**'],
    ['src/**/*.ts', 'src/a/b.ts'],
    ['src/ui/*.ts', 'src/ui/panel.ts'],
    ['src/ui/', 'src/ui/panel.ts'],
    ['./src/a/**', 'src/a/b.ts'],
    ['src/a?.ts', 'src/ab.ts'],
    ['**', 'anything/at/all.ts'],
    ['server/**/*.js', 'server/orchestrator/core/plan.js'],
    ['src/*/index.ts', 'src/ui/index.ts'],
  ];
  const disjoint = [
    ['src/a/**', 'src/b/**'],
    ['src/a.ts', 'src/b.ts'],
    ['src/**/*.ts', 'src/**/*.css'],
    ['src/ui/*.ts', 'src/ui/nested/panel.ts'],
    ['src/a?.ts', 'src/abc.ts'],
    ['server/**', 'src/**'],
    ['src/*/index.ts', 'src/ui/deep/index.ts'],
  ];

  for (const [a, b] of overlaps) {
    it(`${a} overlaps ${b}`, () => {
      assert.equal(globsIntersect(a, b), true);
      assert.equal(globsIntersect(b, a), true, 'must be symmetric');
      assert.equal(touchesOverlap([a], [b]), true);
    });
  }

  for (const [a, b] of disjoint) {
    it(`${a} does not overlap ${b}`, () => {
      assert.equal(globsIntersect(a, b), false);
      assert.equal(globsIntersect(b, a), false, 'must be symmetric');
      assert.equal(touchesOverlap([a], [b]), false);
    });
  }

  it('understands character classes, which parsePlan admits', () => {
    assert.equal(globsIntersect('src/[ab]x.ts', 'src/ax.ts'), true);
    assert.equal(globsIntersect('src/[ab]x.ts', 'src/bx.ts'), true);
    assert.equal(globsIntersect('src/[ab]x.ts', 'src/cx.ts'), false);
    assert.equal(globsIntersect('src/[a-z]x.ts', 'src/qx.ts'), true);
    assert.equal(globsIntersect('src/[a-c]x.ts', 'src/zx.ts'), false);
    assert.equal(globsIntersect('src/[ab]x.ts', 'src/[bc]x.ts'), true);
    assert.equal(globsIntersect('src/[ab]x.ts', 'src/[cd]x.ts'), false);
    assert.equal(globsIntersect('src/[!ab]x.ts', 'src/cx.ts'), true);
    assert.equal(globsIntersect('src/[!ab]x.ts', 'src/ax.ts'), false);
    assert.equal(globsIntersect('src/[ab]*.ts', 'src/along.ts'), true);
  });

  it('is symmetric and self-intersecting across a generated sweep', () => {
    const parts = ['a', 'b', '*', '**', '?', 'x?', '[ab]', '[a-c]', '*.ts', 'a*'];
    let checked = 0;
    for (const p1 of parts) {
      for (const p2 of parts) {
        const a = `src/${p1}/${p2}`;
        assert.equal(globsIntersect(a, a), true, `${a} does not intersect itself`);
        for (const p3 of parts) {
          const b = `src/${p3}`;
          assert.equal(globsIntersect(a, b), globsIntersect(b, a), `${a} vs ${b} is asymmetric`);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 1000, `only ${checked} pairs checked`);
  });

  it('overlaps when any pair in the sets overlaps', () => {
    assert.equal(touchesOverlap(['src/a/**', 'src/z/**'], ['src/q/**', 'src/z/x.ts']), true);
    assert.equal(touchesOverlap(['src/a/**'], ['src/q/**', 'src/z/x.ts']), false);
  });

  it('treats an empty footprint as overlapping nothing', () => {
    assert.equal(touchesOverlap([], ['src/**']), false);
    assert.equal(touchesOverlap(['src/**'], []), false);
    assert.equal(touchesOverlap([], []), false);
  });

  it('needs no filesystem and terminates on pathological globs', () => {
    const nasty = '**/*/**/*/**/*/**/*/**/*.ts';
    assert.doesNotThrow(() => globsIntersect(nasty, nasty));
    assert.equal(globsIntersect(nasty, 'a/b/c/d/e/f.ts'), true);
  });
});

// ── Manual mode ──────────────────────────────────────────────────────────────

describe('plan — rule 6 and Manual mode', () => {
  it('desires nothing on a stopped board with nothing hand-started', () => {
    const state = boardOf({ tasks: [task('A'), task('B')], running: false });
    assert.deepEqual(plan(state), []);
  });

  it('keeps an attempt started while stopped, and nothing else', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], running: false },
      started('A', 'a1', 'builder'),
    );
    assert.deepEqual(plan(state), [
      { taskId: 'A', role: 'builder', seedKind: 'initial', sameWorktree: false },
    ]);
  });

  it('drops it once the board is stopped again — Stop means stop', () => {
    const state = boardOf(
      { tasks: [task('A')], running: false },
      started('A', 'a1', 'builder'),
      makeEvent('board.stopped', { reason: 'user' }),
    );
    assert.equal(state.tasks.get('A').attempts[0].manual, false);
    assert.deepEqual(plan(state), []);
  });

  it('does not mark an attempt started on a running board as manual', () => {
    const state = boardOf({ tasks: [task('A')] }, started('A', 'a1', 'builder'));
    assert.equal(state.tasks.get('A').attempts[0].manual, false);
  });

  it('never advances a stopped board past the attempt it was given', () => {
    const state = boardOf(
      { tasks: [task('A')], running: false },
      ...attempt('A', 'a1', 'builder', 'pass'),
    );
    assert.deepEqual(plan(state), []);
  });
});

// ── Manual start ─────────────────────────────────────────────────────────────

describe('manualStart — outside the cap, and nothing else', () => {
  it('starts a ready task on a stopped board', () => {
    const state = boardOf({ tasks: [task('A')], running: false });
    assert.deepEqual(manualStart(state, 'A', []), {
      kind: 'start',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    });
  });

  it('refuses a task whose dependencies have not merged — rule 1', () => {
    const state = boardOf({
      tasks: [task('A'), task('B', { dependsOn: ['A'] })],
      running: false,
    });
    assert.deepEqual(manualStart(state, 'B', []), { kind: 'none' });
  });

  it('starts it once the dependency has merged', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B', { dependsOn: ['A'] })], running: false },
      ...merged('A', 'sha-a'),
    );
    assert.equal(manualStart(state, 'B', []).kind, 'start');
  });

  it('refuses a second attempt on a task already running — rule 2', () => {
    const state = boardOf({ tasks: [task('A')], running: false }, started('A', 'a1', 'builder'));
    assert.deepEqual(
      manualStart(state, 'A', [{ taskId: 'A', role: 'builder' }]),
      { kind: 'none' },
    );
  });

  it('refuses a task whose footprint overlaps running work — rule 3', () => {
    const state = boardOf({
      tasks: [task('A', { touches: ['src/shared/**'] }), task('B', { touches: ['src/shared/x.ts'] })],
      running: false,
    });
    assert.deepEqual(
      manualStart(state, 'B', [{ taskId: 'A', role: 'builder' }]),
      { kind: 'none' },
    );
    const disjoint = boardOf({ tasks: [task('A'), task('B')], running: false });
    assert.equal(manualStart(disjoint, 'B', [{ taskId: 'A', role: 'builder' }]).kind, 'start');
  });

  it('ignores the cap — rule 4 is the one it is allowed to override', () => {
    const state = boardOf(
      { tasks: [task('A'), task('B')], concurrency: 1 },
      started('A', 'a1', 'builder'),
    );
    assert.equal(nonMerge(plan(state)).length, 1, 'the scheduler is already at its cap');
    assert.equal(manualStart(state, 'B', [{ taskId: 'A', role: 'builder' }]).kind, 'start');
  });

  it('refuses a task that is finished, unknown, or has nothing to do', () => {
    const state = boardOf({ tasks: [task('A')], running: false }, ...merged('A', 'sha-a'));
    assert.deepEqual(manualStart(state, 'A', []), { kind: 'none' });
    assert.deepEqual(manualStart(state, 'nope', []), { kind: 'none' });
  });
});

// ── Reopen ───────────────────────────────────────────────────────────────────

describe('plan — reopen', () => {
  it('reopenTargets closes over skipped dependents', () => {
    const state = boardOf(
      {
        tasks: [
          task('A'),
          task('B', { dependsOn: ['A'] }),
          task('C', { dependsOn: ['B'] }),
          task('D'),
        ],
      },
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
      makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      makeEvent('task.skipped', { taskId: 'C', blockedBy: 'A' }),
    );
    assert.deepEqual(reopenTargets(state, ['A']), ['A', 'B', 'C']);
    assert.deepEqual(reopenTargets(state), ['A', 'B', 'C']);
  });

  it('a reopened task\'s first nextAction is integration-fix', () => {
    const state = boardOf(
      { tasks: [task('A')] },
      started('A', 'a1', 'builder'),
      ended('A', 'a1', 'builder', 'fail'),
      started('A', 'a2', 'builder'),
      ended('A', 'a2', 'builder', 'fail'),
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
      makeEvent('board.reopened', { taskIds: ['A'], reason: 'user' }),
    );
    assert.deepEqual(nextAction(state, 'A'), {
      kind: 'start',
      role: 'builder',
      seedKind: 'integration-fix',
      sameWorktree: false,
    });
  });

  it('isReadyForFinalTest is true again after a reopen on an all-merged board', () => {
    const state = boardOf(
      { tasks: [task('A')] },
      ...merged('A', 'sha-a'),
      makeEvent('final.test.ended', {
        outcome: 'fail',
        runInstructions: 'command: tsc\ncwd: /tmp',
      }),
      makeEvent('run.finished', { summary: 'fail' }),
      makeEvent('board.reopened', { taskIds: [], reason: 'user' }),
    );
    assert.equal(state.finalTest, null);
    assert.equal(isReadyForFinalTest(state), true);
  });

  it('buildIntegrationFixTask is derived from the failing rung', () => {
    const state = boardOf(
      { tasks: [task('A')] },
      ...merged('A', 'sha-a'),
      makeEvent('final.test.ended', {
        outcome: 'fail',
        runInstructions: 'command: npx tsc --noEmit\ncwd: /tmp/int',
        evidence: { failedRung: 'typecheck', output: 'TS2322' },
      }),
    );
    const fix = buildIntegrationFixTask(state);
    assert.equal(fix.task.id, 'FIX-1');
    assert.equal(fix.wave.n, 1);
    assert.equal(fix.task.dependsOn.length, 0);
    assert.deepEqual(fix.task.touches, ['**/*']);
    assert.match(fix.task.build, /typecheck/);
    assert.match(fix.task.build, /npx tsc --noEmit/);
    // The integration checkout is outside the fix worktree's workspace; its
    // absolute cwd sent agents hunting for a directory they cannot reach.
    assert.doesNotMatch(fix.task.build, /\/tmp\/int/);
    assert.match(fix.task.build, /minnow\/board\/b\/integration/);
    assert.match(fix.task.build, /root of your own task worktree/);
  });

  it('reopened tasks are desired in DAG order', () => {
    const state = boardOf(
      {
        tasks: [task('A'), task('B', { dependsOn: ['A'] })],
        concurrency: 2,
      },
      started('A', 'a1', 'builder'),
      ended('A', 'a1', 'builder', 'fail'),
      started('A', 'a2', 'builder'),
      ended('A', 'a2', 'builder', 'fail'),
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
      makeEvent('task.skipped', { taskId: 'B', blockedBy: 'A' }),
      makeEvent('board.reopened', { taskIds: ['A', 'B'], reason: 'user' }),
    );
    const desired = plan(state);
    assert.deepEqual(
      desired.map((d) => d.taskId),
      ['A'],
    );
    assert.equal(desired[0].seedKind, 'integration-fix');
  });
});
