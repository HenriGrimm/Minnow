/** Git workspace admission and setup for isolated boards. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { makeEvent } from '../../server/orchestrator/core/events.js';
import { boardRevisionRepos, readBoardRepos, runInBoardRepo } from '../../server/worktree/board-repos.js';
import { taskVerificationContract } from '../../server/orchestrator/verification-contract.js';
import { commitWorktree, mergeIntoIntegration, pushIntegration, readIntegrationRef } from '../../server/worktree/worktree-ops.js';
import { allocateAttemptWorktree, attemptBranch, ensureBoardPlan, integrationBranch } from '../../server/orchestrator/worktree-lifecycle.js';
import { checkpointAttempt } from '../../server/orchestrator/checkpoint.js';
import { runMerge } from '../../server/orchestrator/merge-queue.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { disposeEngines, peekEngine } from '../../server/orchestrator/engine.js';
import { appendEvent, loadState, resetJournalCache } from '../../server/orchestrator/journal.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import {
  BOARD_GIT_INITIALIZED_TYPE,
  resetEnsuredBoards,
} from '../../server/orchestrator/worktree-lifecycle.js';
import { isGitRepository } from '../../server/tools/git-change-stats.js';
import {
  getDefaultWorkspaceRoot,
  resetDefaultWorkspaceRootForTests,
  setWorkspaceRoot,
} from '../../server/workspace/root.js';

const execFileAsync = promisify(execFile);

const PLAN = `---
name: git-ensure
overview: A demo.
todos:
  - id: W1-A
    content: "Wave 1: A"
    status: pending
isProject: true
---

# Demo

## Wave Breakdown

### Wave 1 — One

#### Task W1-A: Alpha
- **Build:** build alpha
- **Test:** test alpha
- **Accept:** alpha works
- **Touches:** src/alpha/**
`;

const MODEL = { providerId: 'local-fake', id: 'fake-board-model' };

/** @type {http.Server | null} */
let server = null;
/** @type {string} */
let base = '';
/** @type {string | undefined} */
let previousHome;
/** @type {string} */
let previousWorkspace = '';
/** @type {string} */
let homeDir = '';
/** @type {string} */
let repoDir = '';

/**
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
async function call(method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

function installIsolatedEffector() {
  setEffectorFactory((boardId) =>
    createRunnerEffector({
      boardId,
      worktrees: true,
      model: MODEL,
      runTurn: async () => ({ outcome: 'pass', summary: 'ok', evidence: [] }),
    }),
  );
}

async function initChildRepos() {
  for (const name of ['backend', 'frontend']) {
    const cwd = path.join(repoDir, name);
    await fs.mkdir(cwd);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd, windowsHide: true });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd });
  }
}

describe('board git ensure at Start', { concurrency: false }, () => {
  before(() => {
    previousHome = process.env.MINNOW_HOME;
    previousWorkspace = getDefaultWorkspaceRoot();
  });

  beforeEach(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-board-git-'));
    repoDir = path.join(root, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-home-board-git-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await ensureMinnowLayout();
    await setWorkspaceRoot(repoDir);
    resetJournalCache();
    resetEnsuredBoards();
    disposeEngines();
    installIsolatedEffector();

    const middleware = createBoardsMiddleware();
    server = http.createServer((req, res) => {
      void middleware(req, res, () => {
        res.statusCode = 404;
        res.end('not found');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    disposeEngines();
    resetEnsuredBoards();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.dirname(repoDir), { recursive: true, force: true }).catch(() => {});
    resetMinnowHomeCache();
    resetJournalCache();
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    if (previousWorkspace) resetDefaultWorkspaceRootForTests(previousWorkspace);
  });

  test('Start on a non-git workspace inits the repo and journals it', async () => {
    assert.equal(await isGitRepository(repoDir), false);
    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md',
      markdown: PLAN,
      boardId: 'git-fresh',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const boardId = created.body.boardId;

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(await isGitRepository(repoDir), true);

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const gitEvents = journal.body.events.filter((event) => event.type === BOARD_GIT_INITIALIZED_TYPE);
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].createdRepo, true);
    assert.equal(gitEvents[0].committed, true);
    await call('POST', `/api/boards/${boardId}/stop`);
  });

  test('resumes a pre-existing parent-workspace board and verifies work in both repositories', async () => {
    await initChildRepos();
    const frontend = path.join(repoDir, 'frontend');
    await execFileAsync('git', ['worktree', 'add', '--detach', path.join(repoDir, 'frontend-preview')], { cwd: frontend });
    const planPath = 'documentation/plans/multi.md';
    const markdown = PLAN.replace('src/alpha/**', 'backend/**, frontend/**');
    await fs.mkdir(path.dirname(path.join(repoDir, planPath)), { recursive: true });
    await fs.writeFile(path.join(repoDir, planPath), markdown);
    const boardId = 'git-parent-recovery';
    const created = await call('POST', '/api/boards', { planPath, markdown, boardId });
    assert.equal(created.status, 201);
    await appendEvent(boardId, makeEvent('board.started', { concurrency: 1, recoveryVersion: 1 }));
    await appendEvent(boardId, makeEvent('recovery.held', {
      hold: {
        key: 'preflight:', taskId: null, role: 'preflight', stage: 'preflight',
        failure: { category: 'unknown', scope: 'task', message: 'Legacy workspace check', fingerprint: 'legacy' },
        count: 1, attention: true, revision: 0, observedAt: 0, retryAt: 0,
      },
    }));
    await appendEvent(boardId, makeEvent('board.stopped', { reason: 'user' }));

    const roots = [];
    setEffectorFactory(id => createRunnerEffector({
      boardId: id, worktrees: true, model: MODEL,
      runTurn: async ({ cwd, seed }) => {
        assert.equal((await fs.readFile(path.join(cwd, planPath), 'utf8')).replaceAll('\r\n', '\n'), markdown);
        assert.deepEqual((await fs.readdir(cwd)).sort(), ['backend', 'documentation', 'frontend']);
        if (!seed.includes('## Required verification contract')) {
          await fs.writeFile(path.join(cwd, 'backend', 'api.txt'), 'api');
          await fs.writeFile(path.join(cwd, 'frontend', 'web.txt'), 'web');
        }
        const task = peekEngine(boardId).getState().tasks.get('W1-A');
        const checks = taskVerificationContract(task).map(check => ({
          id: check.id, outcome: 'pass', evidence: [check.specification],
        }));
        return { outcome: 'pass', summary: 'ok', evidence: [], checks };
      },
      runFinalLadder: async ({ cwd }) => {
        roots.push(path.basename(cwd));
        const name = path.basename(cwd) === 'backend' ? 'api.txt' : 'web.txt';
        await fs.access(path.join(cwd, name));
        return { outcome: 'pass', summary: 'ok', evidence: {} };
      },
    }));

    const board = `/api/boards/${boardId}`;
    const started = await call('POST', `${board}/start`, { concurrency: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const engine = peekEngine(boardId);
    const deadline = Date.now() + 20_000;
    while (!engine.getState().finished && Date.now() < deadline) {
      await engine.tick();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const state = engine.getState();
    assert.equal(state.finished, true, JSON.stringify([state.recoveryHolds, [...state.tasks.values()]]));
    assert.notEqual(state.recoveryHolds['preflight:']?.failure.fingerprint, 'legacy');
    assert.equal(state.finalTest.outcome, 'pass');
    assert.equal(state.finalTest.evidence.integrationSha, state.integrationSha);
    assert.deepEqual([...boardRevisionRepos(state.integrationSha).keys()], ['backend', 'frontend']);
    assert.deepEqual(roots.sort(), ['backend', 'frontend']);
    const files = await call('GET', `${board}/tasks/W1-A/files`);
    assert.deepEqual(files.body.files.files.map(file => file.path), ['backend/api.txt', 'frontend/web.txt']);
    const diff = await call('GET', `${board}/tasks/W1-A/files?path=frontend%2Fweb.txt`);
    assert.ok(diff.body.file.lines.some(line => line.type === 'add' && line.text === 'web'));
    for (const id of ['backend', 'frontend']) {
      const remote = path.join(homeDir, `${id}.git`);
      await execFileAsync('git', ['init', '--bare', remote], { cwd: homeDir });
      await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: path.join(repoDir, id) });
    }
    const pushed = await pushIntegration({ boardId, branch: integrationBranch(boardId) });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    for (const [id, revision] of boardRevisionRepos(state.integrationSha)) {
      const { stdout } = await execFileAsync('git', ['rev-parse', integrationBranch(boardId)], { cwd: path.join(homeDir, `${id}.git`) });
      assert.equal(stdout.trim(), revision);
    }
    for (const name of [path.join(repoDir, '.git'), path.join(repoDir, 'backend', 'api.txt'), path.join(repoDir, 'frontend', 'web.txt')]) {
      await assert.rejects(fs.access(name), { code: 'ENOENT' });
    }
    const before = new Map((await readBoardRepos(boardId)).repos.map(repo => [repo.id, repo.baseSha]));
    assert.equal((await call('POST', `${board}/tasks/W1-A/rewind`)).status, 200);
    assert.deepEqual(boardRevisionRepos(await readIntegrationRef({ boardId })), before);
  });

  test('a crash after the first repository merge retains the original rewind point', async () => {
    await initChildRepos();
    const boardId = 'git-parent-merge-crash';
    await call('POST', '/api/boards', { planPath: 'demo.md', markdown: PLAN, boardId });
    await ensureBoardPlan(boardId, null);
    const state = await loadState(boardId);
    state.recoveryVersion = 1;
    const task = state.tasks.get('W1-A');
    const desired = { taskId: task.id, role: 'builder', seedKind: 'initial' };
    const slot = await allocateAttemptWorktree({ boardId, taskId: task.id, desired, state });
    assert.equal(slot.ok, true, JSON.stringify(slot));
    for (const id of ['backend', 'frontend']) await fs.writeFile(path.join(slot.path, id, 'new.txt'), id);
    assert.equal((await commitWorktree({ boardId, slotId: slot.slotId })).ok, true);
    const frontendPath = path.join(slot.path, 'frontend');
    await fs.writeFile(path.join(frontendPath, 'draft.txt'), 'retained');
    const checkpoint = await checkpointAttempt({ boardId, attemptId: 'saved', worktree: slot.path });
    task.attempts.push({ attemptId: 'saved', role: 'builder', outcome: 'crashed', ended: true,
      worktree: slot.path, evidence: { checkpoint: { attemptId: checkpoint.attemptId } } });
    await execFileAsync('git', ['worktree', 'remove', '--force', frontendPath], { cwd: path.join(repoDir, 'frontend') });
    const repaired = await allocateAttemptWorktree({ boardId, taskId: task.id, attemptId: 'restored', desired, state });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(await fs.readFile(path.join(frontendPath, 'draft.txt'), 'utf8'), 'retained');
    assert.equal(await fs.readFile(path.join(slot.path, 'backend', 'new.txt'), 'utf8'), 'backend');
    await fs.unlink(path.join(frontendPath, 'draft.txt'));
    const fromBranch = attemptBranch(boardId, slot.slotId);
    const tested = await readIntegrationRef({ boardId, ref: fromBranch });
    const before = await readIntegrationRef({ boardId });
    task.attempts.push({ attemptId: 'tested', role: 'tester', worktree: slot.path, outcome: 'pass', ended: true, evidence: { verifiedSha: tested } });
    const layout = await readBoardRepos(boardId);
    const attempt = { boardId, state, taskId: task.id, attemptId: 'merge' };
    await assert.rejects(runMerge({
      ...attempt, ops: {
        async mergeIntoIntegration(input) {
          const result = await runInBoardRepo(layout, layout.repos[0], () => mergeIntoIntegration(input));
          assert.equal(result.ok, true);
          throw new Error('simulated crash');
        },
      },
    }), /simulated crash/);
    const partial = boardRevisionRepos(await readIntegrationRef({ boardId }));
    assert.equal(partial.get('backend'), boardRevisionRepos(tested).get('backend'));
    assert.equal(partial.get('frontend'), boardRevisionRepos(before).get('frontend'));
    const resumed = await runMerge(attempt);
    assert.equal(resumed.outcome, 'pass', JSON.stringify(resumed));
    assert.equal(resumed.sha, tested);
    assert.equal(resumed.beforeSha, before);
  });

  test('Start on an existing repo does not journal git init', async () => {
    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'README.md'), '# already\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md',
      markdown: PLAN,
      boardId: 'git-existing',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const boardId = created.body.boardId;
    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    const gitEvents = journal.body.events.filter((event) => event.type === BOARD_GIT_INITIALIZED_TYPE);
    assert.equal(gitEvents.length, 0);
    await call('POST', `/api/boards/${boardId}/stop`);
  });

  test('copies an uncommitted plan into task worktrees', async () => {
    await execFileAsync('git', ['init'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test'], {
      cwd: repoDir,
      windowsHide: true,
    });
    await fs.writeFile(path.join(repoDir, 'README.md'), '# already\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

    const planPath = 'documentation/plans/uncommitted.md';
    const absolutePlanPath = path.join(repoDir, ...planPath.split('/'));
    await fs.mkdir(path.dirname(absolutePlanPath), { recursive: true });
    await fs.writeFile(absolutePlanPath, PLAN, 'utf8');

    let resolvePlan;
    const planSeen = new Promise((resolve) => { resolvePlan = resolve; });
    setEffectorFactory((boardId) =>
      createRunnerEffector({
        boardId,
        worktrees: true,
        model: MODEL,
        runTurn: async ({ cwd, signal }) => {
          resolvePlan(await fs.readFile(path.join(cwd, ...planPath.split('/')), 'utf8'));
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          return { outcome: 'crashed', error: 'stopped by test' };
        },
      }),
    );

    const created = await call('POST', '/api/boards', {
      planPath,
      markdown: PLAN,
      boardId: 'uncommitted-plan',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const started = await call('POST', '/api/boards/uncommitted-plan/start', { concurrency: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal((await planSeen).replaceAll('\r\n', '\n'), PLAN);
    await call('POST', '/api/boards/uncommitted-plan/stop');

    const { stdout: status } = await execFileAsync('git', ['status', '--short', '--', planPath], {
      cwd: repoDir,
      windowsHide: true,
    });
    assert.match(status, /^\?\? documentation\/plans\/uncommitted\.md/m);
  });

  test('git init failure preserves accepted Start as a recoverable hold', async () => {
    await fs.writeFile(path.join(repoDir, '.git'), 'not a repository\n', 'utf8');
    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md',
      markdown: PLAN,
      boardId: 'git-fail',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const boardId = created.body.boardId;

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 200);

    const after = await call('GET', `/api/boards/${boardId}`);
    assert.equal(after.body.state.status, 'running');
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.equal(
      journal.body.events.some((event) => event.type === 'board.started'),
      true,
    );
  });

  test('explicit cwd (P2-G) does not require git', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-p2g-gitfree-'));
    try {
      const effector = createRunnerEffector({
        cwd: sandbox,
        model: MODEL,
      });
      await effector.preflight();
      assert.equal(await isGitRepository(sandbox), false);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  test('the real preflight forwards cancellation into checkout preparation before copying the plan', async () => {
    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md', markdown: PLAN, boardId: 'git-cancel-setup',
    });
    assert.equal(created.status, 201);
    const controller = new AbortController();
    const phases = [];
    const effector = createRunnerEffector({
      boardId: created.body.boardId, model: MODEL, worktrees: true,
      runTurn: async () => assert.fail('cancelled setup must not run a model'),
    });
    await assert.rejects(effector.preflight({
      signal: controller.signal,
      onProgress(progress) {
        phases.push(progress.stage);
        if (progress.stage === 'environment') controller.abort(new Error('fixture stop'));
      },
    }), /fixture stop/);
    assert.ok(phases.includes('workspace'));
    assert.ok(phases.includes('environment'));
    assert.equal(phases.includes('plan'), false);
    assert.deepEqual(effector.inspect(), []);
  });
});
