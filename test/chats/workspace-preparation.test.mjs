import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatContext } from '../../server/chats/context.js';
import { createChatWorkspacePreparation } from '../../server/chats/workspace-preparation.js';
import { rebindChatWorkspacePolicy } from '../../server/chats/workspace-preparation.js';
import { enableChatWorktree } from '../../server/worktree/worktree-ops.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';

const exec = promisify(execFile);
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-canonical-workspace-')));
  const repo = path.join(root, 'repo'), previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(root, 'home'); resetMinnowHomeCache();
  const git = (args, cwd = repo) => exec('git', args, { cwd, windowsHide: true });
  await fs.mkdir(repo);
  await git(['init']); await git(['config', 'user.email', 'test@example.com']); await git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(repo, 'file.txt'), 'committed');
  if (options.dependencyFailure || options.installScript) await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'canonical-setup-test', version: '1.0.0', private: true,
    scripts: { install: options.installScript ?? 'node -e "console.error(\'canonical fixture dependency failure\'); process.exit(1)"' },
  }));
  await git(['add', '.']); await git(['commit', '-m', 'initial']);
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'ordinary', name: 'Fix setup', workspacePath: repo, modeId: 'build',
    providerId: 'fixture', modelId: 'fixture', worktreeEnabled: true });
  const context = createChatContext({ repository, validateRoot: async () => {},
    resolvePolicyInput: async (_chat, _scope, registry) => ({ modeId: 'build', fileWriteScope: 'workspace',
      workspaceIds: registry.entries.map(row => row.workspaceId),
      toolPermissions: { read_file: 'full', save_file: 'full' }, capabilities: ['chat.send', 'chat.read', 'execution.host'] }) });
  let setupCalls = 0, sequence = 0;
  const makeAdapter = extra => createChatWorkspacePreparation({ repository, context,
    enableWorktree: args => { setupCalls++; return (options.enableWorktree ?? enableChatWorktree)(args); }, ...extra });
  let adapter = makeAdapter();
  async function admit() {
    const target = await context.resolveTarget('ordinary');
    const intent = await adapter.capture(target);
    const commandId = 'command-' + (++sequence);
    const command = { version: 1, commandId, chatId: 'ordinary', kind: 'send', message: 'Test setup', mode: 'auto',
      requestedAt: Date.now(), clientRequestId: commandId, modelSelection: { providerId: 'fixture', modelId: 'fixture' },
      provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message', commandId, causalRootId: commandId } };
    repository.atomic(() => {
      adapter.admit('ordinary', intent);
      repository.admitCommand(command, { producerId: 'fixture', requestKey: commandId, captured: {
        workspacePreparation: intent, scope: target.scope, projectId: target.scope.projectId,
        checkoutIdentity: target.checkoutIdentity, cancellationEpoch: repository.getCancellationEpoch('ordinary'), policy: target.policy,
      } });
      repository.updateCommand(commandId, { state: 'queued' });
    });
    return command;
  }
  function reserve(command) {
    const captured = repository.getCommand(command.commandId).captured;
    const executionId = 'execution-' + (++sequence);
    repository.createExecution({ executionId, chatId: command.chatId, commandId: command.commandId, captured });
    const fence = repository.claimExecution({ executionId, chatId: command.chatId, ownerId: 'fixture', leaseMs: 120000 });
    repository.updateCommand(command.commandId, { state: 'running', executionId });
    return { command, execution: repository.getExecution(executionId), fence };
  }
  function release(input, status = 'failed') {
    repository.updateExecution(input.execution.executionId, { status }, { fence: input.fence });
    repository.updateCommand(input.command.commandId, { state: status === 'completed' ? 'settled' : 'failed' });
    repository.releaseLease('ordinary', input.fence);
  }
  t.after(async () => {
    db.close();
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache(); await fs.rm(root, { force: true, recursive: true });
  });
  return { root, repo, git, db, repository, context, admit, reserve, release, setupCalls: () => setupCalls,
    get adapter() { return adapter; }, reload(extra) { adapter = makeAdapter(extra); return adapter; } };
}

test('durable intent precedes allocation; concurrent sends share one verified final checkout', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'user edits');
  const first = await f.admit(), second = await f.admit();
  const intent = f.repository.getCommand(first.commandId).captured.workspacePreparation;
  assert.equal(f.repository.getCommand(second.commandId).captured.workspacePreparation.id, intent.id);
  assert.equal(f.adapter.read('ordinary').status, 'pending');
  await assert.rejects(fs.access(intent.slotPath));
  const input = f.reserve(first);
  const [one, duplicate] = await Promise.all([f.adapter.prepare(input), f.adapter.prepare(input)]);
  assert.equal(one.execution.executionId, duplicate.execution.executionId);
  assert.equal(f.setupCalls(), 1);
  assert.equal(one.target.chat.worktreeRoot, intent.slotPath);
  assert.notEqual(one.execution.captured.scope.canonicalKey, input.execution.captured.scope.canonicalKey);
  assert.equal(one.execution.captured.checkoutIdentity, one.target.checkoutIdentity);
  assert.ok(one.execution.captured.policy.workspaceIds.includes(one.target.scope.workspaceId));
  assert.equal(one.execution.captured.policy.toolPermissions.save_file, 'full');
  assert.equal(await fs.readFile(path.join(intent.slotPath, 'file.txt'), 'utf8'), 'committed');
  assert.equal(await fs.readFile(path.join(f.repo, 'file.txt'), 'utf8'), 'user edits');
  // The first model turn can commit without changing its execution checkout.
  await fs.writeFile(path.join(intent.slotPath, 'turn-one.txt'), 'first turn result');
  await f.git(['add', 'turn-one.txt'], intent.slotPath);
  await f.git(['commit', '-m', 'first model turn commit'], intent.slotPath);
  f.release(input, 'completed');
  const queued = f.reserve(second), prepared = await f.reload().prepare(queued);
  assert.equal(prepared.target.chat.worktreeRoot, intent.slotPath);
  assert.equal(await fs.readFile(path.join(intent.slotPath, 'turn-one.txt'), 'utf8'), 'first turn result');
  assert.equal(f.setupCalls(), 1, 'ready setup is not reinstalled for the next queued send');
  f.release(queued, 'completed');
});

test('real dependency failure blocks inference and retry after reload reuses exact allocation', async t => {
  const f = await fixture(t, { dependencyFailure: true });
  const command = await f.admit(), input = f.reserve(command);
  let inferenceCalls = 0;
  await assert.rejects(f.adapter.prepare(input).then(() => { inferenceCalls++; }), /canonical fixture dependency failure/);
  assert.equal(inferenceCalls, 0);
  const state = f.adapter.read('ordinary');
  assert.equal(state.status, 'failed');
  assert.ok(state.binding?.checkoutIdentity, 'identity is saved BEFORE the failing installer');
  assert.equal(f.repository.getChat('ordinary').worktreeRoot, '');
  assert.equal(f.repository.getChat('ordinary').worktreeSetupRequired, true);
  f.release(input);
  await fs.writeFile(path.join(state.binding.path, 'package.json'), JSON.stringify({ name: 'repaired', version: '1.0.0', private: true }));
  await fs.writeFile(path.join(state.binding.path, 'keep.txt'), 'preserve retry work');
  f.reload();
  const retry = f.reserve(await f.admit()), prepared = await f.adapter.prepare(retry);
  assert.equal(prepared.target.chat.worktreeRoot, state.binding.path);
  assert.equal(prepared.target.checkoutIdentity, state.binding.checkoutIdentity);
  assert.equal(await fs.readFile(path.join(state.binding.path, 'keep.txt'), 'utf8'), 'preserve retry work');
  f.release(retry, 'completed');
});

test('Stop during dependency preparation retains the exact checkout for an explicit retry', async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { enableWorktree: async args => enableChatWorktree({ ...args,
    onCheckout: async result => {
      await args.onCheckout(result); started();
      await new Promise((resolve, reject) => {
        args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true });
      });
    } }) });
  const input = f.reserve(await f.admit()), controller = new AbortController();
  const pending = f.adapter.prepare({ ...input, signal: controller.signal });
  await entered;
  const retained = f.adapter.read('ordinary').binding;
  assert.ok(retained);
  controller.abort(new DOMException('Stopped fixture setup', 'AbortError'));
  await assert.rejects(pending, /Stopped fixture setup/);
  assert.equal(f.adapter.read('ordinary').status, 'cancelled');
  assert.equal(f.repository.getChat('ordinary').worktreeRoot, '');
  f.release(input);
  const adapter = f.reload({ enableWorktree: enableChatWorktree });
  const retry = f.reserve(await f.admit()), prepared = await adapter.prepare(retry);
  assert.equal(prepared.target.checkoutIdentity, retained.checkoutIdentity);
  f.release(retry, 'completed');
});

test('source branch changes and unconfirmed slot folders fail before setup or inference', async t => {
  const f = await fixture(t);
  const command = await f.admit(), input = f.reserve(command);
  await f.git(['checkout', '-b', 'different-source']);
  await assert.rejects(f.adapter.prepare(input), error => error.code === 'workspace_denied');
  assert.equal(f.setupCalls(), 0);
  f.release(input);
  await f.git(['checkout', f.adapter.read('ordinary').intent.source.branch]);
  const slot = f.adapter.read('ordinary').intent.slotPath;
  await fs.mkdir(slot, { recursive: true }); await fs.writeFile(path.join(slot, 'keep.txt'), 'do not overwrite');
  const retry = f.reserve(await f.admit());
  await assert.rejects(f.adapter.prepare(retry), error => error.code === 'recovery_required');
  assert.equal(await fs.readFile(path.join(slot, 'keep.txt'), 'utf8'), 'do not overwrite');
  assert.equal(f.setupCalls(), 0);
  f.release(retry);
});

test('replacement of an allocated checkout cannot inherit the failed setup binding', async t => {
  const f = await fixture(t, { enableWorktree: async args => {
    const result = await enableChatWorktree(args);
    return { ...result, ok: false, error: 'controlled dependency failure' };
  } });
  const input = f.reserve(await f.admit());
  await assert.rejects(f.adapter.prepare(input), /controlled dependency failure/);
  const { binding } = f.adapter.read('ordinary');
  f.release(input);
  await fs.rename(binding.path, binding.path + '-original');
  await fs.mkdir(binding.path); await fs.writeFile(path.join(binding.path, 'keep.txt'), 'replacement');
  const retry = f.reserve(await f.admit());
  await assert.rejects(f.reload().prepare(retry), error => error.code === 'workspace_denied');
  assert.equal(f.setupCalls(), 1, 'replacement is rejected before any dependency command');
  assert.equal(await fs.readFile(path.join(binding.path, 'keep.txt'), 'utf8'), 'replacement');
  f.release(retry);
});

test('Local is explicit, refuses active ownership, cancels unstarted automatic inputs and keeps files', async t => {
  const f = await fixture(t);
  const first = await f.admit(), queued = await f.admit(), input = f.reserve(first);
  await f.adapter.prepare(input);
  const state = f.adapter.read('ordinary');
  assert.throws(() => f.adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id }),
    error => error.code === 'ownership_conflict');
  f.release(input, 'completed');
  assert.throws(() => f.adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: 'stale' }),
    error => error.code === 'stale_revision');
  const local = f.adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  assert.equal(local.worktreeRoot, '');
  assert.equal(local.worktreeSetupRequired, false);
  assert.equal(f.repository.getCommand(queued.commandId).state, 'cancelled');
  await fs.access(path.join(state.binding.path, '.git'));
  assert.equal(await f.adapter.capture(await f.context.resolveTarget('ordinary')), null);
});

test('stale execution fences cannot bind a completed setup or change a later Local choice', async t => {
  const f = await fixture(t);
  const input = f.reserve(await f.admit());
  f.release(input);
  await assert.rejects(f.adapter.prepare(input), error => error.code === 'ownership_conflict');
  assert.equal(f.setupCalls(), 0);
  assert.equal(f.adapter.read('ordinary').status, 'pending');
});

test('explicit Retry owns setup only and does not replay the failed inference command', async t => {
  const f = await fixture(t, { enableWorktree: async args => {
    const result = await enableChatWorktree(args);
    return { ...result, ok: false, error: 'repair dependencies first' };
  } });
  const input = f.reserve(await f.admit());
  await assert.rejects(f.adapter.prepare(input), /repair dependencies first/);
  const failed = f.adapter.read('ordinary');
  f.release(input);
  const adapter = f.reload({ enableWorktree: enableChatWorktree });
  const [one, duplicate] = await Promise.all([
    adapter.retry({ chatId: 'ordinary', expectedIntentId: failed.intent.id }),
    adapter.retry({ chatId: 'ordinary', expectedIntentId: failed.intent.id }),
  ]);
  assert.equal(one.worktreeRoot, failed.binding.path);
  assert.equal(duplicate.worktreeRoot, failed.binding.path);
  assert.equal(f.repository.getCommand(input.command.commandId).state, 'failed', 'Retry is not inference or command replay');
  assert.equal(f.repository.readTranscript('ordinary').messages.length, 0);
  assert.equal(f.repository.getLease('ordinary').state, 'released');
  assert.equal(f.repository.getLatestExecution('ordinary').captured.workspaceSetupOnly, true);
  assert.equal((await adapter.retry({ chatId: 'ordinary', expectedIntentId: failed.intent.id })).worktreeRoot, failed.binding.path);
});

test('workspace policy rebinding preserves restrictions and cannot grant an unauthorized source', () => {
  const policy = { modeId: 'plan', workspaceIds: ['source'], fileWriteScope: 'plans',
    toolPermissions: { read_file: 'ask', execute_command: 'off' }, capabilities: ['chat.read'] };
  const rebound = rebindChatWorkspacePolicy(policy, { sourceWorkspaceId: 'source', workspaceId: 'isolated' });
  assert.deepEqual(rebound.workspaceIds, ['isolated']);
  assert.equal(rebound.modeId, 'plan');
  assert.equal(rebound.fileWriteScope, 'plans');
  assert.equal(rebound.toolPermissions.read_file, 'full');
  assert.equal(rebound.toolPermissions.execute_command, 'off');
  assert.throws(() => rebindChatWorkspacePolicy(policy, { sourceWorkspaceId: 'foreign', workspaceId: 'isolated' }),
    error => error.code === 'workspace_denied');
});

test('cancellation kills a real dependency subprocess before it can finish writing', async t => {
  const f = await fixture(t, { installScript: 'node -e "require(\'fs\').writeFileSync(\'installer-started\',\'yes\');setTimeout(()=>require(\'fs\').writeFileSync(\'installer-finished\',\'bad\'),3000)"' });
  const input = f.reserve(await f.admit()), controller = new AbortController();
  const slot = f.adapter.read('ordinary').intent.slotPath;
  const pending = f.adapter.prepare({ ...input, signal: controller.signal });
  const deadline = Date.now() + 15000;
  while (await fs.access(path.join(slot, 'installer-started')).then(() => false, () => true)) {
    if (Date.now() > deadline) { controller.abort(); await pending.catch(() => {}); assert.fail('Scratch installer did not start'); }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  controller.abort(new DOMException('Cancel actual dependency install', 'AbortError'));
  await assert.rejects(pending, /Cancel actual dependency install|abort/i);
  assert.equal(f.adapter.read('ordinary').status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 3300));
  await assert.rejects(fs.access(path.join(slot, 'installer-finished')));
  assert.ok(f.adapter.read('ordinary').binding);
  f.release(input);
});
