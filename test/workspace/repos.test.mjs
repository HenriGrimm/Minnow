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

test('does not discover GitHub remotes for embedded gitlinks or ignored clones', async (t) => {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasets = path.join(root, 'evals', 'datasets');
  const gitlink = path.join(datasets, 'tracked dataset');
  const ignored = path.join(datasets, 'local');
  await makeRepo(root, 'https://github.com/acme/workspace.git');
  await makeRepo(gitlink, 'https://github.com/external/tracked.git');
  git(gitlink, '-c', 'user.name=Test', '-c', 'user.email=test@example.net', 'commit', '--allow-empty', '-qm', 'Initial commit');
  git(root, 'add', '--', 'evals/datasets/tracked dataset');
  await makeRepo(ignored, 'https://github.com/external/local.git');
  await fs.writeFile(path.join(root, '.gitignore'), '/evals/datasets/local/\n');
  await makeRepo(path.join(root, 'apps', 'api'), 'https://github.com/acme/api.git');

  for (const workspace of [root, path.join(root, 'evals')]) {
    const repos = await discoverWorkspaceRepos(workspace, { refresh: true });
    assert.deepEqual(repos.map(repoRemoteSlug), workspace === root ? ['acme/workspace', 'acme/api'] : ['acme/workspace']);
  }
  // Opening the dependency itself as a workspace is explicit and still works.
  const direct = await discoverWorkspaceRepos(gitlink, { refresh: true });
  assert.deepEqual(direct.map(repoRemoteSlug), ['external/tracked']);
});

test('a plain folder has no repos', async () => {
  const root = await tempDir();
  assert.deepEqual(await discoverWorkspaceRepos(root, { refresh: true }), []);
});
