import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatContext, loadChatProjectRegistry } from '../../server/chats/context.js';
import { assertCaller, assertExecutionCaller } from '../../server/chats/caller.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-context-'));
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
