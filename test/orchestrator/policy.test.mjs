import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ATTEMPT_OUTCOMES, ROLES, makeEvent } from '../../server/orchestrator/core/events.js';
import { attemptCount, derive } from '../../server/orchestrator/core/derive.js';
import {
  decide,
  formatPolicyTable,
  POLICY_TABLE,
  SAME_WORKTREE_SEED_KINDS,
  wantsSameWorktree,
} from '../../server/orchestrator/core/policy.js';

const OUTCOMES = [...ATTEMPT_OUTCOMES, 'conflicted'];
const ATTEMPTS = [0, 1, 2, 3, 4, 5];

function* space() {
  for (const role of ROLES) {
    for (const outcome of OUTCOMES) {
      for (const attemptCount of ATTEMPTS) yield { role, outcome, attemptCount };
    }
  }
}

// ── Totality ─────────────────────────────────────────────────────────────────

describe('decide — totality', () => {
  it('returns a defined action for every cell of role × outcome × attempts', () => {
    let cells = 0;
    for (const input of space()) {
      const action = decide(input);
      cells += 1;
      assert.ok(action, `no action for ${input.role}/${input.outcome}/${input.attemptCount}`);
      assert.ok(
        ['retry', 'advance', 'abandon'].includes(action.kind),
        `unknown action kind ${action.kind}`,
      );
    }
    assert.equal(cells, ROLES.length * OUTCOMES.length * ATTEMPTS.length);
    assert.equal(cells, 168);
  });

  it('is total over inputs the table was never written for', () => {
    for (const input of [
      { role: 'wizard', outcome: 'pass', attemptCount: 0 },
      { role: 'builder', outcome: 'exploded', attemptCount: 0 },
      { role: 'builder', outcome: 'fail', attemptCount: Number.NaN },
      { role: 'builder', outcome: 'fail', attemptCount: -1 },
      { role: 'builder', outcome: 'fail', attemptCount: 1e9 },
    ]) {
      const action = decide(input);
      assert.ok(['retry', 'advance', 'abandon'].includes(action.kind), JSON.stringify(input));
    }
    assert.equal(decide({ role: 'wizard', outcome: 'pass', attemptCount: 0 }).reason, 'unhandled-outcome');
  });

  it('never mutates the table it read from', () => {
    const before = JSON.stringify(POLICY_TABLE);
    for (const input of space()) decide(input);
    assert.equal(JSON.stringify(POLICY_TABLE), before);
  });

  it('returns a fresh action object each call', () => {
    const a = decide({ role: 'builder', outcome: 'fail', attemptCount: 0 });
    const b = decide({ role: 'builder', outcome: 'fail', attemptCount: 0 });
    assert.deepEqual(a, b);
    assert.notEqual(a, b, 'callers must not be able to mutate the table through the result');
  });
});

// ── Documented rows ──────────────────────────────────────────────────────────

describe('decide — the documented rows, cell for cell', () => {
  it('matches the table in the issue', () => {
    const rows = [
      ['builder', 'pass', 0, { kind: 'advance', to: 'tester' }],
      ['builder', 'pass', 5, { kind: 'advance', to: 'tester' }],
      ['builder', 'fail', 0, { kind: 'retry', role: 'builder', seedKind: 'failure-aware', sameWorktree: false }],
      ['builder', 'fail', 1, { kind: 'retry', role: 'builder', seedKind: 'failure-aware', sameWorktree: false }],
      ['builder', 'fail', 2, 'abandon'],
      ['builder', 'fail', 3, 'abandon'],
      ['builder', 'blocked', 0, { kind: 'retry', role: 'builder', seedKind: 'repair', sameWorktree: true }],
      ['builder', 'blocked', 1, 'abandon'],
      ['builder', 'no_report', 0, { kind: 'retry', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      ['builder', 'no_report', 1, 'abandon'],
      ['builder', 'crashed', 0, { kind: 'retry', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      ['builder', 'crashed', 1, { kind: 'retry', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      ['builder', 'crashed', 2, 'abandon'],
      ['builder', 'timeout', 0, { kind: 'retry', role: 'builder', seedKind: 'continue', sameWorktree: true }],
      ['builder', 'timeout', 2, 'abandon'],
      ['tester', 'pass', 0, { kind: 'advance', to: 'merge' }],
      ['tester', 'fail', 0, { kind: 'retry', role: 'builder', seedKind: 'fix', sameWorktree: true }],
      ['tester', 'fail', 1, { kind: 'retry', role: 'builder', seedKind: 'fix', sameWorktree: true }],
      ['tester', 'fail', 2, 'abandon'],
      ['merge', 'conflicted', 0, { kind: 'retry', role: 'builder', seedKind: 'rebase', sameWorktree: true }],
      ['merge', 'conflicted', 1, { kind: 'retry', role: 'builder', seedKind: 'rebase', sameWorktree: true }],
      ['merge', 'conflicted', 2, 'abandon'],
    ];
    for (const [role, outcome, attemptCount, expected] of rows) {
      const action = decide({ role, outcome, attemptCount });
      const label = `${role}/${outcome}/${attemptCount}`;
      if (expected === 'abandon') {
        assert.equal(action.kind, 'abandon', label);
      } else {
        assert.deepEqual(action, expected, label);
      }
    }
  });

  it('renders cell for cell as the whole table, with nothing hidden', () => {
    assert.equal(
      formatPolicyTable(),
      [
        '| role | outcome | attempts | action |',
        '| --- | --- | --- | --- |',
        '| builder | pass | — | advance → tester |',
        '| builder | fail | < 2 | retry builder, failure-aware seed |',
        '| builder | fail | — | abandon (builder-failed) |',
        '| builder | blocked | < 1 | retry builder, repair seed (same worktree) |',
        '| builder | blocked | — | abandon (builder-blocked) |',
        '| builder | no_report | < 1 | retry builder, continue seed (same worktree) |',
        '| builder | no_report | — | abandon (builder-no-report) |',
        '| builder | crashed | < 2 | retry builder, continue seed (same worktree) |',
        '| builder | crashed | — | abandon (builder-crashed) |',
        '| builder | timeout | < 2 | retry builder, continue seed (same worktree) |',
        '| builder | timeout | — | abandon (builder-timeout) |',
        '| tester | pass | — | advance → merge |',
        '| tester | fail | < 2 | retry builder, fix seed (same worktree) |',
        '| tester | fail | — | abandon (tester-failed) |',
        '| tester | blocked | < 1 | retry builder, repair seed (same worktree) |',
        '| tester | blocked | — | abandon (tester-blocked) |',
        '| tester | no_report | < 1 | retry builder, continue seed (same worktree) |',
        '| tester | no_report | — | abandon (tester-no-report) |',
        '| tester | crashed | < 2 | retry builder, continue seed (same worktree) |',
        '| tester | crashed | — | abandon (tester-crashed) |',
        '| tester | timeout | < 2 | retry builder, continue seed (same worktree) |',
        '| tester | timeout | — | abandon (tester-timeout) |',
        '| merge | pass | — | advance → done |',
        '| merge | conflicted | < 2 | retry builder, rebase seed (same worktree) |',
        '| merge | conflicted | — | abandon (merge-conflicted) |',
        '| merge | * | < 2 | retry builder, rebase seed (same worktree) |',
        '| merge | * | — | abandon (merge-failed) |',
        '| final | pass | — | advance → done |',
        '| final | * | — | abandon (final-test-failed) |',
        '| * | * | — | abandon (unhandled-outcome) |',
      ].join('\n'),
    );
    assert.equal(formatPolicyTable().split('\n').length, POLICY_TABLE.length + 2);
  });
});

// ── Invariants ───────────────────────────────────────────────────────────────

describe('decide — structural invariants', () => {
  it('every retry targets the builder', () => {
    for (const input of space()) {
      const action = decide(input);
      if (action.kind === 'retry') {
        assert.equal(action.role, 'builder', `${input.role}/${input.outcome} retried ${action.role}`);
      }
    }
    for (const row of POLICY_TABLE) {
      if (row.action.kind === 'retry') assert.equal(row.action.role, 'builder');
    }
  });

  it('advance moves forward only, one step at a time', () => {
    const forward = { builder: 'tester', tester: 'merge', merge: 'done', final: 'done' };
    for (const input of space()) {
      const action = decide(input);
      if (action.kind === 'advance') assert.equal(action.to, forward[input.role]);
    }
  });

  it('only pass ever advances', () => {
    for (const input of space()) {
      if (input.outcome === 'pass') continue;
      assert.notEqual(decide(input).kind, 'advance', `${input.role}/${input.outcome} advanced`);
    }
  });

  it('every abandon carries a non-empty reason and its evidence', () => {
    for (const input of space()) {
      const action = decide(input);
      if (action.kind !== 'abandon') continue;
      assert.ok(action.reason.length > 0, `${input.role}/${input.outcome}: empty reason`);
      assert.match(action.reason, /^[a-z][a-z0-9-]*$/, 'reason must be machine-readable');
      assert.deepEqual(action.evidence, {
        role: input.role,
        outcome: input.outcome,
        attemptCount: input.attemptCount,
      });
    }
  });

  it('carries the summary and detail through into the evidence', () => {
    const action = decide({
      role: 'builder',
      outcome: 'fail',
      attemptCount: 2,
      summary: 'could not make the type check pass',
      evidence: { lastTestOutput: 'TS2339' },
    });
    assert.equal(action.kind, 'abandon');
    assert.deepEqual(action.evidence, {
      role: 'builder',
      outcome: 'fail',
      attemptCount: 2,
      summary: 'could not make the type check pass',
      detail: { lastTestOutput: 'TS2339' },
    });
  });

  it('is monotone in attempt count: retries never come back after an abandon', () => {
    for (const role of ROLES) {
      for (const outcome of OUTCOMES) {
        let abandoned = false;
        for (const attemptCount of [0, 1, 2, 3, 4, 5, 20, 1000]) {
          const kind = decide({ role, outcome, attemptCount }).kind;
          if (abandoned) {
            assert.notEqual(kind, 'retry', `${role}/${outcome} retried again at ${attemptCount}`);
          }
          if (kind === 'abandon') abandoned = true;
        }
      }
    }
  });

  it('terminates: repeated application reaches advance or abandon', () => {
    for (const role of ROLES) {
      for (const outcome of OUTCOMES) {
        let attemptCount = 0;
        let steps = 0;
        let terminal = null;
        while (steps < 100) {
          const action = decide({ role, outcome, attemptCount });
          steps += 1;
          if (action.kind !== 'retry') {
            terminal = action.kind;
            break;
          }
          attemptCount += 1;
        }
        assert.ok(terminal, `${role}/${outcome} never terminated`);
        assert.ok(steps <= 3, `${role}/${outcome} took ${steps} attempts to terminate`);
      }
    }
  });

  it('terminates under a mixed sequence of outcomes, not just a repeated one', () => {
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 500; trial += 1) {
      for (const role of ROLES) {
        let attemptCount = 0;
        let steps = 0;
        let terminal = null;
        while (steps < 50) {
          const outcome = OUTCOMES[Math.floor(next() * OUTCOMES.length)];
          const action = decide({ role, outcome, attemptCount });
          steps += 1;
          if (action.kind !== 'retry') {
            terminal = action.kind;
            break;
          }
          attemptCount += 1;
        }
        assert.ok(terminal, `${role}: no terminal action in 50 attempts`);
        assert.ok(steps <= 3, `${role}: took ${steps} attempts under a mixed sequence`);
      }
    }
  });

  it('bounds every role at three attempts, whatever happens', () => {
    for (const role of ROLES) {
      for (const outcome of OUTCOMES) {
        assert.notEqual(decide({ role, outcome, attemptCount: 2 }).kind, 'retry',
          `${role}/${outcome} still retries after two prior attempts`);
      }
    }
  });

  it('the table is data, not control flow', () => {
    assert.ok(Array.isArray(POLICY_TABLE));
    assert.ok(POLICY_TABLE.length >= 12);
    for (const row of POLICY_TABLE) {
      assert.equal(typeof row.role, 'string');
      assert.equal(typeof row.outcome, 'string');
      assert.ok(row.under === null || Number.isInteger(row.under));
      assert.ok(['retry', 'advance', 'abandon'].includes(row.action.kind));
    }
  });

  it('has no unreachable row', () => {
    const reached = new Set();
    for (const input of space()) {
      const index = POLICY_TABLE.findIndex(
        (r) =>
          (r.role === '*' || r.role === input.role) &&
          (r.outcome === '*' || r.outcome === input.outcome) &&
          (r.under === null || input.attemptCount < r.under),
      );
      reached.add(index);
    }
    const unreachable = POLICY_TABLE.map((_, i) => i)
      .filter((i) => !reached.has(i) && i !== POLICY_TABLE.length - 1);
    assert.deepEqual(unreachable, []);
  });
});

// ── Absences ─────────────────────────────────────────────────────────────────

describe('decide — what is deliberately absent', () => {
  it('is a pure function of its arguments', () => {
    for (const input of space()) {
      const first = decide(input);
      assert.equal(typeof first.then, 'undefined', 'decide() must be synchronous');
      for (let i = 0; i < 5; i += 1) assert.deepEqual(decide(input), first);
    }

    const base = { role: 'builder', outcome: 'fail', attemptCount: 1 };
    assert.deepEqual(
      decide({ ...base, taskId: 'W1-A', wave: 3, elapsedMs: 99999, boardHealth: 'bad' }),
      decide(base),
    );
  });

  it('has no env-fixer and no merge-fixer role', () => {
    for (const row of POLICY_TABLE) {
      assert.doesNotMatch(row.role, /fixer/);
      if (row.action.kind === 'retry') assert.doesNotMatch(row.action.role, /fixer/);
    }
    const repair = decide({ role: 'builder', outcome: 'blocked', attemptCount: 0 });
    assert.equal(repair.seedKind, 'repair');
    assert.equal(repair.sameWorktree, true);
  });
});

// ── Same worktree ────────────────────────────────────────────────────────────

describe('wantsSameWorktree — MIN-705 / MIN-707 mapping', () => {
  it('reuses for repair, continue, rebase, and fix; fresh for failure-aware', () => {
    assert.deepEqual([...SAME_WORKTREE_SEED_KINDS], ['repair', 'continue', 'rebase', 'fix']);
    assert.equal(wantsSameWorktree('repair'), true);
    assert.equal(wantsSameWorktree('continue'), true);
    assert.equal(wantsSameWorktree('rebase'), true);
    assert.equal(wantsSameWorktree('failure-aware'), false);
    assert.equal(wantsSameWorktree('fix'), true);
    assert.equal(wantsSameWorktree('initial'), false);
    assert.equal(wantsSameWorktree('integration-fix'), false);
  });

  it('matches every retry row so the table cannot drift from the seed mapping', () => {
    for (const row of POLICY_TABLE) {
      if (row.action.kind !== 'retry') continue;
      assert.equal(
        row.action.sameWorktree,
        wantsSameWorktree(row.action.seedKind),
        `${row.role}/${row.outcome} seed ${row.action.seedKind}`,
      );
    }
  });
});

// ── Retired attempts ─────────────────────────────────────────────────────────

describe('retired attempts restore the budget', () => {
  it('does not count retired attempts, so a twice-failed builder gets a full budget after reopen', () => {
    const events = [
      makeEvent('board.created', {
        boardId: 'b',
        planPath: 'p.md',
        tasks: [{ id: 'A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] }],
        waves: [],
      }),
      makeEvent('task.attempt.started', { taskId: 'A', attemptId: 'a1', role: 'builder' }),
      makeEvent('task.attempt.ended', {
        taskId: 'A',
        attemptId: 'a1',
        role: 'builder',
        outcome: 'fail',
      }),
      makeEvent('task.attempt.started', { taskId: 'A', attemptId: 'a2', role: 'builder' }),
      makeEvent('task.attempt.ended', {
        taskId: 'A',
        attemptId: 'a2',
        role: 'builder',
        outcome: 'fail',
      }),
      makeEvent('task.abandoned', { taskId: 'A', reason: 'builder-failed-twice' }),
      makeEvent('board.reopened', { taskIds: ['A'], reason: 'user' }),
    ].map((event, i) => ({ ...event, seq: i + 1, ts: i + 1 }));
    const state = derive(events);
    assert.equal(attemptCount(state, 'A', 'builder'), 0);
    assert.equal(decide({ role: 'builder', outcome: 'fail', attemptCount: 0 }).kind, 'retry');
    assert.equal(decide({ role: 'builder', outcome: 'fail', attemptCount: 2 }).kind, 'abandon');
  });
});
