/**
 * P3-G — end-of-run report writer (MIN-711).
 *
 * Stateless: one complete() over the journal. Terminal output only — never
 * input to plan / derive / policy / merge-queue.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine, disposeEngines } from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  appendEvent,
  createBoard,
  readEvents,
  resetJournalCache,
} from '../../server/orchestrator/journal.js';
import {
  buildReportInput,
  journalHasReport,
  persistReport,
  REPORT_EVENT_TYPE,
  reportPath,
  suggestedNextStep,
  writeEndOfRunReport,
} from '../../server/orchestrator/report.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORCH_DIR = path.join(PROJECT_ROOT, 'server', 'orchestrator');

/** @type {string | undefined} */
let previousHome;

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-report-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
});

afterEach(() => {
  disposeEngines();
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
});

/** A clock the test drives. Nothing here waits on real time. */
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
        timer.fn();
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

/**
 * @param {string} boardId
 * @param {Record<string, unknown>[]} extra
 */
async function seedAbandonedJournal(boardId, extra = []) {
  await createBoard(boardId);
  const events = [
    makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      name: 'Abandoned run',
      tasks: [
        {
          id: 'W1-A',
          title: 'Auth',
          wave: 1,
          dependsOn: [],
          touches: ['src/a/**'],
          build: 'build',
          test: 'test',
          accept: 'ok',
        },
        {
          id: 'W1-B',
          title: 'Blocked child',
          wave: 1,
          dependsOn: ['W1-A'],
          touches: ['src/b/**'],
          build: 'build',
          test: 'test',
          accept: 'ok',
        },
      ],
      waves: [{ n: 1, name: 'One' }],
    }),
    makeEvent('board.started', { concurrency: 1 }),
    makeEvent('task.attempt.started', {
      taskId: 'W1-A',
      attemptId: 'a1',
      role: 'builder',
      seedKind: 'initial',
    }),
    makeEvent('task.attempt.ended', {
      taskId: 'W1-A',
      attemptId: 'a1',
      role: 'builder',
      outcome: 'blocked',
      summary: 'database missing',
      evidence: { blockers: ['psql refused'], needs: ['DATABASE_URL'], testOutput: 'connection refused' },
    }),
    makeEvent('task.abandoned', {
      taskId: 'W1-A',
      reason: 'builder-blocked',
      evidence: {
        outcome: 'blocked',
        attempts: [
          {
            attemptId: 'a1',
            role: 'builder',
            seedKind: 'initial',
            ended: true,
            outcome: 'blocked',
            summary: 'database missing',
            blockers: ['psql refused'],
            needs: ['DATABASE_URL'],
            testOutput: 'connection refused',
          },
        ],
      },
    }),
    makeEvent('task.skipped', { taskId: 'W1-B', blockedBy: 'W1-A' }),
    makeEvent('run.finished', { summary: '0 merged, 1 abandoned, 1 skipped' }),
    makeEvent('board.stopped', { reason: 'complete' }),
    ...extra,
  ];
  for (const event of events) await appendEvent(boardId, event);
  return readEvents(boardId);
}

function taskSpec(id) {
  return {
    id,
    title: id,
    wave: 1,
    dependsOn: [],
    touches: [`src/${id}/**`],
    build: 'build',
    test: 'test',
    accept: 'ok',
  };
}

// ── suggestedNextStep ────────────────────────────────────────────────────────

describe('suggestedNextStep', () => {
  it('names a concrete unblock for a blocked abandonment', () => {
    const step = suggestedNextStep({
      taskId: 'W1-A',
      reason: 'builder-blocked',
      evidence: {
        attempts: [{ outcome: 'blocked', blockers: ['psql refused'], role: 'builder' }],
      },
    });
    assert.match(step, /W1-A/);
    assert.match(step, /psql refused/);
  });
});

// ── abandoned task ───────────────────────────────────────────────────────────

describe('writeEndOfRunReport — abandoned task', () => {
  it('names the task, its evidence, and a concrete next step', async () => {
    const boardId = 'abandon-report';
    const events = await seedAbandonedJournal(boardId);
    const state = derive(events);
    const result = await writeEndOfRunReport({
      boardId,
      events,
      state,
      complete: async ({ input }) => {
        const row = /** @type {Record<string, unknown>} */ (input.abandoned[0]);
        return [
          '# Report',
          '',
          `Abandoned **${row.taskId}**.`,
          '',
          `Evidence testOutput: ${JSON.stringify(row.evidence)}`,
          '',
          `Next step: ${row.nextStep}`,
        ].join('\n');
      },
    });
    assert.match(result.markdown, /W1-A/);
    assert.match(result.markdown, /connection refused|psql refused/);
    assert.match(result.markdown, /Unblock W1-A/);
    const written = await fsp.readFile(reportPath(boardId), 'utf8');
    assert.match(written, /W1-A/);
    assert.match(written, /Unblock W1-A/);
  });

  it('uses the mechanical fallback when complete() never resolves', async () => {
    const boardId = 'hung-complete';
    const events = await seedAbandonedJournal(boardId);
    const state = derive(events);
    const result = await writeEndOfRunReport({
      boardId,
      events,
      state,
      completeTimeoutMs: 20,
      complete: () => new Promise(() => {}),
    });
    assert.equal(result.usedFallback, true);
    assert.match(result.markdown, /W1-A|# |Abandoned|Report/i);
  });
});

// ── stateless ────────────────────────────────────────────────────────────────

describe('writeEndOfRunReport — stateless', () => {
  it('sends identical input on two calls over the same journal', async () => {
    const boardId = 'stateless-report';
    const events = await seedAbandonedJournal(boardId);
    const state = derive(events);
    /** @type {Record<string, unknown>[]} */
    const seen = [];
    const complete = async ({ input }) => {
      seen.push(input);
      return 'ok';
    };
    await writeEndOfRunReport({ boardId, events, state, complete });
    await writeEndOfRunReport({ boardId, events, state, complete });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(JSON.stringify(seen[0]), JSON.stringify(seen[1]));
  });
});

// ── one report per run ───────────────────────────────────────────────────────

describe('engine — one report per run', () => {
  it('a fully successful run produces exactly one report event and one artifact', async () => {
    const boardId = 'success-report';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', {
        boardId,
        planPath: 'plan.md',
        name: 'Success',
        tasks: [taskSpec('A')],
        waves: [],
      }),
    );
    /** @type {string[]} */
    const calls = [];
    const clock = fakeClock();
    const effector = createScriptedEffector({ script: [{ emit: { outcome: 'pass' } }], clock });
    const engine = createEngine({
      boardId,
      effector,
      clock,
      tickMs: 5_000,
      complete: async ({ input }) => {
        calls.push('complete');
        return `# Report\n\nShipped ${/** @type {unknown[]} */ (input.shipped).length} task(s).`;
      },
    });
    await engine.load();
    await engine.startBoard(1);
    for (let i = 0; i < 80; i += 1) {
      await settle();
      if (engine.getState().finished && journalHasReport(await engine.getEvents())) break;
      await engine.tick();
      if (clock.pending > 0) await clock.advance(10_000);
    }
    assert.equal(engine.getState().finished, true);
    const events = await engine.getEvents();
    const reports = events.filter((e) => e.type === REPORT_EVENT_TYPE);
    assert.equal(reports.length, 1);
    assert.equal(calls.length, 1);
    const markdown = await fsp.readFile(reportPath(boardId), 'utf8');
    assert.match(markdown, /Shipped 1/);
    const files = await fsp.readdir(path.dirname(reportPath(boardId)));
    assert.equal(files.filter((name) => name === 'report.md').length, 1);
    await engine.tick();
    await engine.tick();
    assert.equal((await engine.getEvents()).filter((e) => e.type === REPORT_EVENT_TYPE).length, 1);
    assert.equal(calls.length, 1);
    engine.dispose();
  });

  it('a user-stopped run describes partial progress, not an error', async () => {
    const boardId = 'user-stop-report';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', {
        boardId,
        planPath: 'plan.md',
        name: 'Partial',
        tasks: [taskSpec('A'), taskSpec('B')],
        waves: [],
      }),
    );
    const clock = fakeClock();
    const effector = createScriptedEffector({
      script: [{ emit: { outcome: 'pass', delayMs: 9999 } }],
      clock,
    });
    const engine = createEngine({
      boardId,
      effector,
      clock,
      tickMs: 5_000,
      complete: async ({ input }) => {
        const reason = input.stopReason === 'user' ? 'stopped by the user' : 'unknown';
        return `# Report\n\nThis is ${reason}. Partial progress, not an error.\nStill open: ${JSON.stringify(input.stillOpen)}`;
      },
    });
    await engine.load();
    await engine.startBoard(2);
    await settle();
    await engine.stopBoard('user');
    const events = await engine.getEvents();
    assert.equal(events.filter((e) => e.type === REPORT_EVENT_TYPE).length, 1);
    const markdown = await fsp.readFile(reportPath(boardId), 'utf8');
    assert.match(markdown, /stopped by the user/i);
    assert.match(markdown, /not an error/i);
    assert.doesNotMatch(markdown, /fatal error|crashed the run/i);
    assert.equal(engine.getState().finished, false);
    engine.dispose();
  });

  it('calls the writer from exactly one function in the engine', () => {
    const engine = fs.readFileSync(path.join(ORCH_DIR, 'engine.js'), 'utf8');
    const graph = fs.readFileSync(path.join(ORCH_DIR, 'board-graph.js'), 'utf8');
    assert.match(engine, /graph\.writeReport/);
    // collectEndOfRunReport is the only graph.writeReport caller; the user-stop
    // path goes through maybeWriteEndOfRunReport which delegates to it.
    assert.equal([...engine.matchAll(/\bgraph\.writeReport\(/g)].length, 1);
    assert.match(engine, /\bcollectEndOfRunReport\s*\(/);
    assert.match(engine, /\bmaybeWriteEndOfRunReport\s*\(/);
    assert.match(graph, /from '\.\/report\.js'/);
    assert.equal([...graph.matchAll(/\bwriteEndOfRunReport\s*\(/g)].length, 1);
  });
});

// ── report never feeds ───────────────────────────────────────────────────────

describe('report never feeds engine decisions', () => {
  it('plan, derive, policy, and merge-queue do not import report.js', () => {
    const files = [
      'core/plan.js',
      'core/derive.js',
      'core/policy.js',
      'merge-queue.js',
    ];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(ORCH_DIR, rel), 'utf8');
      assert.equal(source.includes('report.js'), false, rel);
    }
  });

  it('opaque report events do not change derived decisions', async () => {
    const boardId = 'fold-ignore';
    const events = await seedAbandonedJournal(boardId);
    const before = derive(events);
    const after = derive([
      ...events,
      makeEvent(REPORT_EVENT_TYPE, { path: 'report.md', usedFallback: false }),
    ]);
    assert.equal(after.finished, before.finished);
    assert.equal(after.tasks.get('W1-A')?.phase, before.tasks.get('W1-A')?.phase);
    assert.deepEqual(
      [...after.tasks.values()].map((t) => t.phase),
      [...before.tasks.values()].map((t) => t.phase),
    );
  });

  it('buildReportInput does not include transcripts', async () => {
    const boardId = 'no-tokens';
    const events = await seedAbandonedJournal(boardId);
    const input = buildReportInput(events, derive(events));
    const json = JSON.stringify(input);
    assert.equal(json.includes('transcript'), false);
    assert.equal(json.includes('prompt_tokens'), false);
  });
});

// ── journalHasReport / persist ───────────────────────────────────────────────

describe('journalHasReport / persist', () => {
  it('invalidates a user-stop report on resume and subsequent completion', () => {
    const report = { type: REPORT_EVENT_TYPE };
    assert.equal(journalHasReport([report, { type: 'board.started' }]), false);
    assert.equal(journalHasReport([report, { type: 'run.finished' }]), false);
    assert.equal(journalHasReport([report, { type: 'task.reset' }]), false);
    assert.equal(journalHasReport([report, { type: 'board.started' }, { type: 'run.finished' }, report]), true);
  });

  it('reports recovered tasks as shipped without their historical abandonments', async () => {
    const events = await seedAbandonedJournal('recovered');
    events.push(
      makeEvent('board.reopened', { taskIds: ['W1-A', 'W1-B'], reason: 'user' }),
      makeEvent('merge.succeeded', { taskId: 'W1-A', sha: 'fixed-a' }),
      makeEvent('merge.succeeded', { taskId: 'W1-B', sha: 'fixed-b' }),
    );
    const input = buildReportInput(events, derive(events));
    assert.deepEqual(input.abandoned, []);
    assert.deepEqual(input.shipped.map((task) => task.id), ['W1-A', 'W1-B']);
    assert.ok(input.events.some((event) => event.type === 'task.abandoned'), 'retain the audit history');
  });

  it('detects the opaque event', () => {
    assert.equal(journalHasReport([{ type: 'run.finished' }]), false);
    assert.equal(journalHasReport([{ type: REPORT_EVENT_TYPE }]), true);
  });

  it('ignores a report from a previous run after board.reopened', () => {
    assert.equal(
      journalHasReport([
        { type: REPORT_EVENT_TYPE },
        { type: 'board.reopened' },
      ]),
      false,
    );
    assert.equal(
      journalHasReport([
        { type: REPORT_EVENT_TYPE },
        { type: 'board.reopened' },
        { type: REPORT_EVENT_TYPE },
      ]),
      true,
    );
  });

  it('persistReport writes next to the journal', async () => {
    await createBoard('persist-me');
    const written = await persistReport('persist-me', '# hi\n');
    assert.equal(written, reportPath('persist-me'));
    assert.equal(await fsp.readFile(written, 'utf8'), '# hi\n');
  });
});
