import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { prepareChatExecution } from '../../server/chats/preparation.js';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { await environment?.dispose(); });

test('production preparation permits initial Git setup in the same original project directory', { timeout: 15000 }, async t => {
  let entered, resume;
  const enteredPreparation = new Promise(resolve => { entered = resolve; });
  const continuePreparation = new Promise(resolve => { resume = resolve; });
  const f = await environment.fixture(t, { chats: { coordinator: {} }, respond: () => 'Must not run', runtimeOptions: {
    prepare: async (input, options) => { entered(); await continuePreparation; return prepareChatExecution(input, options); },
  } });
  const admitted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Use the original checkout', clientRequestId: 'bound-checkout' });
  assert.equal(admitted.status, 202); await enteredPreparation;
  try { await promisify(execFile)('git', ['init'], { cwd: f.workspace, windowsHide: true }); }
  finally { resume(); }
  await f.runtime.service.idle('coordinator');
  const result = f.repository.getCommand(admitted.body.receipt.commandId);
  assert.equal(result.state, 'settled');
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.readTranscript('coordinator').messages[0].content, 'Use the original checkout');
});

test('production preparation refuses an unrelated repository replacing the captured linked checkout', { timeout: 20000 }, async t => {
  let entered, resume;
  const enteredPreparation = new Promise(resolve => { entered = resolve; });
  const continuePreparation = new Promise(resolve => { resume = resolve; });
  const f = await environment.fixture(t, { chats: { coordinator: {} }, respond: () => 'Must not run', runtimeOptions: {
    prepare: async (input, options) => { entered(); await continuePreparation; return prepareChatExecution(input, options); },
  } });
  const git = args => promisify(execFile)('git', args, { cwd: f.workspace, windowsHide: true });
  await git(['init']);
  await fs.writeFile(path.join(f.workspace, 'README.md'), 'Original project');
  await git(['add', 'README.md']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
  const checkout = path.join(f.workspace, '.worktrees', 'child');
  await git(['worktree', 'add', '-b', 'child', checkout]);
  f.db.prepare('UPDATE chats SET worktree_root=? WHERE id=?').run(checkout, 'coordinator');
  const admitted = await f.request('/api/chats/coordinator/commands', { action: 'send', text: 'Use the linked checkout', clientRequestId: 'linked-checkout' });
  assert.equal(admitted.status, 202); await enteredPreparation;
  try {
    const gitFile = path.join(checkout, '.git');
    assert.equal((await fs.lstat(gitFile)).isFile(), true);
    await fs.unlink(gitFile);
    await promisify(execFile)('git', ['init'], { cwd: checkout, windowsHide: true });
  } finally { resume(); }
  await f.runtime.service.idle('coordinator');
  const result = f.repository.getCommand(admitted.body.receipt.commandId);
  assert.equal(result.state, 'failed'); assert.equal(result.result.failure.code, 'workspace_denied');
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.readTranscript('coordinator').messages[0].content, 'Use the linked checkout');
});
