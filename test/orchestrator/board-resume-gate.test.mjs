/**
 * Boot resume gate for boards.
 *
 * `engine.load()` used to end with an unconditional
 * `if (state.status === 'running') startTimer()`, and engines are built lazily —
 * so the first request touching a board after a restart silently resumed its
 * agents. These tests pin the hold, and pin that it stays off unless armed.
 *
 * Runs on the plain `node` runner with no loader flags.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  appendEvent,
  createBoard,
  resetJournalCache,
} from '../../server/orchestrator/journal.js';
import {
  armBoardResumeGate,
  listPendingBoardResumes,
  resetBoardResumeGateForTests,
  resolveAllBoardResumes,
  shouldHoldBoardResume,
} from '../../server/orchestrator/resume-gate.js';

const TASKS = [
  { id: 'T1', title: 'One', dependsOn: [], touches: [] },
  { id: 'T2', title: 'Two', dependsOn: [], touches: [] },
];

/** A board whose journal says `running` — the crash / force-quit shape. */
async function seedRunningBoard(boardId) {
  await createBoard(boardId);
  await appendEvent(
    boardId,
    makeEvent('board.created', { boardId, planPath: 'p.md', tasks: TASKS, waves: [] }),
  );
  await appendEvent(boardId, makeEvent('board.started', { concurrency: 1 }));
}

function buildEngine(boardId) {
  return createEngine({ boardId, effector: createScriptedEffector({}) });
}

/** @type {string | undefined} */
let previousHome;
/** @type {string} */
let scratchHome;

// These journals say `running`; in the real ~/.minnow the app would find them at boot.
before(() => {
  previousHome = process.env.MINNOW_HOME;
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-resume-gate-'));
  process.env.MINNOW_HOME = scratchHome;
  resetMinnowHomeCache();
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('board boot resume gate', () => {
  beforeEach(() => {
    resetJournalCache();
    resetBoardResumeGateForTests();
  });

  afterEach(() => {
    resetBoardResumeGateForTests();
  });

  it('is disarmed by default, so a running board loads and runs as before', async () => {
    const boardId = 'gate-off';
    await seedRunningBoard(boardId);
    const engine = buildEngine(boardId);
    await engine.load();
    try {
      assert.equal(shouldHoldBoardResume(boardId), false);
      assert.equal(engine.wasHeldAtLoad(), false, 'nothing should be held while disarmed');
      assert.deepEqual(listPendingBoardResumes(), []);
    } finally {
      engine.dispose();
    }
  });

  it('holds a running board at load once armed, and lists it for the prompt', async () => {
    armBoardResumeGate();
    const boardId = 'gate-on';
    await seedRunningBoard(boardId);
    const engine = buildEngine(boardId);
    await engine.load();
    try {
      assert.equal(engine.wasHeldAtLoad(), true, 'a running board must not self-resume');
      const { holdBoardResume } = await import('../../server/orchestrator/resume-gate.js');
      holdBoardResume({
        boardId,
        resume: () => engine.resumeAfterGate(),
        decline: () => engine.stopBoard('user'),
        peek: () => engine.getState(),
      });
      const pending = listPendingBoardResumes();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].boardId, boardId);
      assert.equal(pending[0].taskCount, 2, 'task count rides along for the prompt');
    } finally {
      engine.dispose();
    }
  });

  it('does not hold a board that is not running', async () => {
    armBoardResumeGate();
    const boardId = 'gate-idle';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', { boardId, planPath: 'p.md', tasks: TASKS, waves: [] }),
    );
    const engine = buildEngine(boardId);
    await engine.load();
    try {
      assert.equal(engine.wasHeldAtLoad(), false, 'only `running` boards are candidates');
      assert.deepEqual(listPendingBoardResumes(), []);
    } finally {
      engine.dispose();
    }
  });

  it('answering once settles the board, so a rebuilt engine does not re-prompt', async () => {
    armBoardResumeGate();
    const boardId = 'gate-answered';
    await seedRunningBoard(boardId);

    const first = buildEngine(boardId);
    await first.load();
    let resumed = false;
    try {
      assert.equal(first.wasHeldAtLoad(), true);
      resetBoardResumeGateForTests();
      armBoardResumeGate();
      const { holdBoardResume } = await import('../../server/orchestrator/resume-gate.js');
      holdBoardResume({
        boardId,
        resume: () => {
          resumed = true;
        },
        decline: async () => {},
        peek: () => first.getState(),
      });
      const ids = await resolveAllBoardResumes('resume');
      assert.deepEqual(ids, [boardId]);
      assert.equal(resumed, true, 'Resume must release the withheld timer');
      assert.deepEqual(listPendingBoardResumes(), []);
    } finally {
      first.dispose();
    }

    assert.equal(shouldHoldBoardResume(boardId), false);
    const second = buildEngine(boardId);
    await second.load();
    try {
      assert.equal(second.wasHeldAtLoad(), false, 'a settled board must not re-prompt');
    } finally {
      second.dispose();
    }
  });

  it('decline runs the caller-supplied stop instead of resuming', async () => {
    armBoardResumeGate();
    const boardId = 'gate-declined';
    let resumed = false;
    let stopped = false;
    const { holdBoardResume } = await import('../../server/orchestrator/resume-gate.js');
    holdBoardResume({
      boardId,
      resume: () => {
        resumed = true;
      },
      decline: async () => {
        stopped = true;
      },
      peek: () => ({ name: 'Declined', tasks: [] }),
    });

    await resolveAllBoardResumes('decline');
    assert.equal(stopped, true, 'decline persists a stop');
    assert.equal(resumed, false, 'decline must never start the timer');
    assert.deepEqual(listPendingBoardResumes(), []);
  });
});
