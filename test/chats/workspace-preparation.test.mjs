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
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';
import { issueWorkInspect, issueWorkMerge } from '../../server/git/issue-work-ops.js';
import { checkoutSwitch } from '../../server/git/checkout-switch.js';
import { worktreeRemove } from '../../server/git/git-ops.js';
import { MIRROR_MANIFEST } from '../../server/worktree/multi-repo.js';

const exec = promisify(execFile);
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-canonical-workspace-')));
  const repo = path.join(root, 'repo'), previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(root, 'home'); resetMinnowHomeCache();
  const git = (args, cwd = repo) => exec('git', args, { cwd, windowsHide: true });
  await fs.mkdir(repo);
  const repos = options.multiRepo ? [['backend', 'main'], ['apps/frontend', 'develop']] : [['.', 'main']];
  for (const [location, branch] of options.fresh ? [] : repos) {
    const cwd = path.join(repo, location);
    await fs.mkdir(cwd, { recursive: true });
    await git(['init', '-b', branch], cwd);
    await git(['config', 'user.email', 'test@example.com'], cwd);
    await git(['config', 'user.name', 'Test'], cwd);
    await fs.writeFile(path.join(cwd, 'file.txt'), 'committed');
    if (options.dependencyFailure || options.installScript) await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'canonical-setup-test', version: '1.0.0', private: true,
      scripts: { install: options.installScript ?? 'node -e "console.error(\'canonical fixture dependency failure\'); process.exit(1)"' },
    }));
    await git(['add', '.'], cwd); await git(['commit', '-m', 'initial'], cwd);
  }
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
  async function admit(options) {
    const target = await context.resolveTarget('ordinary');
    const intent = await adapter.capture(target, undefined, options);
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

test('an unborn branch keeps one initial commit when factory setup resumes after interruption', async t => {
  let interrupted = false;
  const f = await fixture(t, { fresh: true, enableWorktree(args) {
    if (interrupted) return enableChatWorktree(args);
    interrupted = true;
    throw new Error('interrupted before allocating worktree');
  } });
  await f.git(['init', '-b', 'develop']);
  await fs.writeFile(path.join(f.repo, '.gitignore'), 'private.txt\n');
  await fs.writeFile(path.join(f.repo, 'private.txt'), 'ignored');
  await fs.writeFile(path.join(f.repo, 'file.txt'), 'project');
  const first = f.reserve(await f.admit({ factory: true }));
  const queued = await f.admit();
  await assert.rejects(f.git(['rev-parse', '--verify', 'HEAD']));
  await assert.rejects(f.adapter.prepare(first), /interrupted before allocating/);
  f.release(first);
  const head = (await f.git(['rev-parse', 'HEAD'])).stdout.trim();
  const next = f.reserve(queued);
  const ready = await f.reload().prepare(next);
  f.release(next, 'completed');
  assert.equal(ready.target.chat.workspacePreparation.intent.source.head, head);
  assert.equal((await f.git(['branch', '--show-current'])).stdout.trim(), 'develop');
  assert.equal((await f.git(['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
  const checkout = ready.target.chat.worktreeRoot;
  assert.equal(await fs.readFile(path.join(checkout, 'file.txt'), 'utf8'), 'project');
  assert.equal(await fs.readFile(path.join(f.repo, '.gitignore'), 'utf8'), 'private.txt\n');
  assert.equal((await f.git(['show', 'HEAD:.gitignore'], checkout)).stdout.trim(), 'private.txt');
  await assert.rejects(fs.access(path.join(checkout, 'private.txt')), { code: 'ENOENT' });
});

test('factory admission leaves a fresh directory alone and cannot initialize its replacement', async t => {
  const f = await fixture(t, { fresh: true });
  const input = f.reserve(await f.admit({ factory: true }));
  await assert.rejects(fs.access(path.join(f.repo, '.git')), { code: 'ENOENT' });
  await fs.rename(f.repo, path.join(f.root, 'original'));
  await fs.mkdir(f.repo);
  await assert.rejects(f.adapter.prepare(input), /workspace or its repository changed/);
  await assert.rejects(fs.access(path.join(f.repo, '.git')), { code: 'ENOENT' });
  f.release(input);
});

test('an ordinary chat uses both registered checkouts and can deliver each repo to its original branch', async t => {
  const f = await fixture(t, { multiRepo: true });
  const original = await f.context.resolveTarget('ordinary');
  const first = f.reserve(await f.admit()), queued = await f.admit();
  const ready = await f.adapter.prepare(first);
  const mirror = ready.target.chat.worktreeRoot;
  assert.equal(ready.target.scope.projectId, original.scope.projectId);
  assert.equal((await f.context.humanCaller('ordinary', { workspacePath: f.repo })).target.scope.workspaceId, ready.target.scope.workspaceId);
  assert.equal((await f.context.executionCaller(first.execution.executionId)).target.scope.workspaceId, ready.target.scope.workspaceId);
  await assert.rejects(f.context.humanCaller('ordinary', { workspacePath: path.join(f.repo, 'backend') }), /outside the active project/);
  assert.deepEqual(ready.target.chat.workspacePreparation.binding.repos.map(repo => repo.id), ['apps/frontend', 'backend']);
  const tool = async (name, args) => String((await executeServerTool(name, args, {
    workspaceRoot: ready.target.scope.canonicalKey, filesystemAccessCeiling: 'workspace',
  })).result);
  for (const id of ['backend', 'apps/frontend']) {
    assert.doesNotMatch(await tool('save_file', { path: `${id}/chat.txt`, content: `${id} chat change\n` }), /^Error/);
    assert.match(await tool('read_file', { path: `${id}/chat.txt` }), /chat change/);
    assert.match(await tool('git_status', { repo: id }), /chat\.txt/);
    assert.doesNotMatch(await tool('git_add', { paths: [`${id}/chat.txt`] }), /^Error/);
    assert.doesNotMatch(await tool('git_commit', { repo: id, message: `Update ${id}` }), /^Error/);
    await assert.rejects(fs.access(path.join(f.repo, id, 'chat.txt')));
  }
  assert.match(await tool('git_status', {}), /several repos/);
  const child = path.join(mirror, 'backend');
  assert.equal((await checkoutSwitch({ cwd: child, branch: 'new-work', create: true })).ok, false);
  assert.equal((await worktreeRemove({ cwd: path.join(f.repo, 'backend'), path: child, force: true })).ok, false);
  f.release(first, 'completed');
  const next = f.reserve(queued);
  await f.reload().prepare(next);
  f.release(next, 'completed');
  assert.equal(f.setupCalls(), 1);

  const frontend = path.join(f.repo, 'apps/frontend');
  await f.git(['switch', '-c', 'another-task'], frontend);
  const inProject = fn => runWithViewWorkspace(f.repo, fn);
  for (const [repoId, branch] of [['backend', 'main'], ['apps/frontend', 'develop']]) {
    const input = { cwd: f.repo, mirror: { chatId: 'ordinary', repoId } };
    const review = await inProject(() => issueWorkInspect(input));
    assert.equal(review.ok, true, review.error);
    assert.equal(review.targetBranch, branch);
    assert.equal(review.ahead, 1);
    const landed = await inProject(() => issueWorkMerge({ ...review, ...input, cleanup: true }));
    assert.equal(landed.ok, true, landed.error);
    assert.equal(landed.repoId, repoId);
    assert.ok(landed.mergeSha);
    assert.match((await f.git(['show', `${branch}:chat.txt`], path.join(f.repo, repoId))).stdout, /chat change/);
    if (repoId === 'backend') await assert.rejects(f.git(['show', 'develop:chat.txt'], frontend));
  }
  assert.equal((await f.git(['branch', '--show-current'], frontend)).stdout.trim(), 'another-task');
  await assert.rejects(fs.access(path.join(frontend, 'chat.txt')));
  assert.equal((await f.context.resolveTarget('ordinary')).chat.worktreeRoot, mirror, 'both checkouts stay bound after merge');

  // A conflicted rebase detaches Git's HEAD while retaining the chat branch.
  // The chat can still edit its copy to resolve the conflict.
  const backend = path.join(f.repo, 'backend');
  for (const [cwd, content] of [[backend, 'destination change'], [child, 'chat change']]) {
    await fs.writeFile(path.join(cwd, 'file.txt'), content);
    await f.git(['commit', '-am', content], cwd);
  }
  await assert.rejects(f.git(['rebase', 'main'], child), /CONFLICT|could not apply/);
  assert.equal((await f.context.resolveTarget('ordinary')).chat.worktreeRoot, mirror);
  await f.git(['rebase', '--abort'], child);

  const manifestPath = path.join(mirror, MIRROR_MANIFEST);
  const originalManifest = await fs.readFile(manifestPath, 'utf8');
  const replaced = JSON.parse(originalManifest);
  replaced.repos[0].worktreePath = replaced.repos[1].worktreePath;
  await fs.writeFile(manifestPath, JSON.stringify(replaced));
  await assert.rejects(f.context.resolveTarget('ordinary'), /no longer matches apps\/frontend/);
  const intentId = ready.target.chat.workspacePreparation.intent.id;
  const { caller } = await f.context.humanCaller('ordinary', { workspacePath: f.repo, workspaceRecovery: true });
  await f.adapter.applyChoice(caller, { chatId: 'ordinary', action: 'local', expectedIntentId: intentId });
  assert.equal((await f.context.resolveTarget('ordinary')).scope.workspaceId, original.scope.workspaceId);
  await fs.writeFile(manifestPath, originalManifest);
  assert.equal((await f.adapter.retry({ chatId: 'ordinary', expectedIntentId: intentId })).worktreeRoot, mirror);
});

test('durable intent precedes allocation; concurrent sends share one verified final checkout', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, '.git', 'info', 'exclude'), '.env\n');
  await fs.writeFile(path.join(f.repo, '.env'), 'FIXTURE=canonical-local\n');
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
  assert.equal(await fs.readFile(path.join(intent.slotPath, '.env'), 'utf8'), 'FIXTURE=canonical-local\n');
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

test('Local can return to its verified ready worktree after reload without replay or setup', async t => {
  const f = await fixture(t);
  const input = f.reserve(await f.admit());
  await f.adapter.prepare(input);
  const state = f.adapter.read('ordinary');
  await fs.writeFile(path.join(state.binding.path, 'keep.txt'), 'retained edits');
  await f.git(['add', 'keep.txt'], state.binding.path);
  await f.git(['commit', '-m', 'later work'], state.binding.path);
  f.release(input, 'completed');
  f.adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  const adapter = f.reload();
  const localInput = f.reserve(await f.admit());
  await assert.rejects(adapter.retry({ chatId: 'ordinary', expectedIntentId: state.intent.id }),
    error => error.code === 'ownership_conflict');
  f.release(localInput, 'completed');
  const restored = await adapter.retry({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  assert.equal(restored.worktreeRoot, state.binding.path);
  assert.equal(restored.workspacePreparation.status, 'ready');
  assert.equal(f.setupCalls(), 1);
  assert.equal(f.repository.getCommand(input.command.commandId).state, 'settled');
  assert.equal(await fs.readFile(path.join(state.binding.path, 'keep.txt'), 'utf8'), 'retained edits');
  adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  // Conversations detached before retainedReady shipped recover from their
  // already-rebound execution, not an assumption that every binding is ready.
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_remove(meta_json, '$.workspacePreparation.retainedReady') WHERE chat_id=?").run('ordinary');
  assert.equal((await f.reload().retry({ chatId: 'ordinary', expectedIntentId: state.intent.id })).worktreeRoot, state.binding.path);
  adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  await f.git(['checkout', '-b', 'changed-branch'], state.binding.path);
  await assert.rejects(adapter.retry({ chatId: 'ordinary', expectedIntentId: state.intent.id }),
    error => error.code === 'workspace_denied');
  assert.equal(f.repository.getChat('ordinary').worktreeRoot, '');
  assert.equal(adapter.read('ordinary').status, 'local');
});

test('Local cannot reattach a retained allocation whose dependencies never finished', async t => {
  const f = await fixture(t, { enableWorktree: async args => {
    const result = await enableChatWorktree(args);
    return { ...result, ok: false, error: 'unfinished dependencies' };
  } });
  const input = f.reserve(await f.admit());
  await assert.rejects(f.adapter.prepare(input), /unfinished dependencies/);
  f.release(input);
  const state = f.adapter.read('ordinary');
  f.adapter.chooseLocal({ chatId: 'ordinary', expectedIntentId: state.intent.id });
  await assert.rejects(f.reload().retry({ chatId: 'ordinary', expectedIntentId: state.intent.id }),
    error => error.code === 'recovery_required');
  assert.equal(f.repository.getChat('ordinary').worktreeRoot, '');
  assert.equal(f.setupCalls(), 1);
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
