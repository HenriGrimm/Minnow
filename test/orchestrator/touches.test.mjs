/**
 * P3-D — touches expansion, the scheduling gate, overflow journaling, and
 * the overflow frequency report (MIN-708).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { summarizeTouchesOverflow } from '../../server/orchestrator/core/overflow-report.js';
import {
  expandTouches,
  overflowPaths,
  plan,
} from '../../server/orchestrator/core/plan.js';
import { createScriptedEffector } from '../../server/orchestrator/effector-scripted.js';
import { createEngine, disposeEngines } from '../../server/orchestrator/engine.js';
import {
  appendEvent,
  createBoard,
  readEvents,
  resetJournalCache,
} from '../../server/orchestrator/journal.js';
import {
  attachTouchesExpansion,
  captureWorktreeDiff,
  detectAttemptOverflow,
  listChangedFiles,
  listRepoFiles,
} from '../../server/orchestrator/touches.js';
import { setWorkspaceRoot, getDefaultWorkspaceRoot } from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);

/** @type {string | undefined} */
let previousHome;
/** @type {Array<{ dispose: () => void }>} */
let liveEngines = [];

before(() => {
  previousHome = process.env.MINNOW_HOME;
});

beforeEach(async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-touches-'));
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
  resetJournalCache();
  liveEngines = [];
});

afterEach(async () => {
  for (const engine of liveEngines) engine.dispose();
  liveEngines = [];
  disposeEngines();
  await settle();
});

after(() => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME;
  else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  resetJournalCache();
});

async function settle(rounds = 40) {
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

async function gitInit(dir) {
  await fs.mkdir(dir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: dir, windowsHide: true });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: dir,
    windowsHide: true,
  });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
}

async function gitCommit(dir, message) {
  await execFileAsync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  await execFileAsync('git', ['commit', '-m', message], { cwd: dir, windowsHide: true });
}

// ── pure matching ────────────────────────────────────────────────────────────

describe('expandTouches — pure matching', () => {
  it('expands globs against a frozen file list and records empty globs', () => {
    const files = ['src/a/one.ts', 'src/b/two.ts', 'README.md'];
    const a = expandTouches(['src/a/**'], files);
    assert.deepEqual(a.expanded, ['src/a/one.ts']);
    assert.deepEqual(a.emptyGlobs, []);

    const miss = expandTouches(['does-not-exist/**'], files);
    assert.deepEqual(miss.expanded, []);
    assert.deepEqual(miss.emptyGlobs, ['does-not-exist/**']);
  });

  it('overflowPaths lists only files outside the declared globs', () => {
    assert.deepEqual(overflowPaths(['src/a/**'], ['src/a/one.ts', 'package.json']), [
      'package.json',
    ]);
    assert.deepEqual(overflowPaths(['src/a/**'], ['src/a/one.ts']), []);
  });
});

// ── summarizeTouchesOverflow ─────────────────────────────────────────────────

describe('summarizeTouchesOverflow', () => {
  it('aggregates frequency and hottest files across a multi-task journal', () => {
    const events = [
      makeEvent('touches.overflow', {
        taskId: 'A',
        attemptId: 'a1',
        declared: ['src/a/**'],
        actual: ['package.json', 'src/shared.ts'],
      }),
      makeEvent('touches.overflow', {
        taskId: 'B',
        attemptId: 'b1',
        declared: ['src/b/**'],
        actual: ['package.json'],
      }),
      makeEvent('touches.overflow', {
        taskId: 'A',
        attemptId: 'a2',
        declared: ['src/a/**'],
        actual: ['package.json'],
      }),
      makeEvent('board.started', { concurrency: 2 }),
    ];
    const report = summarizeTouchesOverflow(events);
    assert.equal(report.eventCount, 3);
    assert.deepEqual(report.tasks, [
      { taskId: 'A', count: 2 },
      { taskId: 'B', count: 1 },
    ]);
    assert.deepEqual(report.files, [
      { path: 'package.json', count: 3 },
      { path: 'src/shared.ts', count: 1 },
    ]);
  });
});

// ── journaled expansion vs ───────────────────────────────────────────────────

describe('journaled expansion vs the live filesystem', () => {
  it('a file created after board start does not change what plan() decided', async () => {
    const previousRoot = getDefaultWorkspaceRoot();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-exp-'));
    try {
    await gitInit(repo);
    await fs.mkdir(path.join(repo, 'src', 'a'), { recursive: true });
    await fs.mkdir(path.join(repo, 'src', 'b'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'a', 'one.ts'), 'a\n', 'utf8');
    await fs.writeFile(path.join(repo, 'src', 'b', 'two.ts'), 'b\n', 'utf8');
    await gitCommit(repo, 'init');
    await setWorkspaceRoot(repo);

    const filesAtStart = await listRepoFiles(repo);
    const stamped = attachTouchesExpansion(
      [task('A', { touches: ['src/a/**'] }), task('B', { touches: ['src/b/**'] })],
      filesAtStart,
    );
    assert.deepEqual(stamped[0].touchesExpanded, ['src/a/one.ts']);
    assert.deepEqual(stamped[1].touchesExpanded, ['src/b/two.ts']);

    await fs.writeFile(path.join(repo, 'src', 'a', 'later.ts'), 'later\n', 'utf8');
    const later = await listRepoFiles(repo);
    const reexpanded = attachTouchesExpansion(
      stamped.map((t) => ({ id: t.id, touches: t.touches })),
      later,
    );
    assert.ok(reexpanded[0].touchesExpanded.includes('src/a/later.ts'));
    assert.equal(stamped[0].touchesExpanded.includes('src/a/later.ts'), false);

    const state = derive([
      { ...makeEvent('board.created', { boardId: 'b', planPath: 'p.md', tasks: stamped, waves: [] }), seq: 1, ts: 1 },
      { ...makeEvent('board.started', { concurrency: 2 }), seq: 2, ts: 2 },
    ]);
    assert.deepEqual(
      plan(state)
        .filter((d) => d.role !== 'merge')
        .map((d) => d.taskId),
      ['A', 'B'],
    );
    } finally {
      await setWorkspaceRoot(previousRoot);
    }
  });

  it('a glob matching nothing warns at creation and does not block the run', async () => {
    await createBoard('empty-glob');
    const stamped = attachTouchesExpansion(
      [task('A', { touches: ['no-such-path/**'] })],
      ['README.md'],
    );
    assert.deepEqual(stamped[0].emptyTouchesGlobs, ['no-such-path/**']);
    await appendEvent(
      'empty-glob',
      makeEvent('board.created', {
        boardId: 'empty-glob',
        planPath: 'p.md',
        tasks: stamped,
        waves: [],
      }),
    );
    const effector = createScriptedEffector({});
    const engine = createEngine({ boardId: 'empty-glob', effector, tickMs: 5000 });
    liveEngines.push(engine);
    await engine.load();
    await engine.startBoard(1);
    const deadline = Date.now() + 10_000;
    while (!engine.getState().finished && Date.now() < deadline) {
      await engine.tick();
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const state = engine.getState();
    assert.equal(state.finished, true, `board did not finish; task phase: ${state.tasks.get('A')?.phase}`);
    assert.deepEqual(state.tasks.get('A').emptyTouchesGlobs, ['no-such-path/**']);
    assert.equal(state.tasks.get('A').phase, 'merged');
  });
});

// ── builder overflow journaling ──────────────────────────────────────────────

describe('builder overflow journaling', () => {
  it('writes outside its globs produce one overflow event and the attempt still passes', async () => {
    const previousRoot = getDefaultWorkspaceRoot();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-ovf-'));
    try {
    await gitInit(repo);
    await fs.mkdir(path.join(repo, 'src', 'a'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'a', 'one.ts'), 'a\n', 'utf8');
    await gitCommit(repo, 'base');
    await fs.writeFile(path.join(repo, 'package.json'), '{}\n', 'utf8');
    await gitCommit(repo, 'overflow');
    await setWorkspaceRoot(repo);

    await createBoard('ovf');
    await appendEvent(
      'ovf',
      makeEvent('board.created', {
        boardId: 'ovf',
        planPath: 'p.md',
        tasks: [task('A', { touches: ['src/a/**'], touchesExpanded: ['src/a/one.ts'] })],
        waves: [],
      }),
    );

    const effector = createScriptedEffector({
      script: [{ match: { role: 'builder' }, emit: { outcome: 'pass', worktree: repo } }],
    });
    const engine = createEngine({ boardId: 'ovf', effector, tickMs: 5000 });
    liveEngines.push(engine);
    await engine.load();
    await engine.startBoard(1);
    for (let i = 0; i < 120; i += 1) {
      await settle();
      const events = await readEvents('ovf');
      const overflows = events.filter((e) => e.type === 'touches.overflow');
      if (overflows.length > 0) {
        assert.equal(overflows.length, 1);
        assert.deepEqual(overflows[0].actual, ['package.json']);
        assert.equal(overflows[0].taskId, 'A');
        const ended = events.find(
          (e) => e.type === 'task.attempt.ended' && e.role === 'builder',
        );
        assert.equal(ended?.outcome, 'pass');
        return;
      }
      await engine.tick();
    }
    assert.fail('no touches.overflow event');
    } finally {
      await setWorkspaceRoot(previousRoot);
    }
  });

  it('detectAttemptOverflow matches listChangedFiles against declared globs', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-diff-'));
    await gitInit(repo);
    await fs.writeFile(path.join(repo, 'in.txt'), 'ok\n', 'utf8');
    await gitCommit(repo, 'base');
    await fs.writeFile(path.join(repo, 'out.txt'), 'nope\n', 'utf8');
    await gitCommit(repo, 'extra');
    const changed = await listChangedFiles(repo);
    assert.ok(changed.includes('out.txt'));
    const overflow = await detectAttemptOverflow({
      worktree: repo,
      declared: ['in.txt'],
    });
    assert.deepEqual(overflow?.actual, ['out.txt']);
    const captured = await captureWorktreeDiff(repo);
    assert.ok(captured);
    assert.ok(captured.files.includes('out.txt'));
    assert.match(captured.patch, /out\.txt/);
    assert.equal(captured.truncated, false);
  });
});
