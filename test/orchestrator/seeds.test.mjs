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

function started(taskId, attemptId, role, seedKind) {
  return makeEvent('task.attempt.started', { taskId, attemptId, role, ...(seedKind ? { seedKind } : {}) });
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
    // A fix attempt that crashed: the continue must keep the fix instructions
    // (and the tester output they quote), not fall back to the bare spec.
    return derive(
      journal(
        ...base,
        started('T1-A', 'a1', 'builder', 'initial'),
        ended('T1-A', 'a1', 'builder', 'pass', {
          summary: 'Added src/api/health.ts with the GET handler',
        }),
        started('T1-A', 'a2', 'tester', 'initial'),
        ended('T1-A', 'a2', 'tester', 'fail', {
          summary: 'Health test failed.',
          evidence: { testOutput: 'FAIL test/api/health.test.ts\n  expected 200, got 500' },
        }),
        started('T1-A', 'a3', 'builder', 'fix'),
        ended('T1-A', 'a3', 'builder', 'crashed', {
          summary: 'socket hang up',
          evidence: { error: 'socket hang up' },
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

  it('continue carries the caller digest and names interruptions as such', () => {
    const state = stateFor('continue');
    const digest = 'Files you changed:\n- src/api/health.ts';
    const seed = buildSeed('continue', { state, taskId: 'T1-A', resume: digest });
    assert.ok(seed.includes(digest));
    assert.equal(seed.includes('Already done:'), false);
    assert.match(seed, /## Test output/, 'keeps the fix seed it resumes');

    const interrupted = derive(journal(
      created(),
      makeEvent('board.started', { concurrency: 1 }),
      started('T1-A', 'a1', 'builder', 'initial'),
      ended('T1-A', 'a1', 'builder', 'crashed', {
        summary: 'the process was no longer running',
        evidence: { interrupted: true },
      }),
    ));
    const resumed = buildSeed('continue', { state: interrupted, taskId: 'T1-A' });
    assert.match(resumed, /was interrupted/);
    assert.equal(resumed.includes('the process was no longer running'), false);
  });

  it('fix quotes the tester fail even when a crash came after it', () => {
    const seed = buildSeed('fix', { state: stateFor('continue'), taskId: 'T1-A' });
    assert.match(seed, /expected 200, got 500/);
    assert.equal(seed.includes('socket hang up'), false);
  });

  it('integration-fix after a passing final test builds the task instead of chasing a failure', () => {
    const state = derive(
      journal(
        created(),
        makeEvent('board.started', { concurrency: 1 }),
        started('T1-A', 'a1', 'builder'),
        ended('T1-A', 'a1', 'builder', 'crashed', { summary: 'insufficient memory' }),
        makeEvent('task.abandoned', { taskId: 'T1-A', reason: 'builder-crashed' }),
        makeEvent('final.test.ended', {
          outcome: 'pass',
          runInstructions: 'command: npm test\ncwd: /tmp/integration',
          evidence: { failedRung: null, ran: ['unit'] },
        }),
        makeEvent('run.finished', { summary: '0 merged, 1 abandoned, final test pass' }),
        makeEvent('board.reopened', { taskIds: ['T1-A'], reason: 'user' }),
      ),
    );
    const seed = buildSeed('integration-fix', { state, taskId: 'T1-A' });
    assert.match(seed, /did not finish this task \(builder-crashed\)/);
    assert.match(seed, /integration branch is not broken/);
    assert.equal(seed.includes('What the final test found'), false);
    assert.equal(seed.includes('Fix the integration failure'), false);
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

// ── tester ───────────────────────────────────────────────────────────────────

/** A builder pass that strayed outside its touches, ready for the tester. */
function testerState() {
  return derive(
    journal(
      created(),
      makeEvent('board.started', { concurrency: 1 }),
      started('T1-A', 'a1', 'builder', 'initial'),
      makeEvent('touches.overflow', {
        taskId: 'T1-A',
        attemptId: 'a1',
        declared: ['src/api/health.ts'],
        actual: ['src/api/routes.ts'],
      }),
      ended('T1-A', 'a1', 'builder', 'pass', {
        summary: 'Added GET /health returning { ok: true } and registered it.',
        evidence: { evidence: ['src/api/health.ts — new handler', 'npm test -- health: 3 passed'] },
      }),
    ),
  );
}

describe('buildSeed — tester', () => {
  it('starts the tester from the builder report and the branch diff', () => {
    const seed = buildSeed('initial', { state: testerState(), taskId: 'T1-A', role: 'tester', diffBase: 'minnow/board/b1/integration' });
    assert.ok(seed.startsWith(buildSeed('initial', { state: testerState(), taskId: 'T1-A' }).trimEnd()));
    assert.match(seed, /## Builder report/);
    assert.match(seed, /Added GET \/health/);
    assert.match(seed, /- npm test -- health: 3 passed/);
    assert.match(seed, /Changed outside the declared touches:\n- src\/api\/routes\.ts/);
    assert.match(seed, /git diff minnow\/board\/b1\/integration\.\.\.HEAD/);
  });

  it('falls back to git log without a diff base and leaves builder seeds alone', () => {
    const seed = buildSeed('initial', { state: testerState(), taskId: 'T1-A', role: 'tester' });
    assert.match(seed, /`git log` \/ `git show`/);
    assert.equal(seed.includes('Changed outside'), true);
    const builder = buildSeed('initial', { state: testerState(), taskId: 'T1-A', role: 'builder' });
    assert.equal(builder.includes('## Builder report'), false);
  });

  it('matches the golden file', () => {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, 'tester.txt'), 'utf8').replace(/\r\n/g, '\n');
    const actual = buildSeed('initial', { state: testerState(), taskId: 'T1-A', role: 'tester', diffBase: 'minnow/board/b1/integration' });
    assert.equal(actual, expected);
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
