/**
 * POST /api/worktree — finish-dashboard ops must be wired in middleware.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { handleWorktreeRequest } from '../../server/worktree/middleware.js';
import {
  createWorktree,
  ensureIntegration,
} from '../../server/worktree/worktree-ops.js';
import { getWorktreeSlotPath } from '../../server/worktree/paths.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import { httpRequest } from '../config/test-helpers.js';

const execFileAsync = promisify(execFile);
const BOARD_ID = 'test-board-mw-33333333';

function createWorktreeTestServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleWorktreeRequest(req, res, url.pathname).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
}

describe('worktree middleware finish ops', () => {
  let repoDir;
  let minnowHome;
  let server;
  let baseUrl;
  let integrationBranch;

  before(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-wt-mw-'));
    repoDir = path.join(root, 'repo');
    minnowHome = path.join(root, 'minnow-home');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.mkdir(minnowHome, { recursive: true });
    process.env.MINNOW_HOME = minnowHome;
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
    await fs.writeFile(path.join(repoDir, 'README.md'), '# base\n', 'utf8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir, windowsHide: true });

    integrationBranch = `minnow/board/${BOARD_ID}/integration`;
    assert.equal(
      (await ensureIntegration({ boardId: BOARD_ID, branch: integrationBranch })).ok,
      true,
    );
    assert.equal(
      (
        await createWorktree({
          boardId: BOARD_ID,
          slotId: 'task-W1-A',
          branch: `minnow/board/${BOARD_ID}/task/W1-A`,
          baseRef: integrationBranch,
        })
      ).ok,
      true,
    );

    server = createWorktreeTestServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    await new Promise((resolve) => server.close(resolve));
  });

  test('commit_integration returns HTTP 200 (not ReferenceError 400)', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    await fs.writeFile(path.join(intPath, 'finish.txt'), 'land\n', 'utf8');

    const res = await httpRequest(baseUrl, 'POST', '/api/worktree', {
      op: 'commit_integration',
      boardId: BOARD_ID,
      message: 'finish dashboard commit',
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.equal(res.json?.committed, true);
  });

  test('lands on a new or existing branch and protects workspace changes', async () => {
    const git = async (...args) => (await execFileAsync('git', args, { cwd: repoDir, windowsHide: true })).stdout.trim();
    const original = await git('branch', '--show-current');
    const originalSha = await git('rev-parse', 'HEAD');
    await git('branch', 'release', 'HEAD');
    const tip = await git('rev-parse', integrationBranch);
    const land = (extra) => httpRequest(baseUrl, 'POST', '/api/worktree', {
      op: 'merge_integration_into_workspace', branch: integrationBranch, ...extra,
    });
    const fresh = await land({ targetBranch: 'board-delivery', createBranch: true, baseRef: original });
    assert.equal(fresh.json?.ok, true, JSON.stringify(fresh.json));
    assert.equal(await git('branch', '--show-current'), 'board-delivery');
    assert.equal(await git('rev-parse', original), originalSha);
    assert.equal(await git('rev-parse', 'HEAD'), tip);
    assert.equal((await land({ targetBranch: 'board-delivery', createBranch: true })).json?.ok, false);
    await fs.writeFile(path.join(repoDir, 'unsaved.txt'), 'keep me\n');
    const dirty = await land({ targetBranch: 'release' });
    assert.equal(dirty.json?.ok, false);
    assert.equal(await git('branch', '--show-current'), 'board-delivery');
    await fs.unlink(path.join(repoDir, 'unsaved.txt'));
    const existing = await land({ targetBranch: 'release' });
    assert.equal(existing.json?.ok, true, JSON.stringify(existing.json));
    assert.equal(await git('rev-parse', 'release'), tip);
    assert.equal(await git('rev-parse', original), originalSha);
    await git('switch', original);
  });

  test('merge_integration_into_workspace returns HTTP 200', async () => {
    const intPath = getWorktreeSlotPath(BOARD_ID, 'integration', repoDir);
    await fs.writeFile(path.join(intPath, 'land-me.txt'), 'board work\n', 'utf8');
    await execFileAsync('git', ['add', 'land-me.txt'], { cwd: intPath, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'board change'], {
      cwd: intPath,
      windowsHide: true,
    });

    const res = await httpRequest(baseUrl, 'POST', '/api/worktree', {
      op: 'merge_integration_into_workspace',
      branch: integrationBranch,
      message: 'land board',
    });

    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.equal(res.json?.merged, true);
    await fs.access(path.join(repoDir, 'land-me.txt'));
  });
});
