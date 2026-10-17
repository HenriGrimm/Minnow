import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { issueWorkInspect, issueWorkCommit, issueWorkMerge, issueWorkCleanup } from '../../server/git/issue-work-ops.js';
import { getDefaultWorkspaceRoot, resetDefaultWorkspaceRootForTests } from '../../server/workspace/root.js';
import { invalidateRegisteredWorktreeCache } from '../../server/worktree/allowlist.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-issue-work-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd = path.join(dir, 'repo');
  const worktreePath = path.join(dir, 'issue');
  await fs.mkdir(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'config', 'user.name', 'Minnow Test');
  git(cwd, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(cwd, 'file.txt'), 'original\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Initial');
  git(cwd, 'worktree', 'add', '-b', 'issue/test', worktreePath);
  const previous = getDefaultWorkspaceRoot();
  resetDefaultWorkspaceRootForTests(cwd);
  invalidateRegisteredWorktreeCache();
  t.after(() => { resetDefaultWorkspaceRootForTests(previous); invalidateRegisteredWorktreeCache(); });
  return { cwd, worktreePath, sourceBranch: 'issue/test', dir };
}
async function reviewed(input) {
  const result = await issueWorkInspect(input);
  assert.equal(result.ok, true, result.error);
  return { ...input, sourceHead: result.sourceHead, targetHead: result.targetHead, sourceBranch: result.sourceBranch, targetBranch: result.targetBranch, fingerprint: result.fingerprint, message: '[MIN-1] Fix the issue', cleanup: true };
}

test('commits and merges reviewed work, then removes the worktree and branch', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'fixed\n');
  await fs.writeFile(path.join(f.worktreePath, 'new.txt'), 'added\n');
  const snapshot = await issueWorkInspect(f);
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.deepEqual(snapshot.files.sort(), ['file.txt', 'new.txt']);
  assert.match(snapshot.patch, /\+\+\+ b\/new.txt/);
  assert.match(snapshot.patch, /\+added/);
  const result = await issueWorkMerge(await reviewed(f));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.merged, true);
  assert.equal(result.worktreeRemoved, true, result.cleanupError);
  assert.equal(result.branchRemoved, true, result.cleanupError);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'fixed\n');
  assert.equal(await fs.readFile(path.join(f.cwd, 'new.txt'), 'utf8'), 'added\n');
  assert.equal(git(f.cwd, 'branch', '--list', 'issue/test'), '');
});

test('refuses edits made after review, including untracked file content changes', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.worktreePath, 'new.txt');
  await fs.writeFile(file, 'reviewed\n');
  const input = await reviewed(f);
  await fs.writeFile(file, 'changed after review\n');
  const result = await issueWorkMerge(input);
  assert.equal(result.ok, false);
  assert.match(result.error, /changed.*review/i);
  assert.equal(git(f.cwd, 'log', '-1', '--format=%s'), 'Initial');
  assert.equal(await fs.readFile(file, 'utf8'), 'changed after review\n');
});

test('refuses a dirty destination and preserves both checkouts', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'issue change\n');
  const input = await reviewed(f);
  await fs.writeFile(path.join(f.cwd, 'file.txt'), 'workspace change\n');
  const result = await issueWorkMerge(input);
  assert.equal(result.ok, false);
  assert.match(result.error, /destination workspace changes/);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'workspace change\n');
  assert.equal(await fs.readFile(path.join(f.worktreePath, 'file.txt'), 'utf8'), 'issue change\n');
});

test('detects a conflict before modifying the destination, preserving committed work', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'file.txt'), 'main changed\n');
  git(f.cwd, 'commit', '-am', 'Main change');
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'issue changed\n');
  const main = git(f.cwd, 'rev-parse', 'HEAD');
  const result = await issueWorkMerge(await reviewed(f));
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.error, /preserved/);
  assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), main);
  assert.equal(git(f.cwd, 'status', '--porcelain'), '');
  assert.equal(git(f.worktreePath, 'status', '--porcelain'), '');
  assert.equal(git(f.worktreePath, 'log', '-1', '--format=%s'), '[MIN-1] Fix the issue');
  assert.equal(await fs.readFile(path.join(f.worktreePath, 'file.txt'), 'utf8'), 'issue changed\n');
});

test('commit only leaves work isolated, and kept merged work can be cleaned up later', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'fixed\n');
  const commit = await issueWorkCommit(await reviewed(f));
  assert.equal(commit.ok, true, commit.error);
  assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'original\n');
  const result = await issueWorkMerge({ ...await reviewed(f), cleanup: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.worktreeRemoved, false);
  await fs.writeFile(path.join(f.worktreePath, 'another.txt'), 'new work\n');
  const blocked = await issueWorkCleanup({ ...f, sha: result.sha });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /uncommitted/);
  await fs.unlink(path.join(f.worktreePath, 'another.txt'));
  const cleanup = await issueWorkCleanup({ ...f, sha: result.sha });
  assert.equal(cleanup.ok, true, cleanup.error);
  assert.equal(cleanup.worktreeRemoved, true);
});

test('rejects unrelated repositories and a changed destination branch', async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.dir, 'foreign');
  await fs.mkdir(foreign);
  git(foreign, 'init', '-b', 'main');
  const unrelated = await issueWorkInspect({ cwd: f.cwd, worktreePath: foreign });
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.error, /different repository|allowlist/);
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'fixed\n');
  const input = await reviewed(f);
  git(f.cwd, 'checkout', '-b', 'other');
  const switched = await issueWorkMerge(input);
  assert.equal(switched.ok, false);
  assert.match(switched.error, /branch changed/);
});

test('local workspace work can be committed but cannot be merged or cleaned up', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'file.txt'), 'local change\n');
  const input = await reviewed({ cwd: f.cwd });
  const merge = await issueWorkMerge(input);
  assert.equal(merge.ok, false);
  assert.match(merge.error, /isolated/);
  const result = await issueWorkCommit(input);
  assert.equal(result.ok, true, result.error);
  const cleanup = await issueWorkCleanup({ cwd: f.cwd, sha: result.sha });
  assert.equal(cleanup.ok, false);
});

test('detached checkouts can be inspected but cannot be committed or merged', async (t) => {
  const f = await fixture(t);
  git(f.worktreePath, 'checkout', '--detach');
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'detached change\n');
  const snapshot = await issueWorkInspect(f);
  assert.equal(snapshot.ok, true, snapshot.error);
  assert.equal(snapshot.sourceBranch, 'HEAD');
  const input = await reviewed(f);
  assert.match((await issueWorkCommit(input)).error, /branch before committing/);
  assert.match((await issueWorkMerge(input)).error, /named source and destination/);
  assert.equal(await fs.readFile(path.join(f.worktreePath, 'file.txt'), 'utf8'), 'detached change\n');
});

test('cleanup can finish removing a branch after its merged worktree was already removed', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.worktreePath, 'file.txt'), 'fixed\n');
  const merged = await issueWorkMerge({ ...await reviewed(f), cleanup: false });
  assert.equal(merged.ok, true, merged.error);
  git(f.cwd, 'worktree', 'remove', f.worktreePath);
  invalidateRegisteredWorktreeCache();
  const result = await issueWorkCleanup({ ...f, sourceBranch: 'issue/test', sha: merged.sha });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.branchRemoved, true);
  assert.equal(git(f.cwd, 'branch', '--list', 'issue/test'), '');
  assert.equal((await issueWorkCleanup({ ...f, sourceBranch: 'issue/test', sha: merged.sha })).ok, true);
});
