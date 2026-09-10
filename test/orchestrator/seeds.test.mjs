/**
 * P2-E — seven seed builders (MIN-702).
 *
 * Pure functions of derived task state. Golden-filed so prompt drift is
 * visible in review. No model call. No I/O inside `seeds.js`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { buildSeed, SEED_KINDS } from '../../server/orchestrator/seeds.js';
import { boardEventsForAttemptEnd } from '../../server/orchestrator/board-graph.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_DIR = path.join(PROJECT_ROOT, 'test', 'orchestrator', 'seeds.golden');
const SEEDS_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'seeds.js');

const TASK = {
  id: 'T1-A',
  title: 'Add health endpoint',
  wave: 1,
  dependsOn: [],
  touches: ['src/api/health.ts'],
  build: 'Add GET /health that returns { ok: true }.',
  test: 'GET /health returns 200 and { ok: true }.',
  accept: 'curl the health endpoint returns ok.',
};

const PRIOR = {
  id: 'T0-A',
  title: 'Scaffold routes',
  wave: 1,
  dependsOn: [],
  touches: ['src/api/routes.ts'],
  build: 'Scaffold the router.',
  test: 'Router loads.',
  accept: 'Routes module exists.',
};

function journal(...events) {
  return events.map((e, i) => ({ ...e, seq: i + 1, ts: 1_700_000_000_000 + i }));
}

function created() {
  return makeEvent('board.created', {
    boardId: 'b1',
    planPath: 'plan.md',
    name: 'demo',
    tasks: [PRIOR, TASK],
    waves: [{ n: 1, name: 'One' }],
  });
}

function started(taskId, attemptId, role) {
  return makeEvent('task.attempt.started', { taskId, attemptId, role });
}

function ended(taskId, attemptId, role, outcome, extra = {}) {
  return makeEvent('task.attempt.ended', { taskId, attemptId, role, outcome, ...extra });
}

/** One derived state per seed kind, sharing the same T1-A spec. */
function stateFor(kind) {
  const base = [created(), makeEvent('board.started', { concurrency: 1 })];
  if (kind === 'initial') return derive(journal(...base));
  if (kind === 'failure-aware') {
    return derive(
      journal(
        ...base,
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'fail', {
          summary: 'Typecheck failed.',
          evidence: { blockers: ['src/api/health.ts: missing return type'] },
        }),
      ),
    );
  }
  if (kind === 'repair') {
    return derive(
      journal(
        ...base,
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'blocked', {
          summary: 'Cannot reach postgres.',
          evidence: { needs: ['DATABASE_URL must be set', 'postgres must accept connections on 5432'] },
        }),
      ),
    );
  }
  if (kind === 'continue') {
    return derive(
      journal(
        ...base,
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'crashed', {
          summary: 'Added src/api/health.ts with the GET handler',
        }),
      ),
    );
  }
  if (kind === 'fix') {
    return derive(
      journal(
        ...base,
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'pass', { summary: 'Added GET /health.' }),
        started('T1-A', 'a2', 'tester'),
        ended('T1-A', 'a2', 'tester', 'fail', {
          summary: 'Health test failed.',
          evidence: {
            testOutput: 'FAIL test/api/health.test.ts\n  expected 200, got 500',
          },
        }),
      ),
    );
  }
  if (kind === 'rebase') {
    return derive(
      journal(
        ...base,
        started('T0-A', 'p1', 'builder'),
        ended('T0-A', 'p1', 'builder', 'pass'),
        started('T0-A', 'p2', 'tester'),
        ended('T0-A', 'p2', 'tester', 'pass'),
        makeEvent('merge.enqueued', { taskId: 'T0-A' }),
        makeEvent('merge.succeeded', {
          taskId: 'T0-A',
          sha: 'c0ffee0123456789abcdef0123456789abcdef01',
        }),
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'pass'),
        started('T1-A', 'a2', 'tester'),
        ended('T1-A', 'a2', 'tester', 'pass'),
        makeEvent('merge.enqueued', { taskId: 'T1-A' }),
        makeEvent('merge.conflicted', {
          taskId: 'T1-A',
          files: ['src/api/health.ts', 'src/api/routes.ts'],
        }),
      ),
    );
  }
  if (kind === 'integration-fix') {
    return derive(
      journal(
        ...base,
        started('T0-A', 'p1', 'builder'),
        ended('T0-A', 'p1', 'builder', 'pass', { summary: 'Scaffolded routes.' }),
        started('T0-A', 'p2', 'tester'),
        ended('T0-A', 'p2', 'tester', 'pass'),
        makeEvent('merge.enqueued', { taskId: 'T0-A' }),
        makeEvent('merge.succeeded', {
          taskId: 'T0-A',
          sha: 'c0ffee0123456789abcdef0123456789abcdef01',
        }),
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'fail', { summary: 'Typecheck failed on the first try.' }),
        started('T1-A', 'a2', 'builder'),
        ended('T1-A', 'a2', 'builder', 'fail', { summary: 'Typecheck failed again.' }),
        makeEvent('task.abandoned', { taskId: 'T1-A', reason: 'builder-failed-twice' }),
        makeEvent('final.test.ended', {
          outcome: 'fail',
          runInstructions: 'command: npx tsc --noEmit\ncwd: /tmp/integration',
          evidence: {
            failedRung: 'typecheck',
            ran: ['typecheck'],
            output: 'error TS2322: Type number is not assignable to type string.',
          },
        }),
        makeEvent('run.finished', { summary: '1 merged, 1 abandoned, final test fail' }),
        makeEvent('board.reopened', { taskIds: ['T1-A'], reason: 'user' }),
      ),
    );
  }
  throw new Error(`unknown kind ${kind}`);
}

// ── SEED_KINDS ───────────────────────────────────────────────────────────────

describe('SEED_KINDS', () => {
  it('is the seven kinds in policy-table order, plus integration-fix', () => {
    assert.deepEqual([...SEED_KINDS], [
      'initial',
      'failure-aware',
      'repair',
      'continue',
      'fix',
      'rebase',
      'integration-fix',
    ]);
  });
});

// ── purity ───────────────────────────────────────────────────────────────────

describe('buildSeed — purity', () => {
  it('carries merge diagnostics through the journal into the builder retry, with or without conflicts', async () => {
    for (const files of [['src/api/health.ts'], []]) {
      const summary = files.length ? 'Rebase failed: overlapping health handler edits' : 'Merge verification failed: missing task commits';
      const events = await boardEventsForAttemptEnd({
        role: 'merge', outcome: 'conflicted', taskId: 'T1-A', attemptId: 'merge1', files, summary,
      }, { id: 'b1', state: stateFor('initial') });
      const state = derive(journal(created(), ...events));
      const seed = buildSeed('rebase', { state, taskId: 'T1-A' });
      assert.equal(state.tasks.get('T1-A').attempts.at(-1).summary, summary);
      assert.ok(seed.includes(summary));
      assert.match(seed, /merge into integration failed/);
      assert.match(seed, /fix that integration failure before reporting pass/);
      assert.match(seed, /If a rebase is in progress/);
      for (const file of files) assert.ok(seed.includes(file));
    }
  });

  it('is a pure function: same inputs, same string', () => {
    for (const kind of SEED_KINDS) {
      const state = stateFor(kind);
      const a = buildSeed(kind, { state, taskId: 'T1-A' });
      const b = buildSeed(kind, { state, taskId: 'T1-A' });
      assert.equal(a, b, kind);
      assert.equal(typeof a, 'string');
      assert.ok(a.endsWith('\n'), kind);
    }
  });

  it('does no I/O, clock, or randomness', () => {
    const source = fs.readFileSync(SEEDS_JS, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const [re, why] of [
      [/\bfs\s*\./, 'filesystem'],
      [/\bfetch\s*\(/, 'network'],
      [/\bDate\s*\./, 'clock'],
      [/\bMath\.random\s*\(/, 'random'],
      [/\bimport\s+.*from\s+['"]node:/, 'node builtin'],
    ]) {
      assert.equal(re.test(code), false, why);
    }
  });

  it('throws on an unknown task rather than inventing a spec', () => {
    assert.throws(
      () => buildSeed('initial', { state: stateFor('initial'), taskId: 'NOPE' }),
      /unknown task/,
    );
  });
});

// ── goldens ──────────────────────────────────────────────────────────────────

describe('buildSeed — goldens', () => {
  for (const kind of SEED_KINDS) {
    it(`${kind} matches the golden file`, () => {
      const expected = fs
        .readFileSync(path.join(GOLDEN_DIR, `${kind}.txt`), 'utf8')
        .replace(/\r\n/g, '\n');
      const actual = buildSeed(kind, { state: stateFor(kind), taskId: 'T1-A' });
      assert.equal(actual, expected);
    });
  }
});
