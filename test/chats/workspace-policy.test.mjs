import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatProjectRegistry, createChatCaller, resolveProjectScope, projectChatPolicyToWorkspace, assertCallerCanTarget } from '../../server/chats/caller.js';

const rows = ['main', 'child', 'grandchild', 'unrelated'].map(workspaceId => ({ projectId: 'project', workspaceId, canonicalKey: `/real/${workspaceId}` }));
const edge = (source, target) => ({ projectId: 'project', sourceWorkspaceId: source, targetWorkspaceId: target,
  sourceCanonicalPath: `/real/${source}`, targetCanonicalPath: `/real/${target}` });
const policy = workspaceIds => createChatPolicy({ modeId: 'plan', workspaceIds,
  toolPermissions: { read_file: 'full', save_file: 'ask', execute_command: 'ask' }, fileWriteScope: 'plans', shellSandboxMode: 'require',
  capabilities: ['agent.spawn', 'chat.read', 'chat.send', 'execution.host'] });
const scope = (registry, id) => resolveProjectScope(registry, { projectId: 'project', workspaceKey: `/real/${id}` });

test('a verified derived chain grants the requested checkout and preserves every authority ceiling', () => {
  const registry = createChatProjectRegistry(rows, [edge('main', 'child'), edge('child', 'grandchild')]);
  const original = policy(['main']);
  const projected = projectChatPolicyToWorkspace(original, scope(registry, 'grandchild'), registry);
  assert.deepEqual(new Set(projected.workspaceIds), new Set(['main', 'child', 'grandchild']));
  assert.deepEqual({ ...projected, workspaceIds: original.workspaceIds }, original);
  assert.deepEqual(original.workspaceIds, ['main']);
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: 'execution', executionActive: true,
    scope: scope(registry, 'main'), policy: original });
  const currentPolicy = policy(rows.map(row => row.workspaceId));
  assertCallerCanTarget(caller, { chatId: 'agent', scope: scope(registry, 'grandchild'), policy: projected }, { operation: 'spawn', currentPolicy, registry });
  assert.throws(() => assertCallerCanTarget(caller, { chatId: 'other', scope: scope(registry, 'unrelated'), policy: policy(['unrelated']) },
    { operation: 'spawn', currentPolicy, registry }), error => error.reason === 'project_scope_denied');
});

test('live revocation or missing proof prevents a captured parent from granting a derived checkout', () => {
  const original = policy(['main']);
  for (const registry of [createChatProjectRegistry(rows),
    createChatProjectRegistry(rows.map(row => ({ ...row, revoked: row.workspaceId === 'child' })), [edge('main', 'child'), edge('child', 'grandchild')])]) {
    assert.equal(projectChatPolicyToWorkspace(original, scope(registry, 'grandchild'), registry), original);
  }
  const registry = createChatProjectRegistry(rows, [edge('main', 'child')]);
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: 'execution', executionActive: true,
    scope: scope(registry, 'main'), policy: original });
  assert.throws(() => assertCallerCanTarget(caller, { chatId: 'agent', scope: scope(registry, 'child'), policy: policy(['main', 'child']) },
    { operation: 'spawn', currentPolicy: policy([]), registry }), error => error.reason === 'project_scope_denied');
});

test('unverified aliases, multiple allocation parents and cyclic allocation records cannot become grants', () => {
  for (const edges of [[{ ...edge('main', 'child'), targetCanonicalPath: '/alias/child' }],
    [edge('main', 'child'), edge('grandchild', 'child')], [edge('main', 'child'), edge('child', 'main')]]) {
    assert.throws(() => createChatProjectRegistry(rows, edges), error => error.reason === 'invalid_caller');
  }
  const registry = createChatProjectRegistry(rows, [edge('main', 'child')]);
  assert.throws(() => projectChatPolicyToWorkspace(policy(['main']), { ...scope(registry, 'child') }, registry), error => error.reason === 'invalid_caller');
});
