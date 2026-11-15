/**
 * Command-scoped attribution in a shared checkout.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withCoordinatedWorktreeMutation } from '../../server/git/action-run-lock.js';
import { captureWorkspaceSnapshot, codeChangeFromCommandSnapshot } from '../../server/tools/workspace-change-snapshot.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { MAX_CODE_CHANGE_DIFF_LINES } from '../../server/tools/line-diff-stats.js';

async function repo(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-diff-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Minnow Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'core.autocrlf', 'false');
  const write = (file, content) => fs.writeFile(path.join(cwd, file), content);
  await write('a.txt', 'base\n');
  await write('b.txt', 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  return { cwd, git, write };
}

test('interleaved chats only record their own command paths, including existing dirty files', async t => {
  const { cwd, write } = await repo(t);
  await write('a.txt', 'base\nchat A\n');
  const before = await captureWorkspaceSnapshot(cwd);
  await write('b.txt', 'base\nchat B\n');
  const change = await codeChangeFromCommandSnapshot(cwd, before);
  assert.deepEqual(change?.paths, ['b.txt']);
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 0);
  assert.deepEqual(change.files.map(f => [f.path, f.additions, f.deletions]), [['b.txt', 1, 0]]);
  assert.deepEqual(change.files[0].diffLines.filter(l => l.type === 'add').map(l => l.text), ['chat B']);
});

test('same-size replacements and reverts in a shared file are not lost to aggregate subtraction', async t => {
  const { cwd, write } = await repo(t);
  await write('a.txt', 'chat A\n');
  const before = await captureWorkspaceSnapshot(cwd);
  await write('a.txt', 'chat B\n');
  const change = await codeChangeFromCommandSnapshot(cwd, before);
  assert.deepEqual(change?.paths, ['a.txt']);
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.deepEqual(change.files[0].diffLines, [{ type: 'remove', text: 'chat A' }, { type: 'add', text: 'chat B' }]);
  const beforeRevert = await captureWorkspaceSnapshot(cwd);
  await write('a.txt', 'base\n');
  const revert = await codeChangeFromCommandSnapshot(cwd, beforeRevert);
  assert.equal(revert?.additions, 1);
  assert.equal(revert?.deletions, 1);
});

test('concurrent chat effects are attributed separately under the shared checkout boundary', async t => {
  const { cwd, write, git } = await repo(t);
  await write('staged.txt', 'user staged\n'); git('add', 'staged.txt');
  const indexPath = path.resolve(cwd, git('rev-parse', '--git-path', 'index').trim());
  const indexBefore = await fs.readFile(indexPath);
  const effect = (file, content) => withCoordinatedWorktreeMutation(cwd, async () => {
    const before = await captureWorkspaceSnapshot(cwd);
    await write(file, content);
    return codeChangeFromCommandSnapshot(cwd, before);
  });
  const [a, b] = await Promise.all([effect('a.txt', 'base\nA\n'), effect('b.txt', 'base\nB\n')]);
  assert.deepEqual(a?.paths, ['a.txt']);
  assert.deepEqual(b?.paths, ['b.txt']);
  assert.deepEqual(await fs.readFile(indexPath), indexBefore, 'attribution never changes the user index');
});

test('untracked creation, deletion and read-only commands do not borrow other chat changes', async t => {
  const { cwd, write } = await repo(t);
  await write('a.txt', 'base\nother chat\n');
  const before = await captureWorkspaceSnapshot(cwd);
  assert.equal(await codeChangeFromCommandSnapshot(cwd, before), undefined);
  await write('new.txt', 'new\n');
  await fs.unlink(path.join(cwd, 'b.txt'));
  const change = await codeChangeFromCommandSnapshot(cwd, before);
  assert.deepEqual(new Set(change?.paths), new Set(['new.txt', 'b.txt']));
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.equal(await codeChangeFromCommandSnapshot(cwd, null), undefined, 'missing baseline is not the whole workspace');
});

test('real tool dispatch isolates overlapping chat commands and a following read-only command', async t => {
  const { cwd, write } = await repo(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-diff-home-'));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  t.after(async () => {
    closeSessionsDb();
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true });
  });
  const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
  await write('user.txt', 'pre-existing user edit\n');
  const command = code => `"${process.execPath}" -e "${code}"`;
  const effect = (chatId, file) => executeServerTool('execute_command', {
    command: command(`require('node:fs').appendFileSync('${file}', '${chatId}\\n')`),
  }, { workspaceRoot: cwd, activityChatId: chatId, shellSandboxMode: 'off' });
  const [a, b] = await Promise.all([effect('chat-a', 'a.txt'), effect('chat-b', 'b.txt')]);
  assert.deepEqual(a.codeChange?.paths, ['a.txt'], a.result);
  assert.deepEqual(b.codeChange?.paths, ['b.txt'], b.result);
  assert.equal(a.codeChange.gitBranch, 'main');
  assert.equal(b.codeChange.workspacePath, cwd);
  const read = await executeServerTool('execute_command', { command: command('console.log(123)') },
    { workspaceRoot: cwd, activityChatId: 'chat-reader', shellSandboxMode: 'off' });
  assert.doesNotMatch(read.result, /^Error:/);
  assert.equal(read.codeChange, undefined);
});

test('subdirectory snapshots retain relative literal filenames and exclude sibling edits', async t => {
  const { cwd, write } = await repo(t);
  const nested = path.join(cwd, 'nested'); await fs.mkdir(nested);
  const before = await captureWorkspaceSnapshot(nested);
  await write('a.txt', 'sibling change\n');
  const name = 'space [file] ü.txt';
  await fs.writeFile(path.join(nested, name), 'own change\n');
  const change = await codeChangeFromCommandSnapshot(nested, before);
  assert.deepEqual(change?.paths, [name]);
  assert.deepEqual(change.files[0].diffLines, [{ type: 'add', text: 'own change' }]);
});

test('unborn repositories work without creating a real index or requiring a commit', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-diff-unborn-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  assert.equal(await captureWorkspaceSnapshot(cwd), null);
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  const before = await captureWorkspaceSnapshot(cwd);
  await fs.writeFile(path.join(cwd, 'new.txt'), 'first\n');
  assert.deepEqual((await codeChangeFromCommandSnapshot(cwd, before))?.paths, ['new.txt']);
  await assert.rejects(fs.access(path.join(cwd, '.git', 'index')), { code: 'ENOENT' });
});

test('multi-file recorded command diffs share one payload budget without losing exact counts', async t => {
  const { cwd, write } = await repo(t);
  const before = await captureWorkspaceSnapshot(cwd);
  await write('a.txt', 'A\n'.repeat(MAX_CODE_CHANGE_DIFF_LINES + 10));
  await write('b.txt', 'B\n'.repeat(10));
  const change = await codeChangeFromCommandSnapshot(cwd, before);
  assert.equal(change.additions, MAX_CODE_CHANGE_DIFF_LINES + 20);
  assert.equal(change.deletions, 2);
  assert.equal(change.files.reduce((n, f) => n + (f.diffLines?.length ?? 0), 0), MAX_CODE_CHANGE_DIFF_LINES);
  assert.equal(change.files[0].diffTruncated, true);
  assert.equal(change.files[1].diffTruncated, true);
});

const { parseGitNumstat } = await import(
  '../../server/tools/workspace-change-snapshot.js'
);

describe('workspace-change-snapshot', () => {
  test('re-exports parseGitNumstat', () => {
    assert.equal(parseGitNumstat('1\t0\ta.ts').additions, 1);
  });
});
