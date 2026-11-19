import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  discoverWorkspaceRepos,
  findRepoForPath,
  invalidateWorkspaceRepos,
  repoRemoteSlug,
} from '../../server/workspace/repos.js';

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function makeRepo(dir, remote) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
}

async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mn-repos-')));
}

test('finds sibling repos with their remotes', async () => {
  const root = await tempDir();
  await makeRepo(path.join(root, 'frontend'), 'git@github.com:acme/web.git');
  await makeRepo(path.join(root, 'backend'), 'https://github.com/acme/api.git');
  await makeRepo(path.join(root, 'node_modules', 'dep'), 'https://github.com/x/dep.git');
  await fs.mkdir(path.join(root, 'docs'));

  const repos = await discoverWorkspaceRepos(root, { refresh: true });
  assert.deepEqual(repos.map((r) => r.id), ['backend', 'frontend']);
  assert.equal(repoRemoteSlug(repos[0]), 'acme/api');
  assert.equal(repoRemoteSlug(repos[1]), 'acme/web');
  assert.equal(repos[0].remote.host, 'github');
  assert.equal(repos.some((r) => r.isRoot), false);

  const hit = findRepoForPath(path.join(root, 'backend', 'src', 'a.ts'), repos);
  assert.equal(hit?.id, 'backend');
  assert.equal(findRepoForPath(path.join(root, 'docs', 'x.md'), repos), null);
  invalidateWorkspaceRepos(root);
});

test('a single repo workspace is one repo with id "."', async () => {
  const root = await tempDir();
  await makeRepo(root, 'https://github.com/acme/solo.git');
  const repos = await discoverWorkspaceRepos(root, { refresh: true });
  assert.equal(repos.length, 1);
  assert.equal(repos[0].id, '.');
  assert.equal(repos[0].isRoot, true);
  assert.equal(repoRemoteSlug(repos[0]), 'acme/solo');
});

test('nested repo wins over the root repo for its paths, even below several folders', async () => {
  const root = await tempDir();
  await makeRepo(root, null);
  await makeRepo(path.join(root, 'apps', 'clients', 'external', 'web'), null);
  const repos = await discoverWorkspaceRepos(root, { refresh: true });
  assert.deepEqual(repos.map((r) => r.id), ['.', 'apps/clients/external/web']);
  assert.equal(repos[1].remote, null);
  assert.equal(findRepoForPath(path.join(root, 'apps', 'clients', 'external', 'web', 'index.ts'), repos)?.id, 'apps/clients/external/web');
  assert.equal(findRepoForPath(path.join(root, 'README.md'), repos)?.id, '.');
});

test('a plain folder has no repos', async () => {
  const root = await tempDir();
  assert.deepEqual(await discoverWorkspaceRepos(root, { refresh: true }), []);
});
