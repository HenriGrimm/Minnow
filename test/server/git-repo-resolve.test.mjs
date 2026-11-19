/**
 * Multi-repo workspaces: picking the repo a git/forge call runs in.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveRepoCwd } from '../../server/git/repo-resolve.js';
import { handleGitRequest } from '../../server/git/middleware.js';
import { getDefaultWorkspaceRoot, resetDefaultWorkspaceRootForTests, setWorkspaceRoot } from '../../server/workspace/root.js';
import { handleWorkspaceRequest } from '../../server/workspace/middleware.js';
import { getWorktreesRoot } from '../../server/worktree/paths.js';
import { invalidateRegisteredWorktreeCache } from '../../server/worktree/allowlist.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
import { invalidateWorkspaceRepos } from '../../server/workspace/repos.js';
import { httpRequest } from '../config/test-helpers.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function makeRepo(dir, remote, branch) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'remote', 'add', 'origin', remote);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
}

describe('repo resolution', () => {
  let root;
  let single;
  let server;
  let baseUrl;
  let fixture;
  let oldHome;
  const oldWorkspace = getDefaultWorkspaceRoot();

  before(async () => {
    fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mn-multi-')));
    oldHome = process.env.MINNOW_HOME;
    process.env.MINNOW_HOME = path.join(fixture, 'home');
    resetMinnowHomeCache();
    root = path.join(fixture, 'workspace');
    await makeRepo(path.join(root, 'frontend'), 'git@github.com:acme/web.git', 'web-main');
    await makeRepo(path.join(root, 'backend'), 'https://github.com/acme/api.git', 'api-main');
    single = path.join(fixture, 'single');
    await makeRepo(single, 'https://github.com/acme/solo.git', 'main');
    invalidateWorkspaceRepos();
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void runWithViewWorkspace(root, () => url.pathname.startsWith('/api/workspace/')
        ? handleWorkspaceRequest(req, res, url.pathname, url.searchParams)
        : handleGitRequest(req, res, url.pathname));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (oldHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = oldHome;
    resetMinnowHomeCache();
    resetDefaultWorkspaceRootForTests(oldWorkspace);
    await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test('a repo id, its remote slug, or a path picks the repo', async () => {
    assert.equal((await resolveRepoCwd({ repo: 'backend' }, { workspaceRoot: root })).cwd, path.join(root, 'backend'));
    assert.equal((await resolveRepoCwd({ repo: 'acme/web' }, { workspaceRoot: root })).repo.id, 'frontend');
    const byPath = await resolveRepoCwd({ path: 'frontend/src/x.ts' }, { workspaceRoot: root });
    assert.equal(byPath.repo.id, 'frontend');
    assert.equal(byPath.relPath, 'src/x.ts');
  });

  test('ambiguity and unknown ids are errors for strict callers', async () => {
    await assert.rejects(resolveRepoCwd({}, { workspaceRoot: root }), /several repos \(backend, frontend\); pass repo/);
    await assert.rejects(resolveRepoCwd({ repo: 'nope' }, { workspaceRoot: root }), /Unknown repo "nope"; known: backend, frontend/);
    assert.equal((await resolveRepoCwd({}, { workspaceRoot: root, strict: false })).cwd, root);
  });

  test('a single-repo workspace needs no repo', async () => {
    const resolved = await resolveRepoCwd({}, { workspaceRoot: single });
    assert.equal(resolved.cwd, single);
    assert.equal(resolved.repo.id, '.');
  });

  test('POST /api/git status with repo runs in that repo', async () => {
    await setWorkspaceRoot(root);
    const backend = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', repo: 'backend' });
    assert.equal(backend.status, 200);
    assert.equal(backend.json.branch, 'api-main');
    assert.equal(backend.json.repoId, 'backend');
    const frontend = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', repo: 'frontend' });
    assert.equal(frontend.json.branch, 'web-main');
    const unknown = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', repo: 'nope' });
    assert.equal(unknown.json.ok, false);
    assert.match(unknown.json.error, /Unknown repo/);
  });

  test('a child repo root is an allowed cwd; other folders are not', async () => {
    await setWorkspaceRoot(root);
    const child = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', cwd: path.join(root, 'frontend') });
    assert.equal(child.json.branch, 'web-main');
    const outsider = path.join(fixture, 'outsider');
    await makeRepo(outsider, 'https://github.com/x/y.git', 'main');
    const rejected = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', cwd: outsider });
    assert.equal(rejected.json.ok, false);
    assert.match(rejected.json.error, /allowlist/);
    const nested = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', cwd: path.join(root, 'frontend', '..', 'backend') });
    assert.equal(nested.json.branch, 'api-main');
  });

  test('the workspace API discovers repos in a mirrored checkout and Git accepts its child worktrees', async () => {
    const repos = await httpRequest(baseUrl, 'GET', '/api/workspace/repos');
    assert.deepEqual(repos.json.repos.map(repo => repo.id), ['backend', 'frontend']);
    const mirror = path.join(getWorktreesRoot(), 'multi-repo-discovery-test');
    const standalone = path.join(path.dirname(root), `${path.basename(root)}-frontend`);
    await fs.mkdir(mirror, { recursive: true });
    git(path.join(root, 'backend'), 'worktree', 'add', '-q', '-b', 'chat-backend', path.join(mirror, 'backend'));
    git(path.join(root, 'frontend'), 'worktree', 'add', '-q', '-b', 'chat-frontend', path.join(mirror, 'frontend'));
    git(path.join(root, 'frontend'), 'worktree', 'add', '-q', '-b', 'external-frontend', standalone);
    invalidateRegisteredWorktreeCache();

    const discovered = await httpRequest(baseUrl, 'GET', `/api/workspace/repos?${new URLSearchParams({ checkout: mirror })}`);
    assert.deepEqual(discovered.json.repos.map(repo => repo.id), ['backend', 'frontend']);
    const isolated = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', cwd: discovered.json.repos[0].absPath });
    assert.equal(isolated.json.branch, 'chat-backend');
    const linked = await httpRequest(baseUrl, 'POST', '/api/git', { op: 'status', cwd: standalone });
    assert.equal(linked.json.branch, 'external-frontend');
    const unauthorized = await httpRequest(baseUrl, 'GET', `/api/workspace/repos?${new URLSearchParams({ checkout: single })}`);
    assert.equal(unauthorized.status, 400);
    assert.match(unauthorized.json.error, /allowlist/);
  });
});
