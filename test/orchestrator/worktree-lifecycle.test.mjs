/**
 * P3-A — engine-owned worktree lifecycle (MIN-705).
 *
 * Isolation, reuse-vs-fresh, orphan reclaim, and dirty discard. Git fixtures
 * are a throwaway repo — Minnow product source is not the agent target.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';

import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import {
  allocateAttemptWorktree,
  attemptBranch,
  INTEGRATION_SLOT,
  liveWorktreePaths,
  previousWorktreeForTask,
  reconcileOrphanWorktrees,
  releaseWorktree,
  resetEnsuredBoards,
  setOrphanBulkThresholdForTests,
  slotIdForTask,
  slotIdFromWorktreePath,
  WORKTREE_DISCARDED_TYPE,
  wantsReuse,
} from '../../server/orchestrator/worktree-lifecycle.js';
import { createWorktree, ensureIntegration } from '../../server/worktree/worktree-ops.js';
import { inspectDepDir } from '../../server/worktree/dep-symlinks.js';
import { getBoardWorktreesDir, getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import { wantsSameWorktree } from '../../server/orchestrator/core/policy.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORCH_DIR = path.join(PROJECT_ROOT, 'server', 'orchestrator');

const BOARD_ID = 'p3a-lifecycle';

/**
 * @param {string} wtPath
 * @returns {Promise<boolean>}
 */
async function pathIsGitWorktree(wtPath) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: wtPath,
      windowsHide: true,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * @param {string} id
 */
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

/**
 * @param {string[]} taskIds
 * @param {object[]} [tail]
 */
function boardState(taskIds, tail = []) {
  const events = [
    makeEvent('board.created', {
      boardId: BOARD_ID,
      planPath: 'plan.md',
      tasks: taskIds.map(taskSpec),
      waves: [],
    }),
    makeEvent('board.started', { concurrency: 2 }),
    ...tail,
  ].map((event, i) => ({ ...event, seq: i + 1, ts: i + 1 }));
  return derive(events);
}

/**
 * @param {string} abs
 */
async function exists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

describe('P3-A worktree lifecycle', { concurrency: false }, () => {
  /** @type {string} */
  let repoDir = '';
  /** @type {string} */
  let homeDir = '';
  /** @type {string} */
  let previousHome;

  before(async () => {
    previousHome = process.env.MINNOW_HOME;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-p3a-'));
    repoDir = path.join(root, 'repo');
    homeDir = setTestHome(process.env, 'minnow-test-p3a-lifecycle');
    await fs.mkdir(repoDir, { recursive: true });
    await ensureMinnowLayout();
    await setWorkspaceRoot(repoDir);

    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'README.md'), '# p3a\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });
  });

  after(async () => {
    resetEnsuredBoards();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  test('two concurrent attempts get different worktrees; writes are invisible across them', async () => {
    resetEnsuredBoards();
    const state = boardState(['A', 'B']);
    const a = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'A',
      attemptId: 'r-conc-a',
      desired: { taskId: 'A', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    const b = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'B',
      attemptId: 'r-conc-b',
      desired: { taskId: 'B', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    assert.equal(a.ok, true, a.error);
    assert.equal(b.ok, true, b.error);
    assert.notEqual(path.resolve(a.path), path.resolve(b.path));

    await fs.writeFile(path.join(a.path, 'only-a.txt'), 'secret-a\n', 'utf8');
    await fs.writeFile(path.join(b.path, 'only-b.txt'), 'secret-b\n', 'utf8');
    assert.equal(await exists(path.join(b.path, 'only-a.txt')), false);
    assert.equal(await exists(path.join(a.path, 'only-b.txt')), false);
    assert.equal(await fs.readFile(path.join(a.path, 'only-a.txt'), 'utf8'), 'secret-a\n');
  });

  test('effector start() returns the worktree path after it exists, and journals it', { timeout: 30_000 }, async () => {
    resetEnsuredBoards();
    const boardId = 'p3a-effector-start';
    const journal = createMemoryJournal();
    await journal.createBoard(boardId);
    await journal.appendEvent(boardId, makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: [taskSpec('W1-A')],
      waves: [],
    }));
    await journal.appendEvent(boardId, makeEvent('board.started', { concurrency: 1 }));

    const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
    let seenCwd = '';
    const effector = createRunnerEffector({
      boardId,
      journal,
      getState: () => box.engine.getState(),
      model: { providerId: 'local-fake', id: 'fake-board-model' },
      worktrees: true,
      promptVariant: 'lite',
      runTurn: async (opts) => {
        seenCwd = opts.cwd;
        await fs.writeFile(path.join(opts.cwd, 'from-turn.txt'), 'ok\n', 'utf8');
        return { outcome: 'pass', summary: 'built', evidence: ['from-turn.txt'] };
      },
    });
    const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
    box.engine = engine;
    await engine.load();
    try {
      await engine.startBoard(1);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !engine.getState().finished) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const events = await journal.readEvents(boardId);
      const started = events.filter((event) => event.type === 'task.attempt.started');
      assert.ok(started.length >= 1);
      assert.equal(typeof started[0].worktree, 'string');
      assert.ok(started[0].worktree.length > 0);
      assert.equal(path.resolve(seenCwd), path.resolve(started[0].worktree));
      const builderWt = started.find((event) => event.role === 'builder')?.worktree;
      const testerWt = started.find((event) => event.role === 'tester')?.worktree;
      if (testerWt) assert.equal(path.resolve(testerWt), path.resolve(builderWt));
    } finally {
      engine.dispose();
    }
  });

  test('blocked, continue, and rebase reuse the same path; failure-aware is a fresh checkout', async () => {
    resetEnsuredBoards();
    const state = boardState(['C']);
    const first = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-1',
      desired: { taskId: 'C', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    assert.equal(first.ok, true, first.error);
    await fs.writeFile(path.join(first.path, 'in-progress.txt'), 'held\n', 'utf8');

    const task = state.tasks.get('C');
    task.attempts.push({
      attemptId: 'r-reuse-1',
      role: 'builder',
      worktree: first.path,
      seedKind: 'initial',
      ended: true,
      outcome: 'blocked',
      summary: null,
      evidence: null,
      manual: false,
    });

    assert.equal(wantsReuse({ taskId: 'C', role: 'builder', seedKind: 'repair', sameWorktree: true }), true);
    const repair = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-repair',
      desired: { taskId: 'C', role: 'builder', seedKind: 'repair', sameWorktree: true },
      state,
    });
    assert.equal(repair.ok, true, repair.error);
    assert.equal(path.resolve(repair.path), path.resolve(first.path));
    assert.equal(await fs.readFile(path.join(repair.path, 'in-progress.txt'), 'utf8'), 'held\n');

    task.attempts[0].outcome = 'crashed';
    const cont = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-continue',
      desired: { taskId: 'C', role: 'builder', seedKind: 'continue', sameWorktree: true },
      state,
    });
    assert.equal(cont.ok, true, cont.error);
    assert.equal(path.resolve(cont.path), path.resolve(first.path));

    assert.equal(wantsReuse({ taskId: 'C', role: 'builder', seedKind: 'rebase', sameWorktree: true }), true);
    const rebase = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-rebase',
      desired: { taskId: 'C', role: 'builder', seedKind: 'rebase', sameWorktree: true },
      state,
    });
    assert.equal(rebase.ok, true, rebase.error);
    assert.equal(path.resolve(rebase.path), path.resolve(first.path));
    assert.equal(await fs.readFile(path.join(rebase.path, 'in-progress.txt'), 'utf8'), 'held\n');

    const fix = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-fix',
      desired: { taskId: 'C', role: 'builder', seedKind: 'fix', sameWorktree: true },
      state,
    });
    assert.equal(fix.ok, true, fix.error);
    assert.equal(await fs.readFile(path.join(fix.path, 'in-progress.txt'), 'utf8'), 'held\n');

    const fresh = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'C',
      attemptId: 'r-reuse-fresh',
      desired: { taskId: 'C', role: 'builder', seedKind: 'failure-aware', sameWorktree: false },
      state,
    });
    assert.equal(fresh.ok, true, fresh.error);
    // Task-keyed slots keep the same path; the tree is a new checkout off integration.
    assert.equal(path.resolve(fresh.path), path.resolve(first.path));
    assert.equal(await exists(path.join(fresh.path, 'in-progress.txt')), false);
    assert.equal(
      (await fs.readFile(path.join(fresh.path, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'),
      '# p3a\n',
    );
  });

  test('new attempt slots use board name, wave, and task id', async () => {
    resetEnsuredBoards();
    const events = [
      makeEvent('board.created', {
        boardId: BOARD_ID,
        name: 'Auth Rewrite',
        planPath: 'plan.md',
        tasks: [{ ...taskSpec('W1-A'), wave: 1 }],
        waves: [],
      }),
      makeEvent('board.started', { concurrency: 1 }),
    ].map((event, i) => ({ ...event, seq: i + 1, ts: i + 1 }));
    const state = derive(events);
    const expectedSlot = 'Auth-Rewrite-wave1-W1-A';
    assert.equal(slotIdForTask(state, 'W1-A'), expectedSlot);

    const allocated = await allocateAttemptWorktree({
      boardId: BOARD_ID,
      taskId: 'W1-A',
      attemptId: 'r-named-slot',
      desired: { taskId: 'W1-A', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    assert.equal(allocated.ok, true, allocated.error);
    assert.equal(allocated.slotId, expectedSlot);
    assert.equal(slotIdFromWorktreePath(BOARD_ID, allocated.path), expectedSlot);
    assert.equal(attemptBranch(BOARD_ID, expectedSlot), `minnow/board/${BOARD_ID}/${expectedSlot}`);
    assert.equal(path.basename(path.resolve(allocated.path)), expectedSlot);
  });

  test('restart with two live attempts keeps both worktrees', async () => {
    resetEnsuredBoards();
    const boardId = 'p3a-live-pair';
    await ensureIntegration({ boardId, branch: `minnow/board/${boardId}/integration` });
    const wtA = await createWorktree({
      boardId,
      slotId: 'live-a',
      branch: `minnow/board/${boardId}/live-a`,
      baseRef: `minnow/board/${boardId}/integration`,
    });
    const wtB = await createWorktree({
      boardId,
      slotId: 'live-b',
      branch: `minnow/board/${boardId}/live-b`,
      baseRef: `minnow/board/${boardId}/integration`,
    });
    assert.equal(wtA.ok, true, wtA.output || wtA.error);
    assert.equal(wtB.ok, true, wtB.output || wtB.error);

    const journal = createMemoryJournal();
    await journal.createBoard(boardId);
    await journal.appendEvent(boardId, makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: [taskSpec('A'), taskSpec('B')],
      waves: [],
    }));
    await journal.appendEvent(boardId, makeEvent('board.started', { concurrency: 2 }));
    await journal.appendEvent(boardId, makeEvent('task.attempt.started', {
      taskId: 'A', attemptId: 'live-a', role: 'builder', worktree: wtA.path, seedKind: 'initial',
    }));
    await journal.appendEvent(boardId, makeEvent('task.attempt.started', {
      taskId: 'B', attemptId: 'live-b', role: 'builder', worktree: wtB.path, seedKind: 'initial',
    }));

    const engine = createEngine({
      boardId,
      journal,
      tickMs: 100_000,
      effector: {
        inspect: () => [
          { taskId: 'A', role: 'builder', attemptId: 'live-a' },
          { taskId: 'B', role: 'builder', attemptId: 'live-b' },
        ],
        start: async () => ({ attemptId: 'unused' }),
        stop: async () => {},
        onEnd: () => {},
      },
    });
    await engine.load();
    try {
      assert.equal(await exists(wtA.path), true, 'live A was reclaimed');
      assert.equal(await exists(wtB.path), true, 'live B was reclaimed');
      const live = liveWorktreePaths(engine.getState());
      assert.equal(live.size, 2);
    } finally {
      engine.dispose();
    }
  });

  test('restart after a crash that left three orphans removes exactly those', async () => {
    resetEnsuredBoards();
    const boardId = 'p3a-orphans';
    await ensureIntegration({ boardId, branch: `minnow/board/${boardId}/integration` });
    const live = await createWorktree({
      boardId,
      slotId: 'keep-live',
      branch: `minnow/board/${boardId}/keep-live`,
      baseRef: `minnow/board/${boardId}/integration`,
    });
    assert.equal(live.ok, true, live.output || live.error);
    const orphanSlots = ['orphan-1', 'orphan-2', 'orphan-3'];
    const orphanPaths = [];
    for (const slot of orphanSlots) {
      const created = await createWorktree({
        boardId,
        slotId: slot,
        branch: `minnow/board/${boardId}/${slot}`,
        baseRef: `minnow/board/${boardId}/integration`,
      });
      assert.equal(created.ok, true, created.output || created.error);
      orphanPaths.push(created.path);
    }

    const journal = createMemoryJournal();
    await journal.createBoard(boardId);
    await journal.appendEvent(boardId, makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: [taskSpec('A')],
      waves: [],
    }));
    await journal.appendEvent(boardId, makeEvent('board.started', { concurrency: 1 }));
    await journal.appendEvent(boardId, makeEvent('task.attempt.started', {
      taskId: 'A', attemptId: 'keep-live', role: 'builder', worktree: live.path, seedKind: 'initial',
    }));

    const engine = createEngine({
      boardId,
      journal,
      tickMs: 100_000,
      effector: {
        inspect: () => [{ taskId: 'A', role: 'builder', attemptId: 'keep-live' }],
        start: async () => ({ attemptId: 'unused' }),
        stop: async () => {},
        onEnd: () => {},
      },
    });
    await engine.load();
    try {
      assert.equal(await exists(live.path), true, 'journal-live worktree was removed');
      for (const orphan of orphanPaths) {
        assert.equal(await exists(orphan), false, `orphan survived: ${orphan}`);
      }
      const integration = getWorktreeSlotPath(boardId, INTEGRATION_SLOT);
      assert.equal(await exists(integration), true, 'integration was reclaimed');
    } finally {
      engine.dispose();
    }
  });

  test('dirty worktree removal journals the discarded state', async () => {
    resetEnsuredBoards();
    const boardId = 'p3a-dirty';
    await ensureIntegration({ boardId, branch: `minnow/board/${boardId}/integration` });
    const created = await createWorktree({
      boardId,
      slotId: 'dirty-slot',
      branch: `minnow/board/${boardId}/dirty-slot`,
      baseRef: `minnow/board/${boardId}/integration`,
    });
    assert.equal(created.ok, true, created.output || created.error);
    await fs.writeFile(path.join(created.path, 'uncommitted.txt'), 'do not drop\n', 'utf8');

    const journal = createMemoryJournal();
    await journal.createBoard(boardId);
    await journal.appendEvent(boardId, makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: [taskSpec('A')],
      waves: [],
    }));
    await journal.appendEvent(boardId, makeEvent('board.started', { concurrency: 1 }));

    const engine = createEngine({
      boardId,
      journal,
      tickMs: 100_000,
      effector: {
        inspect: () => [],
        start: async () => ({ attemptId: 'unused' }),
        stop: async () => {},
        onEnd: () => {},
      },
    });
    await engine.load();
    try {
      assert.equal(await exists(created.path), false);
      const events = await journal.readEvents(boardId);
      const discarded = events.filter((event) => event.type === WORKTREE_DISCARDED_TYPE);
      assert.equal(discarded.length, 1);
      assert.equal(discarded[0].slotId, 'dirty-slot');
      assert.ok(
        Array.isArray(discarded[0].files) && discarded[0].files.some((line) => String(line).includes('uncommitted.txt')),
        `expected uncommitted.txt in ${JSON.stringify(discarded[0].files)}`,
      );
    } finally {
      engine.dispose();
    }
  });

  test('releaseWorktree returns discarded files instead of dropping them', async () => {
    resetEnsuredBoards();
    const boardId = 'p3a-release';
    await ensureIntegration({ boardId, branch: `minnow/board/${boardId}/integration` });
    const created = await createWorktree({
      boardId,
      slotId: 'rel-slot',
      branch: `minnow/board/${boardId}/rel-slot`,
      baseRef: `minnow/board/${boardId}/integration`,
    });
    assert.equal(created.ok, true, created.output || created.error);
    await fs.writeFile(path.join(created.path, 'kept-in-journal.txt'), 'x\n', 'utf8');
    const released = await releaseWorktree({
      boardId,
      slotId: 'rel-slot',
      taskId: 'A',
      attemptId: 'r-rel',
      worktree: created.path,
    });
    assert.equal(released.ok, true);
    assert.ok(released.discarded);
    assert.ok(released.discarded.files.some((line) => String(line).includes('kept-in-journal.txt')));
  });

  test('previousWorktreeForTask reads the journal fold, not a side map', () => {
    const state = boardState(
      ['A'],
      [
        makeEvent('task.attempt.started', {
          taskId: 'A',
          attemptId: 'a1',
          role: 'builder',
          worktree: '/tmp/wt-a1',
        }),
        makeEvent('task.attempt.ended', {
          taskId: 'A',
          attemptId: 'a1',
          role: 'builder',
          outcome: 'blocked',
        }),
      ],
    );
    assert.equal(previousWorktreeForTask(state, 'A'), '/tmp/wt-a1');
    assert.equal(liveWorktreePaths(state).size, 0);
  });

  test('a git commit failure reports a retryable crash and retains the implementation', async () => {
    const state = boardState(['CommitFail']);
    let lockPath;
    let worktree;
    let resolveEnd;
    const ended = new Promise((resolve) => { resolveEnd = resolve; });
    const effector = createRunnerEffector({
      boardId: BOARD_ID, getState: () => state,
      model: { providerId: 'fixture', id: 'fixture' },
      runTurn: async ({ cwd }) => {
        worktree = cwd;
        await fs.writeFile(path.join(cwd, 'implementation.txt'), 'keep this work\n');
        const { stdout } = await execFileAsync('git', ['rev-parse', '--git-path', 'index.lock'], { cwd, windowsHide: true });
        lockPath = path.resolve(cwd, stdout.trim());
        await fs.writeFile(lockPath, 'fixture lock');
        return { outcome: 'pass', summary: 'implemented', evidence: [] };
      },
    });
    effector.onEnd(resolveEnd);
    try {
      await effector.start({ taskId: 'CommitFail', role: 'builder', seedKind: 'initial', sameWorktree: false });
      const end = await ended;
      assert.equal(end.outcome, 'crashed');
      assert.match(end.summary, /Could not commit task changes/);
      assert.equal(await fs.readFile(path.join(worktree, 'implementation.txt'), 'utf8'), 'keep this work\n');
    } finally {
      if (lockPath) await fs.rm(lockPath, { force: true });
    }
  });

  test('second allocate still starts when the cached integration node_modules is broken', async () => {
    const boardId = 'p3a-dep-stall';
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';

    await fs.writeFile(path.join(repoDir, 'package.json'), '{"name":"p3a-dep-stall"}\n', 'utf8');
    await fs.mkdir(path.join(repoDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'node_modules', 'pkg.txt'), 'installed\n', 'utf8');
    await execFileAsync('git', ['add', 'package.json'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'add package.json'], {
      cwd: repoDir,
      windowsHide: true,
    });

    resetEnsuredBoards();
    const state = boardState(['DepA', 'DepB']);
    const first = await allocateAttemptWorktree({
      boardId,
      taskId: 'DepA',
      attemptId: 'r-dep-a',
      desired: { taskId: 'DepA', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    assert.equal(first.ok, true, first.error);

    const intNm = path.join(getWorktreeSlotPath(boardId, INTEGRATION_SLOT), 'node_modules');
    const cycle = `${intNm}.cycle`;
    await fs.rm(intNm, { force: true });
    await fs.rm(cycle, { recursive: true, force: true });
    await fs.mkdir(cycle);
    await fs.symlink(cycle, intNm, linkType);
    await fs.rm(cycle, { recursive: true, force: true });
    await fs.symlink(intNm, cycle, linkType);
    assert.equal(await inspectDepDir(intNm), 'broken');

    const second = await allocateAttemptWorktree({
      boardId,
      taskId: 'DepB',
      attemptId: 'r-dep-b',
      desired: { taskId: 'DepB', role: 'builder', seedKind: 'initial', sameWorktree: false },
      state,
    });
    assert.equal(second.ok, true, second.error);
    const wtNm = path.join(second.path, 'node_modules');
    assert.equal(await inspectDepDir(wtNm), 'link-ok');
    assert.equal(await fs.readFile(path.join(wtNm, 'pkg.txt'), 'utf8'), 'installed\n');
  });

  test('a husk slot dir with no .git is reclaimed, not reused as a worktree', async () => {
    const boardId = 'p3a-husk';
    resetEnsuredBoards();
    const state = boardState(['HuskA']);
    const desired = {
      taskId: 'HuskA',
      role: 'builder',
      seedKind: 'initial',
      sameWorktree: false,
    };

    const first = await allocateAttemptWorktree({
      boardId,
      taskId: 'HuskA',
      attemptId: 'r-husk-1',
      desired,
      state,
    });
    assert.equal(first.ok, true, first.error);

    // Reproduce a release whose `fs.rm` failed: `git worktree remove` + `prune`
    // already dropped `.git` and the registration, but the dir survived.
    await execFileAsync('git', ['worktree', 'remove', '--force', first.path], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['worktree', 'prune', '--expire', 'now'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.mkdir(first.path, { recursive: true });
    await fs.writeFile(path.join(first.path, 'leftover.txt'), 'stale\n', 'utf8');
    assert.equal(await pathIsGitWorktree(first.path), false);

    const second = await allocateAttemptWorktree({
      boardId,
      taskId: 'HuskA',
      attemptId: 'r-husk-2',
      desired,
      state,
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.path, first.path);
    // Reused-as-is would leave no .git and fail every later git call with
    // "fatal: not a git repository", bricking the slot on every retry.
    assert.equal(await pathIsGitWorktree(second.path), true);
  });

  test('slotIdFromWorktreePath round-trips through getWorktreeSlotPath', () => {
    const slot = 'r-slot-roundtrip';
    const wt = getWorktreeSlotPath(BOARD_ID, slot);
    assert.equal(slotIdFromWorktreePath(BOARD_ID, wt), slot);
  });

  test('slotIdForTask uses board id when the board has no display name', () => {
    const state = boardState(['T1']);
    assert.equal(slotIdForTask(state, 'T1'), 'p3a-lifecycle-wave1-T1');
    assert.equal(slotIdForTask(state, 'gone'), 'p3a-lifecycle-wave1-gone');
  });

  test('wantsSameWorktree is the reuse mapping, not an effector slot map', () => {
    assert.equal(wantsSameWorktree('repair'), true);
    assert.equal(wantsSameWorktree('continue'), true);
    assert.equal(wantsSameWorktree('rebase'), true);
    assert.equal(wantsSameWorktree('failure-aware'), false);
    assert.equal(wantsSameWorktree('fix'), true);
  });

  test('no persisted worktree ownership registry exists outside the journal', async () => {
    const banned = [
      /writeFile\([^)]*(?:worktree[-_]?(?:registry|ownership|index)|allocation[-_]?map)/i,
      /\b(?:worktreeRegistry|worktreeOwnership|allocationMap)\s*=/,
    ];
    /** @type {string[]} */
    const hits = [];

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(js|d\.ts|mjs)$/.test(entry.name)) continue;
        const src = await fs.readFile(full, 'utf8');
        for (const re of banned) {
          if (re.test(src)) hits.push(`${path.relative(ORCH_DIR, full)} matches ${re}`);
        }
      }
    }

    await walk(ORCH_DIR);
    assert.deepEqual(hits, []);
    assert.equal(await exists(path.join(getBoardWorktreesDir(BOARD_ID), 'ownership.json')), false);
    assert.equal(await exists(path.join(getBoardWorktreesDir(BOARD_ID), 'registry.json')), false);
  });

  test('reconcileOrphanWorktrees is a no-op when the board dir does not exist', async () => {
    const result = await reconcileOrphanWorktrees({
      boardId: 'p3a-missing-board-zzzz',
      livePaths: new Set(),
    });
    assert.deepEqual(result, { removed: [], discarded: [] });
  });

  test('bulk orphan reclaim skips dirty capture and still removes the slot', async () => {
    resetEnsuredBoards();
    setOrphanBulkThresholdForTests(1);
    const boardId = 'p3a-bulk-orphans';
    try {
      await ensureIntegration({ boardId, branch: `minnow/board/${boardId}/integration` });
      const created = await createWorktree({
        boardId,
        slotId: 'bulk-dirty',
        branch: `minnow/board/${boardId}/bulk-dirty`,
        baseRef: `minnow/board/${boardId}/integration`,
      });
      assert.equal(created.ok, true, created.output || created.error);
      await fs.writeFile(path.join(created.path, 'uncommitted.txt'), 'bulk skip\n', 'utf8');

      const result = await reconcileOrphanWorktrees({
        boardId,
        livePaths: new Set(),
      });
      assert.equal(await exists(created.path), false);
      assert.ok(result.removed.some((p) => p === created.path || p.endsWith('bulk-dirty')));
      assert.equal(result.discarded.length, 0);
    } finally {
      setOrphanBulkThresholdForTests(null);
    }
  });
});
