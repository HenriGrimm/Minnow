/**
 * Isolated-worktree Start runs MIN-615 git init so a non-git workspace is a
 * 400 on the button, not a failed worktree add after parse.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { createRunnerEffector } from '../../server/orchestrator/effector-runner.js';
import { disposeEngines } from '../../server/orchestrator/engine.js';
import { resetJournalCache } from '../../server/orchestrator/journal.js';
import {
  createBoardsMiddleware,
  setEffectorFactory,
} from '../../server/orchestrator/middleware.js';
import {
  BOARD_GIT_INITIALIZED_TYPE,
  resetEnsuredBoards,
} from '../../server/orchestrator/worktree-lifecycle.js';
import { isGitRepository } from '../../server/tools/git-change-stats.js';
import { getDefaultWorkspaceRoot, setWorkspaceRoot } from '../../server/workspace/root.js';

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
      promptVariant: 'lite',
      runTurn: async () => ({ outcome: 'pass', summary: 'ok', evidence: [] }),
    }),
  );
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
    if (previousWorkspace) await setWorkspaceRoot(previousWorkspace);
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
        promptVariant: 'lite',
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

  test('git init failure is a 400 on Start and does not start the board', async () => {
    await fs.writeFile(path.join(repoDir, '.git'), 'not a repository\n', 'utf8');
    const created = await call('POST', '/api/boards', {
      planPath: 'demo.md',
      markdown: PLAN,
      boardId: 'git-fail',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const boardId = created.body.boardId;

    const started = await call('POST', `/api/boards/${boardId}/start`, { concurrency: 1 });
    assert.equal(started.status, 400);
    assert.match(String(started.body.error ?? ''), /git/i);

    const after = await call('GET', `/api/boards/${boardId}`);
    assert.equal(after.body.state.status, 'created');
    const journal = await call('GET', `/api/boards/${boardId}/journal`);
    assert.equal(
      journal.body.events.some((event) => event.type === 'board.started'),
      false,
    );
  });

  test('explicit cwd (P2-G) does not require git', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-p2g-gitfree-'));
    try {
      const effector = createRunnerEffector({
        cwd: sandbox,
        model: MODEL,
        promptVariant: 'lite',
      });
      await effector.preflight();
      assert.equal(await isGitRepository(sandbox), false);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
});
