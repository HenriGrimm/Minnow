import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { pull, status } from '../../server/git/git-ops.js';

const exec = promisify(execFile);
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

async function git(cwd, ...args) {
  const result = await exec('git', args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function setup(t, { localChange = true, conflict = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pull-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote');
  const writer = path.join(root, 'writer');
  const cwd = path.join(root, 'checkout');
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, writer);
  async function commit(dir, file, content) {
    await fs.writeFile(path.join(dir, file), content);
    await git(dir, 'add', file);
    await git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', content);
  }
  await commit(writer, 'shared.txt', 'base');
  await git(writer, 'push', 'origin', 'main');
  await git(root, 'clone', remote, cwd);
  await git(cwd, 'config', 'user.name', 'Test');
  await git(cwd, 'config', 'user.email', 'test@example.com');
  if (localChange) await commit(cwd, conflict ? 'shared.txt' : 'local.txt', 'local change');
  await commit(writer, conflict ? 'shared.txt' : 'remote.txt', 'remote change');
  await git(writer, 'push', 'origin', 'main');
  return { cwd, localHead: await git(cwd, 'rev-parse', 'HEAD'), remoteHead: await git(writer, 'rev-parse', 'HEAD') };
}

for (const strategy of ['merge', 'rebase']) {
  test(`retries a divergent pull with a one-time ${strategy}`, async (t) => {
    const { cwd, localHead, remoteHead } = await setup(t);
    const initial = await pull({ cwd });
    assert.equal(initial.ok, false);
    assert.deepEqual(initial.pullTarget, { cwd, branch: 'main', head: localHead, upstream: 'origin/main' });
    assert.equal(await git(cwd, 'rev-parse', 'HEAD'), localHead);
    assert.equal(await git(cwd, 'rev-parse', 'origin/main'), remoteHead);

    const retry = await pull({ cwd, strategy, expectedTarget: initial.pullTarget });
    assert.equal(retry.ok, true, retry.error);
    const parents = (await git(cwd, 'show', '-s', '--format=%P', 'HEAD')).split(' ');
    assert.deepEqual(parents, strategy === 'merge' ? [localHead, remoteHead] : [remoteHead]);
    assert.equal(await fs.readFile(path.join(cwd, 'local.txt'), 'utf8'), 'local change');
    assert.equal(await fs.readFile(path.join(cwd, 'remote.txt'), 'utf8'), 'remote change');
    assert.equal(await git(cwd, 'rev-parse', 'origin/main'), remoteHead);
    await assert.rejects(git(cwd, 'config', '--get-regexp', '^pull\.'), { code: 1 });
  });
}

test('a normal fast-forward needs no choice', async (t) => {
  const { cwd, remoteHead } = await setup(t, { localChange: false });
  const result = await pull({ cwd });
  assert.equal(result.ok, true, result.error);
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), remoteHead);
});

test('an explicit fast-forward-only policy does not offer an override', async (t) => {
  const { cwd, localHead } = await setup(t);
  await git(cwd, 'config', 'pull.ff', 'only');
  const result = await pull({ cwd });
  assert.equal(result.ok, false);
  assert.equal(result.pullTarget, undefined);
  assert.match(result.error, /Git is set to fast-forward only/);
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), localHead);
});

test('configured merge pulls do not require a choice', async (t) => {
  const { cwd, localHead, remoteHead } = await setup(t);
  await git(cwd, 'config', 'pull.rebase', 'false');
  const result = await pull({ cwd });
  assert.equal(result.ok, true, result.error);
  assert.equal(await git(cwd, 'show', '-s', '--format=%P', 'HEAD'), `${localHead} ${remoteHead}`);
});

test('refuses a strategy retry after a branch switch even when the commit is the same', async (t) => {
  const { cwd, localHead } = await setup(t);
  const initial = await pull({ cwd });
  assert.ok(initial.pullTarget);
  await git(cwd, 'checkout', '-b', 'other');
  await git(cwd, 'branch', '--set-upstream-to=origin/main');
  const result = await pull({ cwd, strategy: 'merge', expectedTarget: initial.pullTarget });
  assert.equal(result.ok, false);
  assert.match(result.error, /checkout or upstream changed/);
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), localHead);
});

for (const strategy of ['merge', 'rebase']) {
  test(`a conflicting ${strategy} leaves Git’s normal recovery state visible`, async (t) => {
    const { cwd } = await setup(t, { conflict: true });
    const initial = await pull({ cwd });
    assert.ok(initial.pullTarget);
    const result = await pull({ cwd, strategy, expectedTarget: initial.pullTarget });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.equal(result.pullTarget, undefined);
    const current = await status({ cwd });
    assert.equal(current.operation, strategy);
    assert.deepEqual(current.conflicted.map(({ path }) => path), ['shared.txt']);
  });
}
