/**
 * W3-B — Super Plan boot scan.
 *
 * Seeds a non-terminal journal (an open `stage.started` with no end), boots
 * `bootSuperPlanRuntime()`, and asserts the engine tick re-plans the open
 * stage without a user Resume click and without any SSE subscription. A
 * terminal journal must be skipped entirely.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { peekEngine } from '../../server/orchestrator/engine.js';
import {
  armBoardResumeGate,
  listPendingBoardResumes,
  resetBoardResumeGateForTests,
} from '../../server/orchestrator/resume-gate.js';
import {
  bootSuperPlanRuntime,
  resetSuperPlanMiddlewareForTests,
  setSuperPlanEffectorFactory,
} from '../../server/super-plan/middleware.js';
import {
  appendEvent,
  createEntry,
  readEvents,
  resetJournalCache,
} from '../../server/super-plan/journal.js';
import { makeEvent } from '../../server/super-plan/events.js';
import { SUPERPLAN_NAMESPACE } from '../../server/super-plan/journal.js';

const RUN_ID = 'run-1';
const FINISHED_ID = 'run-finished';
const PROMPT = 'Build a Kanban UI';
const WORKSPACE = path.resolve(os.tmpdir(), 'kanban-ws');

/** @type {string | undefined} */
let previousHome;

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

/** @param {string} runId */
async function seedNonTerminal(runId) {
  await createEntry(runId);
  await appendEvent(runId, makeEvent('run.created', { runId, prompt: PROMPT, workspacePath: WORKSPACE }));
  await appendEvent(runId, makeEvent('run.started', {}));
  await appendEvent(runId, makeEvent('stage.started', { stage: 'interview', attemptId: 'i1' }));
}

/** @param {string} runId */
async function seedFinished(runId) {
  await createEntry(runId);
  await appendEvent(runId, makeEvent('run.created', { runId, prompt: PROMPT, workspacePath: WORKSPACE }));
  await appendEvent(runId, makeEvent('run.started', {}));
  await appendEvent(
    runId,
    makeEvent('run.finished', { outcome: 'pass', summary: 'the plan passed the accept gate' }),
  );
}

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-super-plan-boot-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  resetSuperPlanMiddlewareForTests();
  resetBoardResumeGateForTests();

  // Production boot arms the board resume gate (server/runtime/middlewares.js
  // line 83). A super-plan run must re-arm despite it — no user Resume click.
  armBoardResumeGate();

  setSuperPlanEffectorFactory(() =>
    createScriptedEffector({ script: [{ match: { role: 'gate' }, emit: { outcome: 'pass', delayMs: 60000 } }, { emit: { outcome: 'pass', delayMs: 60_000 } }] }),
  );
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  resetSuperPlanMiddlewareForTests();
  resetBoardResumeGateForTests();
});

describe('super-plan boot scan', () => {
  it('re-arms a non-terminal run and replans the open stage without a user Resume click', async () => {
    await seedNonTerminal(RUN_ID);
    const clock = fakeClock();

    // Boot: getEngine every non-terminal run, so engine.js load() re-arms the
    // safety tick for state.status === 'running'.
    await bootSuperPlanRuntime({ clock, tickMs: 60_000 });

    const engine = peekEngine(RUN_ID, SUPERPLAN_NAMESPACE);
    assert.ok(engine, 'boot did not load the non-terminal run');
    assert.equal(engine.getState().status, 'running');
    assert.equal(engine.getState().stage, 'interview');
    assert.equal(clock.pending >= 1, true, 'load() did not re-arm a timer');
    assert.equal(
      engine.wasHeldAtLoad(),
      false,
      'the armed boot resume gate must not hold a super-plan run',
    );
    assert.deepEqual(
      listPendingBoardResumes(),
      [],
      'a held run would wait for a user Resume click; nothing may be pending',
    );

    // Let the re-armed timer fire. No HTTP resume call, no SSE subscription.
    await clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = await readEvents(RUN_ID);
    const started = events.filter((e) => e.type === 'stage.started');
    assert.equal(started.length, 2, 'the open stage must be re-planned once');
    assert.equal(started[1].stage, 'interview');
    assert.equal(started[1].seedKind, 'continue', 'the replan must carry the continue seed');
    const crashed = events.filter((e) => e.type === 'stage.ended' && e.outcome === 'crashed');
    assert.equal(crashed.length, 1, 'the vanished attempt must be reaped as crashed');
    assert.equal(crashed[0].attemptId, 'i1');
  });

  it('skips terminal runs entirely', async () => {
    await seedFinished(FINISHED_ID);
    await seedNonTerminal(RUN_ID);
    const clock = fakeClock();

    await bootSuperPlanRuntime({ clock, tickMs: 60_000 });

    assert.ok(peekEngine(RUN_ID, SUPERPLAN_NAMESPACE), 'the non-terminal run was not loaded');
    assert.equal(
      peekEngine(FINISHED_ID, SUPERPLAN_NAMESPACE),
      undefined,
      'a finished run must not get an engine',
    );
    assert.equal(clock.pending >= 1, true, 'only the non-terminal run re-armed a timer');
  });

  it('GET state reflects a run that resumed itself after the boot scan', async () => {
    await seedNonTerminal(RUN_ID);
    const clock = fakeClock();
    await bootSuperPlanRuntime({ clock, tickMs: 60_000 });
    await clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The Accept criterion: state — without opening an SSE stream — reflects
    // the run that resumed itself.
    const engine = peekEngine(RUN_ID, SUPERPLAN_NAMESPACE);
    assert.ok(engine, 'the resumed run has no engine');
    const state = engine.getState();
    assert.equal(state.status, 'running');
    assert.equal(state.stage, 'interview');
    assert.equal(
      state.attempts.filter((a) => a.stage === 'interview' && !a.ended).length,
      1,
      'the replan must leave exactly one open interview attempt',
    );
  });
});