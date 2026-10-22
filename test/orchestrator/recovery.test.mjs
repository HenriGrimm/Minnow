import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import {
  appendEvent,
  createBoard,
  loadState,
  readEvents,
  refreshSnapshot,
  resetJournalCache,
  snapshotPath,
} from '../../server/orchestrator/journal.js';
import { CONCURRENCY, SCRIPT, TASKS } from './recovery-child.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const CHILD = path.join(HERE, 'recovery-child.mjs');

/** @type {string} */
let home;
/** @type {string | undefined} */
let previousHome;

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-recovery-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
});

/**
 * @param {string} boardId
 * @param {'killAfter' | 'killOnStart' | 'run'} mode
 * @param {number} arg
 * @returns {Promise<{ diedEarly: boolean, code: number | null, signal: string | null, stderr: string }>}
 */
function runChild(boardId, mode, arg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, boardId, mode, String(arg)], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, MINNOW_HOME: home },
    });
    let stderr = '';
    let completed = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('message', (message) => {
      if (message && typeof message === 'object' && 'finished' in message) completed = true;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child hung (${mode} ${arg}): ${stderr}`));
    }, 30_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ diedEarly: !completed, code, signal, stderr });
    });
    child.once('error', reject);
  });
}

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * @param {string} boardId
 * @returns {Promise<import('../../server/orchestrator/core/types').BoardState>}
 */
async function restartAndFinish(boardId) {
  const effector = createScriptedEffector({ script: SCRIPT });
  const engine = createEngine({ boardId, effector, tickMs: 100_000 });
  await engine.load();
  try {
    await engine.startBoard(CONCURRENCY);
    for (let i = 0; i < 600; i += 1) {
      await settle();
      if (engine.getState().finished) return engine.getState();
      await engine.tick();
    }
    assert.fail(`board ${boardId} did not finish after restart`);
  } finally {
    engine.dispose();
  }
}

function attemptIds(events) {
  const started = events.filter((e) => e.type === 'task.attempt.started');
  const ended = events.filter((e) => e.type === 'task.attempt.ended');
  return { started, ended };
}

// ── Kill recovery ────────────────────────────────────────────────────────────

describe('recovery — a kill at every event index', () => {
  it('recovers to a consistent board that completes, from all 60 kill points', async () => {
    const KILL_POINTS = 60;
    let killed = 0;
    let completed = 0;

    for (let at = 1; at <= KILL_POINTS; at += 1) {
      const boardId = `k${at}`;
      const result = await runChild(boardId, 'killAfter', at);

      const events = await readEvents(boardId);
      if (result.diedEarly) killed += 1;

      assert.deepEqual(
        events.map((e) => e.seq),
        events.map((_, i) => i + 1),
        `kill at ${at}: journal is not gaplessly numbered`,
      );
      assert.doesNotThrow(() => derive(events), `kill at ${at}: journal does not derive`);

      resetJournalCache();
      assert.deepEqual(await loadState(boardId), derive(events), `kill at ${at}: loadState diverged`);

      const { started, ended } = attemptIds(events);
      const startedIds = new Set(started.map((e) => e.attemptId));
      for (const end of ended) {
        assert.ok(startedIds.has(end.attemptId), `kill at ${at}: ${end.attemptId} ended unstarted`);
      }
      assert.equal(
        startedIds.size,
        started.length,
        `kill at ${at}: an attempt id was started twice`,
      );

      const state = await restartAndFinish(boardId);
      assert.equal(state.finished, true, `kill at ${at}: did not finish after restart`);
      completed += 1;
    }

    assert.equal(completed, KILL_POINTS);
    assert.ok(killed > KILL_POINTS / 2, `only ${killed} of ${KILL_POINTS} runs actually died`);
  });

  it('recovers a journal left with a half-written final line', async () => {
    const boardId = 'torn';
    await runChild(boardId, 'killAfter', 20);

    const file = path.join(home, 'boards', boardId, 'journal.jsonl');
    const whole = await fs.readFile(file, 'utf8');
    const lastLineStart = whole.lastIndexOf('\n', whole.length - 2) + 1;
    assert.ok(lastLineStart > 0, 'the child wrote too little to tear');
    const cut = lastLineStart + Math.floor((whole.length - 1 - lastLineStart) / 2);
    await fs.writeFile(file, whole.slice(0, cut), 'utf8');
    resetJournalCache();

    const before = await readEvents(boardId);
    assert.deepEqual(
      before.map((e) => e.seq),
      before.map((_, i) => i + 1),
      'the torn journal does not read back gaplessly',
    );

    const state = await restartAndFinish(boardId);
    assert.equal(state.finished, true);

    resetJournalCache();
    const after = await readEvents(boardId);
    assert.deepEqual(after.map((e) => e.seq), after.map((_, i) => i + 1));
    assert.deepEqual(await loadState(boardId), derive(after));
  });

  it('starts exactly one attempt when killed between start() and the journal append', async () => {
    const boardId = 'window';
    const result = await runChild(boardId, 'killOnStart', 1);
    assert.equal(result.diedEarly, true, `child completed instead of dying: ${result.stderr}`);

    const events = await readEvents(boardId);
    assert.equal(
      events.filter((e) => e.type === 'task.attempt.started').length,
      0,
      'an attempt was journaled before it was licensed to be',
    );

    resetJournalCache();
    const state = await restartAndFinish(boardId);
    assert.equal(state.finished, true);

    const after = await readEvents(boardId);
    const firstTask = after.find((e) => e.type === 'task.attempt.started');
    const startsForThatTask = after.filter(
      (e) => e.type === 'task.attempt.started' && e.taskId === firstTask.taskId && e.role === 'builder',
    );
    assert.equal(startsForThatTask.length, 1, 'the lost attempt was started twice');
  });

  it('survives a kill during a burst of concurrent appends — the OOM analogue', async () => {
    const boardId = 'burst';
    await runChild(boardId, 'killAfter', 25);

    const events = await readEvents(boardId);
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
    resetJournalCache();
    assert.deepEqual(await loadState(boardId), derive(events));
    assert.equal((await restartAndFinish(boardId)).finished, true);
  });

  it('discards a snapshot written over mid-flight and folds the journal instead', async () => {
    const boardId = 'snap';
    await runChild(boardId, 'killAfter', 30);
    const events = await readEvents(boardId);
    const expected = derive(events);

    await refreshSnapshot(boardId);
    const whole = await fs.readFile(snapshotPath(boardId), 'utf8');
    await fs.writeFile(snapshotPath(boardId), whole.slice(0, Math.floor(whole.length / 2)), 'utf8');

    resetJournalCache();
    assert.deepEqual(await loadState(boardId), expected);
    assert.equal((await restartAndFinish(boardId)).finished, true);
  });
});

// ── Display sleep ────────────────────────────────────────────────────────────

describe('recovery — the display-sleep analogue', () => {
  it('recovers when every process vanishes at once, with no wake-specific code', async () => {
    const boardId = 'sleep';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', { boardId, planPath: 'p.md', tasks: TASKS, waves: [] }),
    );

    const effector = createScriptedEffector({
      script: [{ emit: { outcome: 'pass', delayMs: 100_000 } }],
    });
    const engine = createEngine({ boardId, effector, tickMs: 100_000 });
    await engine.load();

    try {
      await engine.startBoard(CONCURRENCY);
      await settle();
      assert.equal(effector.inspect().length, CONCURRENCY, 'the board did not get going');

      effector.vanishAll();
      assert.equal(effector.inspect().length, 0);

      const resumed = createScriptedEffector({ script: SCRIPT });
      const after = createEngine({ boardId, effector: resumed, tickMs: 100_000 });
      await after.load();
      try {
        await after.startBoard(CONCURRENCY);
        for (let i = 0; i < 600 && !after.getState().finished; i += 1) {
          await settle();
          await after.tick();
        }
        assert.equal(after.getState().finished, true);
      } finally {
        after.dispose();
      }
    } finally {
      engine.dispose();
    }
  });

  it('reloads the same state a fresh engine would derive', async () => {
    const boardId = 'reload';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', { boardId, planPath: 'p.md', tasks: TASKS, waves: [] }),
    );
    const effector = createScriptedEffector({ script: [{ emit: { outcome: 'pass', delayMs: 100_000 } }] });
    const engine = createEngine({ boardId, effector, tickMs: 100_000 });
    await engine.load();
    try {
      await engine.startBoard(CONCURRENCY);
      await settle();

      const inMemory = engine.getState();
      const fromDisk = await loadState(boardId);
      assert.deepEqual(fromDisk, inMemory, 'the in-memory fold drifted from the journal');

      await engine.reload();
      assert.deepEqual(engine.getState(), inMemory);
    } finally {
      engine.dispose();
    }
  });
});

// ── No recovery code ─────────────────────────────────────────────────────────

describe('recovery — there is no recovery code', () => {
  it('exposes no resume, wake, or repair entry point on the engine', async () => {
    const boardId = 'surface';
    await createBoard(boardId);
    await appendEvent(
      boardId,
      makeEvent('board.created', { boardId, planPath: 'p.md', tasks: TASKS, waves: [] }),
    );
    const engine = createEngine({ boardId, effector: createScriptedEffector({}) });
    await engine.load();
    try {
      const BOOT_GATE_SURFACE = new Set(['wasHeldAtLoad', 'resumeAfterGate', 'checkRecovery']);
      for (const name of Object.keys(engine)) {
        if (BOOT_GATE_SURFACE.has(name)) continue;
        assert.doesNotMatch(
          name,
          /resume|wake|recover|repair|reconcile|heal|stall|watchdog|nudge/i,
          `the engine exposes ${name}`,
        );
      }
      assert.equal(typeof engine.load, 'function');
      assert.equal(typeof engine.tick, 'function');
    } finally {
      engine.dispose();
    }
  });

  it('loads no resume, wake, or recovery module anywhere in the engine graph', async () => {
/** @type {Set<string>} */
    const seen = new Set();
/** @param {string} file */
    const walk = async (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      let source;
      try {
        source = await fs.readFile(file, 'utf8');
      } catch {
        return;
      }
      const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) continue;
        await walk(path.resolve(path.dirname(file), specifier));
      }
    };

    await walk(path.join(PROJECT_ROOT, 'server/orchestrator/engine.js'));
    assert.ok(seen.size > 5, `only walked ${seen.size} modules`);

    for (const file of seen) {
      const name = path.basename(file);
      assert.doesNotMatch(
        name,
        /-(resume|wake|recovery)\b|^(boot-resume|display-wake|oom-recovery)/,
        `the engine reaches ${name}`,
      );
    }
    for (const banned of ['board-boot-resume', 'board-display-wake', 'oom-recovery']) {
      assert.equal(
        [...seen].some((f) => f.includes(banned)),
        false,
        `the engine reaches ${banned}`,
      );
    }
  });

  it('reaches nothing under src/', async () => {
    const source = await fs.readFile(path.join(PROJECT_ROOT, 'server/orchestrator/engine.js'), 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(specifier, /(^|\/)src\//, `engine.js imports ${specifier}`);
    }
  });
});
