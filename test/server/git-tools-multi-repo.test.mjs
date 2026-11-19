/**
 * Agent git tools in a workspace folder that holds several repos.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { setWorkspaceRoot } from '../../server/workspace/root.js';
import { invalidateWorkspaceRepos } from '../../server/workspace/repos.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function run(name, args) {
  return String((await executeServerTool(name, args)).result);
}

describe('git tools across repos', () => {
  let home;
  let root;
  let single;

  before(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mn-gittools-home-')));
    process.env.MINNOW_HOME = home;
    resetMinnowHomeCache();
    root = path.join(home, 'multi');
    await makeRepo(path.join(root, 'frontend'));
    await makeRepo(path.join(root, 'backend'));
    single = path.join(home, 'single');
    await makeRepo(single);
    invalidateWorkspaceRepos();
    await setWorkspaceRoot(root);
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test('status with repo shows only that repo', async () => {
    await fs.writeFile(path.join(root, 'frontend', 'web.txt'), 'w\n');
    await fs.writeFile(path.join(root, 'backend', 'a.txt'), 'two\n');
    const out = await run('git_status', { repo: 'frontend' });
    assert.match(out, /\[frontend\] git status/);
    assert.match(out, /web\.txt/);
    assert.doesNotMatch(out, /a\.txt/);
  });

  test('no repo in a multi-repo workspace is a tool error listing the repos', async () => {
    const out = await run('git_status', {});
    assert.match(out, /^Error: This workspace has several repos \(backend, frontend\); pass repo/);
  });

  test('diff infers the repo from a workspace-relative path', async () => {
    const out = await run('git_diff', { path: 'backend/a.txt' });
    assert.match(out, /\[backend\] git diff -- a\.txt/);
    assert.match(out, /\+two/);
  });

  test('add refuses paths spanning repos, then commits per repo', async () => {
    const mixed = await run('git_add', { paths: ['backend/a.txt', 'frontend/web.txt'] });
    assert.match(mixed, /different repos/);
    assert.equal(git(path.join(root, 'backend'), 'diff', '--cached', '--name-only').trim(), '');

    await run('git_add', { paths: ['backend/a.txt'] });
    const committed = await run('git_commit', { repo: 'backend', message: 'backend change' });
    assert.doesNotMatch(committed, /^Error/);
    assert.match(git(path.join(root, 'backend'), 'log', '--oneline', '-1'), /backend change/);
    assert.doesNotMatch(git(path.join(root, 'frontend'), 'log', '--oneline', '-1'), /backend change/);
  });

  test('a single-repo workspace needs no repo and keeps the plain label', async () => {
    await setWorkspaceRoot(single);
    await fs.writeFile(path.join(single, 'a.txt'), 'changed\n');
    const out = await run('git_status', {});
    assert.match(out, /git status/);
    assert.doesNotMatch(out, /\[\.\]/);
    assert.match(out, /a\.txt/);
    await setWorkspaceRoot(root);
  });
});
