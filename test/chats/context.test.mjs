import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createChatContext, loadChatProjectRegistry, readChatCheckoutIdentity } from '../../server/chats/context.js';
import { assertCaller, assertExecutionCaller } from '../../server/chats/caller.js';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['main', 'child', 'other', 'common', 'other-common'].map(name => [name, path.join(root, name)]));
  await Promise.all(Object.values(dirs).map(dir => fs.mkdir(dir)));
  const runGit = async (args, cwd) => {
    if (args[0] === 'worktree') return { code: 0, stdout: `worktree ${dirs.main}\0\0worktree ${dirs.child}\0\0worktree ${dirs.other}\0\0` };
    return { code: 0, stdout: cwd === dirs.other ? dirs['other-common'] : dirs.common };
  };
  const validateRoot = async value => { assert.equal(path.resolve(value), dirs.main); };
  return { dirs, runGit, validateRoot };
}

test('project membership uses real git registration and excludes a replaced unrelated checkout', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  const project = await loadChatProjectRegistry(dirs.main, { validateRoot, runGit });
  assert.equal(project.registry.entries.length, 2);
  assert.equal(new Set(project.registry.entries.map(row => row.projectId)).size, 1);
  assert.ok(project.registry.entries.some(row => row.canonicalKey.toLowerCase() === dirs.child.toLowerCase()));
  assert.ok(!project.registry.entries.some(row => row.canonicalKey.toLowerCase() === dirs.other.toLowerCase()));
  await assert.rejects(loadChatProjectRegistry(dirs.other, { validateRoot, runGit }));
});

test('checkout verification overlaps bounded reads and preserves order with unavailable siblings', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  const siblings = await Promise.all(Array.from({ length: 9 }, async (_, i) => {
    const dir = path.join(path.dirname(dirs.main), `sibling-${i}`);
    await fs.mkdir(dir);
    return dir;
  }));
  const listed = [dirs.main, ...siblings, dirs.other, path.join(dirs.main, 'absent')];
  let active = 0, peak = 0, verified = 0;
  const concurrentGit = async (args, cwd) => {
    if (args[0] === 'worktree') return { code: 0, stdout: listed.map(dir => `worktree ${dir}\0\0`).join('') };
    active++; peak = Math.max(peak, active); verified++;
    try {
      await new Promise(resolve => setTimeout(resolve, cwd === dirs.main ? 20 : 5));
      return await runGit(args, cwd);
    } finally { active--; }
  };
  const context = createChatContext({ repository: {}, runGit: concurrentGit, validateRoot, resolvePolicyInput: async () => ({}) });
  for (let attempt = 0; attempt < 2; attempt++) {
    verified = 0;
    const project = await context.project(dirs.main);
    assert.deepEqual(project.registry.entries.map(row => row.canonicalKey), [dirs.main, ...siblings]
      .map(dir => process.platform === 'win32' ? dir.toLowerCase() : dir));
    assert.equal(verified, listed.length, 'unavailable registrations still require fresh sibling verification');
  }
  assert.ok(peak > 1, 'independent checkout checks must overlap');
  assert.ok(peak <= 4, 'checkout checks must not spawn unbounded Git processes');
});

test('human and execution authority is server derived and current permissions only narrow saved profiles', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  let permission = 'full';
  let active = true;
  let saved;
  const repository = {
    getChat: id => ({ id, workspacePath: id === 'other' ? dirs.other : dirs.main, modeId: 'build' }),
    getLatestProfile: () => saved ? { snapshot: { policy: saved } } : null,
    getExecution: id => ({ executionId: id, chatId: 'main-chat', status: active ? 'running' : 'completed', captured: {} }),
    getLease: () => ({ executionId: 'execution', ownerId: 'host', epoch: 1 }),
    assertFence: () => { if (!active) throw new Error('Stale owner'); },
  };
  const context = createChatContext({ repository, runGit, validateRoot,
    resolvePolicyInput: async (_chat, _scope, registry) => ({ modeId: 'build',
      workspaceIds: registry.entries.map(row => row.workspaceId), toolPermissions: { read_file: permission },
      toolEffects: { read_file: 'read' }, capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'] }),
  });
  const human = await context.humanCaller('main-chat', { workspacePath: dirs.main });
  assert.equal(assertCaller(human.caller).actor, 'human');
  saved = { ...human.target.policy, toolPermissions: { read_file: 'ask' } };
  permission = 'off';
  const agent = await context.executionCaller('execution');
  assert.equal(assertExecutionCaller(agent.caller).executionId, 'execution');
  assert.equal(agent.caller.policy.toolPermissions.read_file ?? 'off', 'off');
  await assert.rejects(context.humanCaller('other', { workspacePath: dirs.main }), /not registered/);
  active = false;
  await assert.rejects(context.executionCaller('execution'), error => error.code === 'caller_not_active');
});

test('an unavailable directory or unverified git registry fails before authority is created', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  const blocked = (args, cwd) => args[0] === 'worktree' ? Promise.resolve({ code: 1, stdout: '' }) : runGit(args, cwd);
  await assert.rejects(loadChatProjectRegistry(dirs.main, { validateRoot, runGit: blocked }), error => error.code === 'workspace_denied');
  await assert.rejects(loadChatProjectRegistry(path.join(dirs.main, 'absent'), { validateRoot: async () => {}, runGit }), error => error.code === 'workspace_denied');
});


test('missing worktree reconciliation needs a verified source and never adopts an unrelated checkout', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  const chat = { id: 'chat', chatCommandVersion: 1, workspacePath: dirs.main, worktreeRoot: dirs.child };
  const { projectId } = await loadChatProjectRegistry(dirs.main, { validateRoot, runGit });
  let savedProjectId = projectId;
  let registered = true;
  const context = createChatContext({
    repository: { getChat: () => chat, getChatProjectId: () => savedProjectId },
    validateRoot, resolvePolicyInput: async () => { throw new Error('Recovery is not an execution authorization'); },
    runGit: (args, cwd) => !registered && args[0] === 'worktree'
      ? { code: 0, stdout: `worktree ${dirs.main}\0\0` } : runGit(args, cwd),
  });
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), null, 'registered checkout stays selected');
  chat.worktreeRoot = dirs.other;
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), null, 'an existing Git-listed path that fails verification stays selected');
  chat.worktreeRoot = dirs.child;
  registered = false;
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), chat, 'unregistered worktree with leftover files can detach');
  assert.ok((await fs.stat(dirs.child)).isDirectory());
  savedProjectId = 'other-project';
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), null, 'a different project cannot detach this chat');
  savedProjectId = projectId;
  chat.agentConversation = {};
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), null, 'delegated chats retain their separate execution scope');
  delete chat.agentConversation;
  chat.workspacePreparation = { intent: { chatId: chat.id, projectId, sourceWorkspaceId: 'not-the-saved-source' } };
  assert.equal(await context.findMissingWorktree(chat.id, dirs.main), null, 'a mismatched saved source cannot become Local');
});

test('unchanged revisions reuse per-checkout verification, not live allowlists or policy', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  let scans = 0, allowed = true, permission = 'full';
  const counted = async (args, cwd) => { scans++; return runGit(args, cwd); };
  const context = createChatContext({
    repository: { getChat: id => ({ id, workspacePath: dirs.main }), getLatestProfile: () => null },
    runGit: counted, validateRoot: async value => { assert.ok(allowed, 'allowlist revoked'); await validateRoot(value); },
    resolvePolicyInput: async (_chat, scope) => ({ modeId: 'build', workspaceIds: [scope.workspaceId], toolPermissions: { read_file: permission } }),
  });
  const first = await context.resolveTarget('chat');
  const coldScans = scans;
  scans = 0;
  permission = 'off';
  const second = await context.resolveTarget('chat');
  assert.equal(second.registry, first.registry);
  assert.equal(second.policy.toolPermissions.read_file ?? 'off', 'off');
  assert.equal(scans, 2, 'only current root common-dir and worktree listing, no per-sibling Git probes');
  assert.ok(coldScans > scans);
  scans = 0;
  const concurrent = await Promise.all([context.resolveTarget('a'), context.resolveTarget('b')]);
  assert.equal(concurrent[0].registry, concurrent[1].registry);
  assert.equal(scans, 2, 'concurrent discovery is single-flight');
  allowed = false;
  await assert.rejects(context.resolveTarget('chat'), /allowlist revoked/);
});

test('external registration and checkout marker changes invalidate without watchers', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  let removeChild = false, replacedChild = false;
  const changedGit = async (args, cwd) => {
    if (args[0] === 'worktree' && removeChild) return { code: 0, stdout: `worktree ${dirs.main}\0\0` };
    if (args[0] === 'rev-parse' && cwd === dirs.child && replacedChild) return { code: 0, stdout: dirs['other-common'] };
    return runGit(args, cwd);
  };
  const context = createChatContext({ repository: {}, runGit: changedGit, validateRoot, resolvePolicyInput: async () => ({}) });
  const first = await context.project(dirs.main);
  assert.equal(first.registry.entries.length, 2);
  removeChild = true;
  const removed = await context.project(dirs.main);
  assert.notEqual(removed.registry, first.registry);
  assert.equal(removed.registry.entries.length, 1);
  removeChild = false;
  const restored = await context.project(dirs.main);
  assert.equal(restored.registry.entries.length, 2);
  replacedChild = true;
  await fs.writeFile(path.join(dirs.child, '.git'), 'gitdir: replaced-repository');
  const replaced = await context.project(dirs.main);
  assert.equal(replaced.registry.entries.length, 1, 'old lexical path never preserves membership');
});

test('a supplied project snapshot cannot authorize an unrelated replacement checkout', async t => {
  const { dirs, runGit, validateRoot } = await fixture(t);
  let replaced = false;
  const context = createChatContext({
    repository: { getChat: id => ({ id, workspacePath: dirs.child }), getLatestProfile: () => null },
    runGit: (args, cwd) => args[0] === 'rev-parse' && cwd === dirs.child && replaced
      ? Promise.resolve({ code: 0, stdout: dirs['other-common'] }) : runGit(args, cwd),
    validateRoot, resolvePolicyInput: async () => ({}),
  });
  const project = await context.project(dirs.main);
  replaced = true;
  await assert.rejects(context.resolveTarget('child', { project }), /repository identity changed/);
});


test('real Git unchanged discovery avoids a second full registry scan and fails closed after Git errors', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-real-chat-registry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const directoryIdentity = await readChatCheckoutIdentity(root);
  await fs.writeFile(path.join(root, 'ordinary-file.txt'), 'Normal workspace writes preserve identity.');
  await exec('git', ['init', root], { windowsHide: true });
  assert.equal(await readChatCheckoutIdentity(root), directoryIdentity, 'Git initialization does not replace the execution directory');
  let calls = 0, failListing = false;
  const runGit = async (args, cwd) => {
    calls++;
    if (failListing && args[0] === 'worktree') return { code: 1, stdout: '' };
    const result = await exec('git', args, { cwd, windowsHide: true });
    return { code: 0, stdout: result.stdout };
  };
  const context = createChatContext({ repository: {}, validateRoot: async () => {}, runGit, resolvePolicyInput: async () => ({}) });
  const cold = await context.project(root);
  assert.equal(calls, 3);
  calls = 0;
  assert.equal((await context.project(root)).registry, cold.registry);
  assert.equal(calls, 2);
  failListing = true;
  await assert.rejects(context.project(root), error => error.code === 'workspace_denied');
  failListing = false;
  assert.equal((await context.project(root)).registry, cold.registry, 'fresh checks permit recovery without cached failures or grants');
});


test('retargeted directory junctions never reuse a cached canonical project', async t => {
  const { dirs, runGit } = await fixture(t);
  const alias = path.join(path.dirname(dirs.main), 'alias');
  await fs.symlink(dirs.main, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const context = createChatContext({ repository: { getChat: id => ({ id, workspacePath: alias }), getLatestProfile: () => null },
    runGit, validateRoot: async () => {}, resolvePolicyInput: async (_chat, scope) => ({ modeId: 'build', workspaceIds: [scope.workspaceId] }) });
  const first = await context.resolveTarget('chat');
  await fs.unlink(alias);
  await fs.symlink(dirs.other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const second = await context.resolveTarget('chat');
  assert.notEqual(second.scope.projectId, first.scope.projectId);
  assert.notEqual(second.checkoutIdentity, first.checkoutIdentity);
  await assert.rejects(context.resolveTarget('chat', { project: first.project }), error => error.code === 'workspace_denied');
});
