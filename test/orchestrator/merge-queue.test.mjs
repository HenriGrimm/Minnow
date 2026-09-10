/**
 * P3-C — serialized merge queue (MIN-707).
 *
 * Real git fixtures (throwaway repos, not Minnow product source). The queue
 * is mechanical: rebase, merge, journal via AttemptEnd. No model, no fixer.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, afterEach, before, describe, test } from 'node:test';

import { setTestHome, rmTestHome } from '../config/test-helpers.js';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { derive } from '../../server/orchestrator/core/derive.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { plan } from '../../server/orchestrator/core/plan.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { recoverHalfAppliedMerge, runMerge } from '../../server/orchestrator/merge-queue.js';
import { createMemoryJournal } from '../../server/orchestrator/testing/memory-journal.js';
import {
  attemptBranch,
  previousWorktreeForTask,
  resetEnsuredBoards,
  slotIdFromWorktreePath,
} from '../../server/orchestrator/worktree-lifecycle.js';
import {
  createWorktree,
  ensureIntegration,
  mergeIntoIntegration,
  readIntegrationRef,
  resetBoardIntegrationLock,
} from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MERGE_QUEUE_JS = path.join(PROJECT_ROOT, 'server', 'orchestrator', 'merge-queue.js');

/**
 * @param {string} id
 * @param {object} [extra]
 */
function taskSpec(id, extra = {}) {
  return {
    id,
    title: id,
    wave: 1,
    dependsOn: [],
    touches: [`src/${id}/**`],
    build: 'build',
    test: 'test',
    accept: 'ok',
    ...extra,
  };
}

/**
 * Fold a journal that already has builder+tester pass and a live worktree,
 * with `merge.enqueued` so the engine would desire a merge.
 *
 * @param {string} boardId
 * @param {Array<{ id: string, worktree: string, enqueued?: boolean }>} tasks
 * @param {object[]} [tail]
 */
function stateFor(boardId, tasks, tail = []) {
  /** @type {Record<string, unknown>[]} */
  const events = [
    makeEvent('board.created', {
      boardId,
      planPath: 'plan.md',
      tasks: tasks.map((t) => taskSpec(t.id)),
      waves: [],
    }),
    makeEvent('board.started', { concurrency: 2 }),
  ];
  for (const t of tasks) {
    const builderId = `b-${t.id}`;
    const testerId = `t-${t.id}`;
    events.push(
      makeEvent('task.attempt.started', {
        taskId: t.id,
        attemptId: builderId,
        role: 'builder',
        worktree: t.worktree,
      }),
      makeEvent('task.attempt.ended', {
        taskId: t.id,
        attemptId: builderId,
        role: 'builder',
        outcome: 'pass',
      }),
      makeEvent('task.attempt.started', {
        taskId: t.id,
        attemptId: testerId,
        role: 'tester',
        worktree: t.worktree,
      }),
      makeEvent('task.attempt.ended', {
        taskId: t.id,
        attemptId: testerId,
        role: 'tester',
        outcome: 'pass',
      }),
    );
    if (t.enqueued !== false) {
      events.push(makeEvent('merge.enqueued', { taskId: t.id }));
    }
  }
  events.push(...tail);
  return derive(events.map((event, i) => ({ ...event, seq: i + 1, ts: i + 1 })));
}

/** @param {string} cwd */
async function git(args, cwd) {
  return execFileAsync('git', args, { cwd, windowsHide: true });
}

/** @param {string} cwd */
async function headSha(cwd) {
  const { stdout } = await git(['rev-parse', 'HEAD'], cwd);
  return stdout.trim();
}

/** @param {string} cwd */
async function porcelain(cwd) {
  const { stdout } = await git(['status', '--porcelain'], cwd);
  return stdout;
}

/** @param {string} cwd @param {string} ref */
async function revParse(cwd, ref) {
  try {
    const { stdout } = await git(['rev-parse', '--verify', ref], cwd);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Throwaway git repo + board integration worktree.
 * @param {string} suffix
 */
async function makeRepo(suffix) {
  resetBoardIntegrationLock();
  resetEnsuredBoards();
  const boardId = `p3c-${suffix}`;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `minnow-p3c-${suffix}-`));
  const repoDir = path.join(root, 'repo');
  const minnowHome = path.join(root, 'minnow-home');
  await fsp.mkdir(repoDir, { recursive: true });
  await fsp.mkdir(minnowHome, { recursive: true });
  process.env.MINNOW_HOME = minnowHome;
  resetMinnowHomeCache();
  await setWorkspaceRoot(repoDir);

  await git(['init'], repoDir);
  await git(['config', 'user.email', 'test@example.com'], repoDir);
  await git(['config', 'user.name', 'Test'], repoDir);
  await fsp.writeFile(path.join(repoDir, 'README.md'), '# p3c\n', 'utf8');
  await fsp.writeFile(path.join(repoDir, 'shared.txt'), 'base\n', 'utf8');
  await git(['add', '.'], repoDir);
  await git(['commit', '-m', 'init'], repoDir);

  const integrationBranch = attemptBranch(boardId, 'integration');
  const ensured = await ensureIntegration({ boardId, branch: integrationBranch });
  assert.equal(ensured.ok, true, ensured.output || ensured.error);

  return { boardId, repoDir, minnowHome, integrationBranch, root };
}

/**
 * @param {{ boardId: string, integrationBranch: string }} h
 * @param {string} slotId
 * @param {Record<string, string>} files
 */
async function addSlot(h, slotId, files) {
  const branch = attemptBranch(h.boardId, slotId);
  const created = await createWorktree({
    boardId: h.boardId,
    slotId,
    branch,
    baseRef: h.integrationBranch,
  });
  assert.equal(created.ok, true, created.output || created.error);
  const wt = getWorktreeSlotPath(h.boardId, slotId);
  for (const [name, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(wt, name), content, 'utf8');
  }
  await git(['add', '-A'], wt);
  await git(['commit', '-m', `commit ${slotId}`], wt);
  return { branch, wt, slotId };
}

/**
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {string} label
 */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

/** @param {string} seed */
function taskIdFromSeed(seed) {
  const match = String(seed || '').match(/^# Task (\S+)/m);
  return match ? match[1] : '';
}

// ── P3-C merge-queue ─────────────────────────────────────────────────────────

describe('P3-C merge-queue source contract', () => {
  test('imports reach neither a model, a generation, nor a runner', () => {
    const source = fs.readFileSync(MERGE_QUEUE_JS, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(specs.length > 0, 'expected at least one import');
    for (const spec of specs) {
      assert.equal(
        /runner|generations|model-binding|prompts|providers|effector-runner|fake-model|final-test/i.test(spec),
        false,
        `forbidden import: ${spec}`,
      );
    }
    assert.equal(/\brunTurn\b/.test(code), false, 'runTurn mention');
    assert.equal(/\bpostChatCompletions/.test(code), false, 'generation binding');
  });
});

// ── P3-C merge-queue ─────────────────────────────────────────────────────────

describe('P3-C merge-queue (real git)', { concurrency: false }, () => {
  /** @type {string | undefined} */
  let previousHome;

  before(() => {
    previousHome = process.env.MINNOW_HOME;
  });

  afterEach(() => {
    resetBoardIntegrationLock();
    resetEnsuredBoards();
  });

  after(() => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    resetBoardIntegrationLock();
    resetEnsuredBoards();
  });

  test('three sequential merges produce three distinct shas and the final tree', async () => {
    const h = await makeRepo('seq3');
    const a = await addSlot(h, 'slot-a', { 'file-a.txt': 'from A\n' });
    const b = await addSlot(h, 'slot-b', { 'file-b.txt': 'from B\n' });
    const c = await addSlot(h, 'slot-c', { 'file-c.txt': 'from C\n' });
    const intPath = getWorktreeSlotPath(h.boardId, 'integration');

    const state = stateFor(h.boardId, [
      { id: 'A', worktree: a.wt },
      { id: 'B', worktree: b.wt },
      { id: 'C', worktree: c.wt },
    ]);

    const endA = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a',
      state,
    });
    const endB = await runMerge({
      boardId: h.boardId,
      taskId: 'B',
      attemptId: 'm-b',
      state,
    });
    const endC = await runMerge({
      boardId: h.boardId,
      taskId: 'C',
      attemptId: 'm-c',
      state,
    });

    assert.equal(endA.outcome, 'pass', endA.summary);
    assert.equal(endB.outcome, 'pass', endB.summary);
    assert.equal(endC.outcome, 'pass', endC.summary);
    const shas = [endA.sha, endB.sha, endC.sha];
    assert.equal(new Set(shas).size, 3, `shas were ${shas.join(', ')}`);
    assert.ok(endA.beforeSha);
    assert.notEqual(endA.sha, endA.beforeSha);
    assert.equal(await headSha(intPath), endC.sha);

    assert.equal((await fsp.readFile(path.join(intPath, 'file-a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'from A\n');
    assert.equal((await fsp.readFile(path.join(intPath, 'file-b.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'from B\n');
    assert.equal((await fsp.readFile(path.join(intPath, 'file-c.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'from C\n');
    assert.equal((await porcelain(intPath)).trim(), '');
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
  });

  test('induced rebase conflict returns merge.conflicted with the file list', async () => {
    const h = await makeRepo('conflict');
    const a = await addSlot(h, 'slot-a', { 'shared.txt': 'version A\n' });
    const b = await addSlot(h, 'slot-b', { 'shared.txt': 'version B\n' });
    const state = stateFor(h.boardId, [
      { id: 'A', worktree: a.wt },
      { id: 'B', worktree: b.wt },
    ]);

    const first = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a',
      state,
    });
    assert.equal(first.outcome, 'pass', first.summary);

    const conflicted = await runMerge({
      boardId: h.boardId,
      taskId: 'B',
      attemptId: 'm-b',
      state,
    });
    assert.equal(conflicted.outcome, 'conflicted');
    assert.ok(conflicted.files.includes('shared.txt'), `files were ${conflicted.files}`);
    assert.ok(conflicted.beforeSha);

    const intPath = getWorktreeSlotPath(h.boardId, 'integration');
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
    assert.equal((await porcelain(intPath)).trim(), '');
    assert.equal(await headSha(intPath), first.sha);
  });

  test('a merge that fails verification rolls back to beforeSha and leaves integration clean', async () => {
    const h = await makeRepo('verify');
    const a = await addSlot(h, 'slot-a', { 'file-a.txt': 'from A\n' });
    const state = stateFor(h.boardId, [{ id: 'A', worktree: a.wt }]);
    const intPath = getWorktreeSlotPath(h.boardId, 'integration');
    const before = await headSha(intPath);

    const end = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a',
      state,
      ops: {
        verifyIntegrationMerge: async () => ({
          ok: true,
          verified: false,
          reasons: ['injected verification failure'],
        }),
      },
    });

    // A verification failure with no conflict markers is operational, not a
    // conflict: no file collided, so there is nothing for a rebase to resolve.
    assert.equal(end.outcome, 'merge_failed');
    assert.equal(end.reason, 'verify-failed');
    assert.equal(end.summary, 'injected verification failure');
    assert.deepEqual(end.files, []);
    assert.equal(end.beforeSha, before);
    assert.equal(await headSha(intPath), before);
    assert.equal((await porcelain(intPath)).trim(), '');
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
    try {
      await fsp.access(path.join(intPath, 'file-a.txt'));
      assert.fail('file-a.txt remained on integration after verify rollback');
    } catch {
    }
  });

  test('verification that finds conflict markers is a conflict, and names the files', async () => {
    const h = await makeRepo('verify-markers');
    const a = await addSlot(h, 'slot-a', { 'file-a.txt': 'from A\n' });
    const state = stateFor(h.boardId, [{ id: 'A', worktree: a.wt }]);
    const intPath = getWorktreeSlotPath(h.boardId, 'integration');
    const before = await headSha(intPath);

    const end = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a',
      state,
      ops: {
        verifyIntegrationMerge: async () => ({
          ok: true,
          verified: false,
          reasons: ['conflict markers remain in: file-a.txt'],
        }),
      },
    });

    assert.equal(end.outcome, 'conflicted');
    assert.deepEqual(end.files, ['file-a.txt']);
    assert.equal(end.beforeSha, before);
    assert.equal(await headSha(intPath), before);
    assert.equal((await porcelain(intPath)).trim(), '');
  });

  test('an operational fault is merge_failed, never a conflict', async () => {
    const h = await makeRepo('operational');
    // No worktree recorded for the task: nothing collided, so a rebase retry
    // would only burn an attempt reproducing the same fault.
    const state = stateFor(h.boardId, [{ id: 'A', worktree: null }]);

    const end = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a',
      state,
    });

    assert.equal(end.outcome, 'merge_failed');
    assert.equal(end.reason, 'worktree-missing');
    assert.deepEqual(end.files, []);
  });

  test('restart mid-merge: MERGE_HEAD is aborted; journal and git agree (never half)', async () => {
    const h = await makeRepo('restart');
    const a = await addSlot(h, 'slot-a', { 'shared.txt': 'version A\n' });
    const b = await addSlot(h, 'slot-b', { 'shared.txt': 'version B\n' });
    const intPath = getWorktreeSlotPath(h.boardId, 'integration');

    const mergedA = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: a.branch,
      message: 'merge A',
    });
    assert.equal(mergedA.ok, true, mergedA.output);

    const half = await mergeIntoIntegration({
      boardId: h.boardId,
      fromBranch: b.branch,
      message: 'merge B',
    });
    assert.equal(half.ok, false);
    assert.equal(half.conflict, true);
    assert.ok(await revParse(intPath, 'MERGE_HEAD'));

    const recovered = await recoverHalfAppliedMerge({ boardId: h.boardId });
    assert.equal(recovered.recovered, true);
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
    assert.equal((await porcelain(intPath)).trim(), '');

    const state = stateFor(h.boardId, [
      { id: 'A', worktree: a.wt },
      { id: 'B', worktree: b.wt },
    ]);
    const end = await runMerge({
      boardId: h.boardId,
      taskId: 'B',
      attemptId: 'm-b',
      state,
    });
    assert.equal(end.outcome, 'conflicted');
    assert.ok(end.files.includes('shared.txt'));
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
    assert.equal((await porcelain(intPath)).trim(), '');
  });

  test('already-merged git with no journal still completes rather than leaving half', async () => {
    const h = await makeRepo('already');
    const a = await addSlot(h, 'slot-a', { 'file-a.txt': 'from A\n' });
    const state = stateFor(h.boardId, [{ id: 'A', worktree: a.wt }]);

    const first = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a1',
      state,
    });
    assert.equal(first.outcome, 'pass', first.summary);

    const second = await runMerge({
      boardId: h.boardId,
      taskId: 'A',
      attemptId: 'm-a2',
      state,
    });
    assert.equal(second.outcome, 'pass', second.summary);
    assert.equal(second.sha, first.sha);
    const intPath = getWorktreeSlotPath(h.boardId, 'integration');
    assert.equal(await revParse(intPath, 'MERGE_HEAD'), null);
    assert.equal((await fsp.readFile(path.join(intPath, 'file-a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'from A\n');
  });

  test('slot lookup uses the last builder/tester worktree from the journal', async () => {
    const h = await makeRepo('slot');
    const a = await addSlot(h, 'slot-a', { 'file-a.txt': 'from A\n' });
    const state = stateFor(h.boardId, [{ id: 'A', worktree: a.wt }]);
    assert.equal(previousWorktreeForTask(state, 'A'), a.wt);
    assert.equal(slotIdFromWorktreePath(h.boardId, a.wt), 'slot-a');
    assert.equal(attemptBranch(h.boardId, slotIdFromWorktreePath(h.boardId, a.wt)), a.branch);
  });
});

// ── P3-C engine + ────────────────────────────────────────────────────────────

describe('P3-C engine + merge queue', { concurrency: false }, () => {
  /** @type {string} */
  let homeDir = '';
  /** @type {string | undefined} */
  let previousHome;
  /** @type {string} */
  let repoDir = '';

  before(async () => {
    previousHome = process.env.MINNOW_HOME;
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minnow-p3c-engine-'));
    repoDir = path.join(root, 'repo');
    homeDir = setTestHome(process.env, 'minnow-test-p3c-engine');
    await fsp.mkdir(repoDir, { recursive: true });
    await ensureMinnowLayout();
    await setWorkspaceRoot(repoDir);
    await git(['init'], repoDir);
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test'], repoDir);
    await fsp.writeFile(path.join(repoDir, 'README.md'), '# p3c-engine\n', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'shared.txt'), 'base\n', 'utf8');
    await git(['add', '.'], repoDir);
    await git(['commit', '-m', 'init'], repoDir);
  });

  afterEach(() => {
    resetBoardIntegrationLock();
    resetEnsuredBoards();
  });

  after(async () => {
    resetEnsuredBoards();
    resetBoardIntegrationLock();
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    await rmTestHome(homeDir);
    resetMinnowHomeCache();
  });

  test(
    'conflict re-opens the owning task with a rebase seed; retry merges',
    { timeout: 60_000 },
    async () => {
      resetEnsuredBoards();
      const boardId = 'p3c-reopen';
      const integrationRef = attemptBranch(boardId, 'integration');
      const journal = createMemoryJournal();
      await journal.createBoard(boardId);
      await journal.appendEvent(
        boardId,
        makeEvent('board.created', {
          boardId,
          planPath: 'plan.md',
          tasks: [taskSpec('A')],
          waves: [],
        }),
      );

      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      let mergesStarted = 0;
      /** @type {string | null} */
      let rebaseCwd = null;
      /** @type {string | null} */
      let rebaseUnique = null;
      let rebaseAhead = -1;
      const inner = createRunnerEffector({
        boardId,
        journal,
        getState: () => box.engine.getState(),
        model: { providerId: 'local-fake', id: 'fake-board-model' },
        worktrees: true,
        promptVariant: 'lite',
        runTurn: async (opts) => {
          const uniquePath = path.join(opts.cwd, 'unique-from-builder.txt');
          const isRebase =
            typeof opts.seed === 'string' &&
            opts.seed.includes('## Merge failed — repair required');
          if (isRebase) {
            try {
              rebaseUnique = await fsp.readFile(uniquePath, 'utf8');
              const { stdout } = await git(['rev-list', '--count', `${integrationRef}..HEAD`], opts.cwd);
              rebaseAhead = Number(stdout.trim());
            } catch {
              rebaseUnique = null;
              rebaseAhead = -1;
            }
            rebaseCwd = opts.cwd;
            await git(['reset', '--soft', integrationRef], opts.cwd);
            await fsp.writeFile(path.join(opts.cwd, 'shared.txt'), 'from-integration\n', 'utf8');
            return { outcome: 'pass', summary: 'ok', evidence: ['unique-from-builder.txt'] };
          }
          try {
            await fsp.access(uniquePath);
          } catch {
            await fsp.writeFile(uniquePath, 'task-unique\n', 'utf8');
            await fsp.writeFile(path.join(opts.cwd, 'shared.txt'), 'from-agent\n', 'utf8');
            await fsp.writeFile(path.join(opts.cwd, 'from-a.txt'), 'ok\n', 'utf8');
          }
          return { outcome: 'pass', summary: 'ok', evidence: ['from-a.txt'] };
        },
      });

      /**
       * Poison integration on the first merge so rebase conflicts, then let
       * the rebase-seeded retry merge cleanly.
       * @type {typeof inner}
       */
      const effector = {
        inspect: () => inner.inspect(),
        stop: (id) => inner.stop(id),
        onEnd: (handler) => inner.onEnd(handler),
        vanishAll: () => inner.vanishAll(),
        get started() {
          return inner.started;
        },
        async start(desired) {
          if (desired.role === 'merge') {
            mergesStarted += 1;
            if (mergesStarted === 1) {
              const intPath = getWorktreeSlotPath(boardId, 'integration');
              await fsp.writeFile(path.join(intPath, 'shared.txt'), 'from-integration\n', 'utf8');
              await git(['add', '-A'], intPath);
              await git(['commit', '-m', 'diverge integration'], intPath);
            }
          }
          return inner.start(desired);
        },
      };

      const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(1);
        await waitUntil(() => rebaseCwd != null, 45_000, 'rebase builder cwd');
        const uniqueNormalized = String(rebaseUnique ?? '').replace(/\r\n/g, '\n');
        assert.equal(
          uniqueNormalized,
          'task-unique\n',
          'rebase cwd must present unique-from-builder.txt (not a fresh integration slot)',
        );
        assert.ok(
          rebaseAhead > 0,
          `rebase cwd integration..HEAD was ${rebaseAhead} (owner must have the task commits)`,
        );

        await waitUntil(() => engine.getState().finished === true, 45_000, 'board to finish');

        const events = await journal.readEvents(boardId);
        const conflicted = events.filter((event) => event.type === 'merge.conflicted');
        const succeeded = events.filter((event) => event.type === 'merge.succeeded');
        assert.equal(conflicted.length, 1);
        assert.ok(
          conflicted[0].files.includes('shared.txt'),
          `conflict files were ${JSON.stringify(conflicted[0].files)}`,
        );
        assert.equal(succeeded.length, 1);
        assert.ok(succeeded[0].sha);
        assert.ok(succeeded[0].beforeSha);

        const seeds = events
          .filter((event) => event.type === 'task.attempt.started')
          .map((event) => event.seedKind);
        assert.ok(seeds.includes('rebase'), `seeds were ${seeds.join(', ')}`);
        for (const event of events) {
          assert.doesNotMatch(String(event.role ?? ''), /fixer/);
        }
        assert.equal(engine.getState().tasks.get('A').phase, 'merged');
      } finally {
        engine.dispose();
      }
    },
  );

  test(
    'while a merge is conflicted, an unrelated builder stays in inspect()',
    { timeout: 45_000 },
    async () => {
      resetEnsuredBoards();
      const boardId = 'p3c-parallel';
      const journal = createMemoryJournal();
      await journal.createBoard(boardId);
      await journal.appendEvent(
        boardId,
        makeEvent('board.created', {
          boardId,
          planPath: 'plan.md',
          tasks: [taskSpec('A'), taskSpec('B')],
          waves: [],
        }),
      );

      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      let releaseB = () => {};
      const bGate = new Promise((resolve) => {
        releaseB = resolve;
      });
      let bBuilderSeen = false;

      const inner = createRunnerEffector({
        boardId,
        journal,
        getState: () => box.engine.getState(),
        model: { providerId: 'local-fake', id: 'fake-board-model' },
        worktrees: true,
        promptVariant: 'lite',
        runTurn: async (opts) => {
          const id = taskIdFromSeed(opts.seed);
          if (id === 'B') {
            bBuilderSeen = true;
            await bGate;
          }
          await fsp.writeFile(path.join(opts.cwd, `from-${id}.txt`), `${id}\n`, 'utf8');
          if (id === 'A') {
            await fsp.writeFile(path.join(opts.cwd, 'shared.txt'), 'from-A\n', 'utf8');
          }
          return { outcome: 'pass', summary: 'ok', evidence: [] };
        },
      });

      let mergesStarted = 0;
      const effector = {
        inspect: () => inner.inspect(),
        stop: (id) => inner.stop(id),
        onEnd: (handler) => inner.onEnd(handler),
        vanishAll: () => inner.vanishAll(),
        get started() {
          return inner.started;
        },
        async start(desired) {
          if (desired.role === 'merge' && desired.taskId === 'A') {
            mergesStarted += 1;
            if (mergesStarted === 1) {
              const intPath = getWorktreeSlotPath(boardId, 'integration');
              await fsp.writeFile(path.join(intPath, 'shared.txt'), 'from-integration\n', 'utf8');
              await git(['add', '-A'], intPath);
              await git(['commit', '-m', 'diverge integration'], intPath);
            }
          }
          return inner.start(desired);
        },
      };

      const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(2);

        await waitUntil(
          async () => {
            const events = await journal.readEvents(boardId);
            return events.some((event) => event.type === 'merge.conflicted' && event.taskId === 'A');
          },
          30_000,
          'A merge.conflicted',
        );

        assert.equal(bBuilderSeen, true, 'B builder never started');
        const live = effector.inspect();
        assert.ok(
          live.some((row) => row.taskId === 'B' && row.role === 'builder'),
          `inspect after conflict was ${JSON.stringify(live)}`,
        );

        const desired = plan(engine.getState());
        assert.equal(desired.some((d) => d.role === 'merge'), false);
        assert.ok(
          desired.some((d) => d.taskId === 'B' && d.role === 'builder'),
          `plan() after conflict: ${JSON.stringify(desired)}`,
        );
        assert.ok(
          desired.some((d) => d.taskId === 'A' && d.role === 'builder' && d.seedKind === 'rebase'),
          'owning task was not re-opened with a rebase seed',
        );
      } finally {
        releaseB();
        engine.dispose();
      }
    },
  );

  test(
    'engine journals beforeSha on merge.succeeded from the AttemptEnd',
    { timeout: 45_000 },
    async () => {
      resetEnsuredBoards();
      const boardId = 'p3c-beforesha';
      const journal = createMemoryJournal();
      await journal.createBoard(boardId);
      await journal.appendEvent(
        boardId,
        makeEvent('board.created', {
          boardId,
          planPath: 'plan.md',
          tasks: [taskSpec('W1-A')],
          waves: [],
        }),
      );

      const box = { engine: /** @type {ReturnType<typeof createEngine> | null} */ (null) };
      const effector = createRunnerEffector({
        boardId,
        journal,
        getState: () => box.engine.getState(),
        model: { providerId: 'local-fake', id: 'fake-board-model' },
        worktrees: true,
        promptVariant: 'lite',
        runTurn: async (opts) => {
          await fsp.writeFile(path.join(opts.cwd, 'only-a.txt'), 'ok\n', 'utf8');
          return { outcome: 'pass', summary: 'ok', evidence: ['only-a.txt'] };
        },
      });
      const engine = createEngine({ boardId, effector, journal, tickMs: 100_000 });
      box.engine = engine;
      await engine.load();
      try {
        await engine.startBoard(1);
        await waitUntil(() => engine.getState().finished === true, 30_000, 'board to finish');
        const events = await journal.readEvents(boardId);
        const succeeded = events.find((event) => event.type === 'merge.succeeded');
        assert.ok(succeeded);
        assert.equal(typeof succeeded.sha, 'string');
        assert.ok(succeeded.sha.length > 0);
        assert.equal(typeof succeeded.beforeSha, 'string');
        assert.ok(succeeded.beforeSha.length > 0);
        assert.notEqual(succeeded.sha, succeeded.beforeSha);
        const intSha = await readIntegrationRef({ boardId, ref: 'HEAD' });
        assert.equal(succeeded.sha, intSha);
      } finally {
        engine.dispose();
      }
    },
  );
});
