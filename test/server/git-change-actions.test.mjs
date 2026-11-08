import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test } from 'node:test';
import { discard, ignore, stage, status, unstage } from '../../server/git/git-ops.js';

const exec = promisify(execFile);
let cwd;
const git = (...args) => exec('git', args, { cwd, windowsHide: true });
const write = (name, text) => fs.writeFile(path.join(cwd, name), text);
const read = (name) => fs.readFile(path.join(cwd, name), 'utf8');
const absent = (name) => assert.rejects(fs.access(path.join(cwd, name)), { code: 'ENOENT' });

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-change-actions-'));
  await git('init');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

async function baseline() {
  await write('tracked.txt', 'head\n');
  await write('.gitignore', '*.log\n');
  await git('add', '.');
  await git('commit', '-m', 'baseline');
}

test('status expands new folders into individual untracked files, including unusual names', async () => {
  await baseline();
  await fs.mkdir(path.join(cwd, 'new folder/nested'), { recursive: true });
  await write('new folder/a [1].txt', 'new');
  await write('new folder/nested/b.txt', 'new');
  await write('new folder/keep.log', 'ignored');
  const result = await status({ cwd });
  assert.equal(result.ok, true);
  assert.deepEqual(result.untracked.map((item) => item.path), ['new folder/a [1].txt', 'new folder/nested/b.txt']);
});

test('discard handles a mixed folder and tracked selection, preserving ignored and unselected files and staging', async () => {
  await baseline();
  await write('tracked.txt', 'index\n');
  await stage({ cwd, paths: ['tracked.txt'] });
  await write('tracked.txt', 'working\n');
  await fs.mkdir(path.join(cwd, 'new folder'));
  await write('new folder/delete.txt', 'delete');
  await write('new folder/keep.log', 'ignored');
  await write('leave.txt', 'leave');
  const result = await discard({ cwd, paths: ['tracked.txt', 'new folder/'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await read('tracked.txt'), 'index\n');
  assert.equal((await git('show', ':tracked.txt')).stdout, 'index\n');
  await absent('new folder/delete.txt');
  assert.equal(await read('new folder/keep.log'), 'ignored');
  assert.equal(await read('leave.txt'), 'leave');
});

test('discard selected staged changes restores HEAD, removes new files, and reverses renames', async () => {
  await baseline();
  await git('mv', 'tracked.txt', 'renamed.txt');
  await write('new.txt', 'new\n');
  await stage({ cwd, paths: ['renamed.txt', 'new.txt'] });
  const result = await discard({ cwd, paths: ['renamed.txt', 'new.txt'], stagedPaths: ['renamed.txt', 'new.txt'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await read('tracked.txt'), 'head\n');
  await absent('renamed.txt');
  await absent('new.txt');
  assert.equal((await git('status', '--porcelain')).stdout, '');
});

test('selected staged modifications and deletions restore HEAD without affecting other staged files', async () => {
  await baseline();
  await write('other.txt', 'other');
  await write('tracked.txt', 'changed');
  await stage({ cwd, paths: ['other.txt', 'tracked.txt'] });
  let result = await discard({ cwd, paths: ['tracked.txt'], stagedPaths: ['tracked.txt'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await read('tracked.txt'), 'head\n');
  await fs.rm(path.join(cwd, 'tracked.txt'));
  await stage({ cwd, paths: ['tracked.txt'] });
  result = await discard({ cwd, paths: ['tracked.txt'], stagedPaths: ['tracked.txt'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await read('tracked.txt'), 'head\n');
  assert.match((await git('diff', '--cached', '--name-only')).stdout, /other.txt/);
});

test('stage and discard treat wildcard and option-looking filenames literally', async () => {
  await baseline();
  await write('a[1].txt', 'delete');
  await write('a1.txt', 'leave');
  await write('-option.txt', 'new');
  assert.equal((await stage({ cwd, paths: ['-option.txt'] })).ok, true);
  const result = await discard({ cwd, paths: ['a[1].txt'] });
  assert.equal(result.ok, true, result.error);
  await absent('a[1].txt');
  assert.equal(await read('a1.txt'), 'leave');
  assert.match((await git('diff', '--cached', '--name-only')).stdout, /-option.txt/);
});

test('unstage and discard work before the first commit', async () => {
  await write('new.txt', 'new');
  await stage({ cwd, paths: ['new.txt'] });
  assert.equal((await unstage({ cwd, paths: ['new.txt'] })).ok, true);
  assert.equal(await read('new.txt'), 'new');
  await stage({ cwd, paths: ['new.txt'] });
  const result = await discard({ cwd, paths: ['new.txt'], stagedPaths: ['new.txt'] });
  assert.equal(result.ok, true, result.error);
  await absent('new.txt');
});

test('ignore appends escaped exact paths and extension rules once without unstaging tracked files', async () => {
  await baseline();
  await write('literal [1].txt', 'new');
  await write('literal 1.txt', 'leave');
  await write('new.json', '{}');
  await write('tracked.txt', 'staged');
  await stage({ cwd, paths: ['tracked.txt'] });
  const input = { cwd, paths: ['literal [1].txt', 'tracked.txt'], extensions: ['.json'] };
  assert.equal((await ignore(input)).ok, true);
  const first = await read('.gitignore');
  assert.equal((await ignore(input)).ok, true);
  assert.equal(await read('.gitignore'), first);
  assert.match(first, /^\*\.log\n/);
  const result = await status({ cwd });
  assert.ok(result.untracked.some((entry) => entry.path === 'literal 1.txt'));
  assert.ok(!result.untracked.some((entry) => entry.path === 'literal [1].txt' || entry.path === 'new.json'));
  assert.ok(result.staged.some((entry) => entry.path === 'tracked.txt'));
});

test('invalid paths cannot mutate the repo, git metadata, or sibling files', async () => {
  await baseline();
  for (const value of ['../escape', '/tmp/escape', '.', '.git/config', 'folder/../../escape', '']) {
    assert.equal((await discard({ cwd, paths: [value] })).ok, false, value);
    assert.equal((await ignore({ cwd, paths: [value] })).ok, false, value);
  }
  assert.equal((await ignore({ cwd, extensions: ['.ts\n*'] })).ok, false);
  assert.equal(await read('tracked.txt'), 'head\n');
});

test('ignore refuses to write through a .gitignore symlink', { skip: process.platform === 'win32' }, async () => {
  await write('target.txt', 'leave');
  await fs.symlink('target.txt', path.join(cwd, '.gitignore'));
  const result = await ignore({ cwd, paths: ['other.txt'] });
  assert.equal(result.ok, false);
  assert.equal(await read('target.txt'), 'leave');
});

test('unstaging a rename restores both index paths while leaving the working files in place', async () => {
  await baseline();
  await git('mv', 'tracked.txt', 'renamed.txt');
  const result = await unstage({ cwd, paths: ['renamed.txt'] });
  assert.equal(result.ok, true, result.error);
  assert.equal((await git('diff', '--cached', '--name-only')).stdout, '');
  assert.equal(await read('renamed.txt'), 'head\n');
  await absent('tracked.txt');
});

test('discarding a conflicted file restores HEAD and clears only that unmerged path', async () => {
  await baseline();
  const branch = (await git('branch', '--show-current')).stdout.trim();
  await git('checkout', '-b', 'topic');
  await write('tracked.txt', 'topic'); await git('commit', '-am', 'topic');
  await git('checkout', branch);
  await write('tracked.txt', 'main'); await git('commit', '-am', 'main');
  await assert.rejects(git('merge', 'topic'));
  const result = await discard({ cwd, paths: ['tracked.txt'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(await read('tracked.txt'), 'main');
  assert.equal((await git('ls-files', '-u')).stdout, '');
});
