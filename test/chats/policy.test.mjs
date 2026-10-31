import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertChatPolicy,
  assertChatPolicyWithinCeiling,
  assertChatToolAllowed,
  ChatPolicyError,
  compareChatPolicies,
  createChatPolicy,
  intersectChatPolicies,
} from '../../server/chats/policy.js';
import {
  assertCaller,
  assertCallerCanTarget,
  assertExecutionCaller,
  createChatCaller,
  createChatProjectRegistry,
  resolveProjectScope,
} from '../../server/chats/caller.js';
import { validateChatError } from '../../server/chats/contracts.js';

function policy(overrides = {}) {
  return createChatPolicy({
    modeId: 'build',
    toolPermissions: { read_file: 'full', save_file: 'full', execute_command: 'full', git_commit: 'full', mcp__docs__read: 'full', plugin__editor__write: 'full' },
    toolEffects: { mcp__docs__read: 'read', plugin__editor__write: 'file-write' },
    workspaceIds: ['main', 'tree'],
    filesystemAccess: 'workspace',
    fileWriteScope: 'workspace',
    capabilities: ['chat.read', 'chat.send', 'chat.stop', 'agent.spawn', 'execution.host'],
    ...overrides,
  });
}

const registryRows = [
  { projectId: 'project', workspaceId: 'main', canonicalKey: '/real/project', aliases: ['/registered/project-alias'] },
  { projectId: 'project', workspaceId: 'tree', canonicalKey: '/real/worktrees/task' },
  { projectId: 'other-project', workspaceId: 'other', canonicalKey: '/real/other' },
];

function fixture(overrides = {}) {
  const registry = createChatProjectRegistry(registryRows);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: '/real/project' });
  const captured = policy(overrides.policy);
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'source', executionId: 'execution', attemptId: 'attempt', executionActive: true, scope, policy: captured, ...overrides.caller });
  const target = { chatId: 'target', scope: resolveProjectScope(registry, { projectId: 'project', workspaceKey: '/real/worktrees/task' }), policy: captured };
  return { registry, scope, caller, target, captured };
}

function reason(expected) {
  return (error) => error instanceof ChatPolicyError && error.reason === expected;
}

describe('captured and current chat policy', () => {
  it('requires exact explicit grants and freezes every copied grant', () => {
    const permissions = { read_file: 'full' };
    const workspaces = ['main'];
    const captured = createChatPolicy({ modeId: 'build', toolPermissions: permissions, workspaceIds: workspaces });
    permissions.save_file = 'full';
    workspaces.push('other');
    assert.equal(captured.toolPermissions.save_file, undefined);
    assert.deepEqual(captured.workspaceIds, ['main']);
    assert.ok(Object.isFrozen(captured.toolPermissions));
    assert.ok(Object.isFrozen(captured.workspaceIds));
    assert.throws(() => createChatPolicy({ modeId: 'build', toolPermissions: { 'mcp__*': 'full' } }), reason('invalid_policy'));
    assert.throws(() => createChatPolicy({ modeId: 'missing' }), reason('invalid_policy'));
    assert.throws(() => assertChatPolicy({ ...captured }), reason('invalid_policy'));
  });

  it('intersects saved grants, type restrictions and current revocations for dynamic tools too', () => {
    const captured = policy();
    const type = policy({ toolPermissions: { read_file: 'full', mcp__docs__read: 'full', plugin__editor__write: 'full' }, workspaceIds: ['tree'], capabilities: ['chat.read'] });
    const current = policy({ toolPermissions: { read_file: 'ask', mcp__docs__read: 'off', plugin__editor__write: 'off' } });
    const effective = intersectChatPolicies(captured, type, current);
    assert.deepEqual(Object.entries(effective.toolPermissions), [['read_file', 'ask']]);
    assert.deepEqual(effective.workspaceIds, ['tree']);
    assert.deepEqual(effective.capabilities, ['chat.read']);
    for (const name of ['mcp__docs__read', 'plugin__editor__write']) {
      assert.throws(() => assertChatToolAllowed(captured, name, {}, { currentPolicy: current }), reason('tool_denied'));
    }
  });

  it('does not regain a captured denial when a live setting becomes more permissive', () => {
    const captured = policy({ toolPermissions: { read_file: 'ask' } });
    const current = policy();
    assert.throws(() => assertChatToolAllowed(captured, 'save_file', { path: 'app.js' }, { currentPolicy: current }), reason('tool_denied'));
    assert.throws(() => assertChatToolAllowed(captured, 'read_file', {}, { currentPolicy: current }), reason('approval_required'));
    assert.equal(assertChatToolAllowed(captured, 'read_file', {}, { currentPolicy: current, approvalGranted: true }).permission, 'ask');
  });

  it('fails closed when the execution adapter forgets current permissions', () => {
    assert.throws(() => assertChatToolAllowed(policy(), 'read_file', {}), reason('invalid_policy'));
  });

  it('compares actual grants rather than mode labels', () => {
    const captured = policy({ modeId: 'general' });
    assert.equal(compareChatPolicies(captured, policy({ modeId: 'debug' })).allowed, true);
    const target = policy({ modeId: 'general', toolPermissions: { ...captured.toolPermissions, mcp__storage__delete: 'full' } });
    assert.throws(() => assertChatPolicyWithinCeiling(target, captured), reason('broader_target_denied'));
    assert.ok(compareChatPolicies(captured, target).violations.includes('tool:mcp__storage__delete'));
  });

  it('rejects weaker approval, broader filesystem/checkout and capability ceilings independently', () => {
    const captured = policy({ toolPermissions: { read_file: 'ask' }, workspaceIds: ['main'], capabilities: ['chat.read'], fileWriteScope: 'none' });
    const target = policy({ toolPermissions: { read_file: 'full' }, filesystemAccess: 'full', fileWriteScope: 'full' });
    const result = compareChatPolicies(captured, target);
    for (const violation of ['tool:read_file', 'filesystem_access', 'file_write_scope', 'workspace:tree', 'capability:chat.send']) assert.ok(result.violations.includes(violation), violation);
  });

  it('reports policy failures through the common serialized error contract', () => {
    try { assertChatToolAllowed(policy(), 'missing_tool', {}, { currentPolicy: policy() }); }
    catch (error) {
      assert.equal(error.statusCode, 403);
      assert.equal(validateChatError(error.toJSON()).ok, true);
      return;
    }
    assert.fail('Expected a denied tool');
  });
});

describe('Plan and restricted file effects', () => {
  it('preserves Plan across legacy mode names and policy intersections', () => {
    const plan = policy({ modeId: 'super-plan' });
    assert.equal(plan.modeId, 'plan');
    assert.equal(plan.fileWriteScope, 'plans');
    const effective = intersectChatPolicies(policy(), plan);
    assert.equal(effective.modeId, 'plan');
    assert.equal(effective.fileWriteScope, 'plans');
    assert.equal(createChatPolicy({ modeId: 'desktop' }).modeId, 'general');
  });

  it('allows shell, reads and scoped markdown writes while denying application/git writes', () => {
    const plan = policy({ modeId: 'plan' });
    const options = { currentPolicy: plan };
    for (const name of ['read_file', 'execute_command']) assert.equal(assertChatToolAllowed(plan, name, {}, options).permission, 'full');
    assert.equal(assertChatToolAllowed(plan, 'save_file', { path: 'documentation/plans/task.md' }, options).permission, 'full');
    for (const path of ['src/app.ts', 'documentation/plans/task.js', '../documentation/plans/task.md']) {
      assert.throws(() => assertChatToolAllowed(plan, 'save_file', { path }, options), reason('plan_write_denied'));
    }
    assert.throws(() => assertChatToolAllowed(plan, 'git_commit', {}, options), reason('tool_denied'));
  });

  it('does not let copied metadata turn a built-in write or shell command into a read', () => {
    const readOnly = policy({ fileWriteScope: 'none', toolEffects: { save_file: 'read', git_commit: 'read', execute_command: 'read' } });
    assert.throws(() => assertChatToolAllowed(readOnly, 'save_file', { path: 'app.js' }, { currentPolicy: readOnly }), reason('tool_denied'));
    assert.throws(() => assertChatToolAllowed(readOnly, 'git_commit', {}, { currentPolicy: readOnly }), reason('tool_denied'));
    assert.equal(assertChatToolAllowed(readOnly, 'execute_command', {}, { currentPolicy: readOnly }).permission, 'full', 'File-write scope preserves existing explicit shell permission');
  });

  it('requires trusted read metadata for unclassified external tools in restricted profiles', () => {
    const captured = policy({ modeId: 'plan' });
    assert.equal(assertChatToolAllowed(captured, 'mcp__docs__read', {}, { currentPolicy: captured }).permission, 'full');
    assert.throws(() => assertChatToolAllowed(captured, 'plugin__editor__write', { path: 'documentation/plans/task.md' }, { currentPolicy: captured }), reason('tool_denied'));
    const unknown = policy({ modeId: 'plan', toolPermissions: { mcp__unknown__execute: 'full' } });
    assert.throws(() => assertChatToolAllowed(unknown, 'mcp__unknown__execute', {}, { currentPolicy: unknown }), reason('tool_denied'));
  });

  it('cannot mutate application files through a target with the same tools but a broader scope', () => {
    const plan = policy({ modeId: 'plan' });
    const target = policy();
    assert.equal(compareChatPolicies(plan, target).allowed, false);
    assert.ok(compareChatPolicies(plan, target).violations.includes('file_write_scope'));
  });
});

describe('trusted caller and registered project scope', () => {
  it('rejects caller JSON, spreads and prototype impersonation', () => {
    const { caller } = fixture();
    assert.equal(assertCaller(caller), caller);
    for (const value of [null, JSON.parse(JSON.stringify(caller)), { ...caller }, Object.create(caller)]) assert.throws(() => assertCaller(value), reason('untrusted_caller'));
    assert.ok(Object.isFrozen(caller));
  });

  it('accepts registered aliases and isolated project worktrees without lexical prefix grants', () => {
    const { registry, caller, target, captured } = fixture();
    const alias = resolveProjectScope(registry, { projectId: 'project', workspaceKey: '/registered/project-alias' });
    assert.equal(alias.workspaceId, 'main');
    assert.equal(alias.canonicalKey, '/real/project');
    assert.equal(assertCallerCanTarget(caller, target, { operation: 'send', registry, currentPolicy: captured }).scope.workspaceId, 'tree');
    for (const workspaceKey of ['/real/project-unrelated', '/real/project/../other', '/unregistered/symlink-to-project']) {
      assert.throws(() => resolveProjectScope(registry, { projectId: 'project', workspaceKey }), reason('project_scope_denied'));
    }
  });

  it('rejects ambiguous aliases and scope-shaped objects', () => {
    assert.throws(() => createChatProjectRegistry([...registryRows, { projectId: 'other-project', workspaceId: 'alias', canonicalKey: '/registered/project-alias' }]), reason('invalid_caller'));
    const { caller, registry, target, captured } = fixture();
    assert.throws(() => assertCallerCanTarget(caller, { ...target, scope: { ...target.scope } }, { operation: 'send', registry, currentPolicy: captured }), reason('invalid_caller'));
    assert.throws(() => resolveProjectScope({ ...registry }, { projectId: 'project', workspaceKey: '/real/project' }), reason('invalid_caller'));
  });

  it('rejects another project even with full filesystem access and its workspace grant', () => {
    const { registry, caller, captured } = fixture({ policy: { filesystemAccess: 'full', workspaceIds: ['main', 'tree', 'other'] } });
    const scope = resolveProjectScope(registry, { projectId: 'other-project', workspaceKey: '/real/other' });
    assert.throws(() => assertCallerCanTarget(caller, { chatId: 'other-chat', scope, policy: captured }, { operation: 'read', registry, currentPolicy: captured }), reason('project_scope_denied'));
    assert.throws(() => resolveProjectScope(registry, { projectId: 'project', workspaceKey: '/real/other' }), reason('project_scope_denied'));
  });

  it('checks current workspace registration and permissions again at target admission', () => {
    const { registry, caller, target, captured } = fixture();
    const revoked = createChatProjectRegistry(registryRows.map((entry) => ({ ...entry, revoked: entry.workspaceId === 'tree' })));
    assert.throws(() => assertCallerCanTarget(caller, target, { operation: 'read', registry: revoked, currentPolicy: captured }), reason('project_scope_denied'));
    assert.throws(() => assertCallerCanTarget(caller, target, { operation: 'read', registry, currentPolicy: policy({ workspaceIds: ['main'] }) }), reason('project_scope_denied'));
    assert.throws(() => assertCallerCanTarget(caller, target, { operation: 'send', registry, currentPolicy: policy({ capabilities: ['chat.read'] }) }), reason('capability_denied'));
  });

  it('does not silently rebind an old caller to a newly registered checkout identity', () => {
    const { caller, target, captured } = fixture();
    const rebound = createChatProjectRegistry(registryRows.map((entry) => entry.workspaceId === 'main'
      ? { ...entry, workspaceId: 'replacement' } : entry));
    const currentPolicy = policy({ workspaceIds: ['main', 'tree', 'replacement'] });
    assert.throws(() => assertCallerCanTarget(caller, target, { operation: 'read', registry: rebound, currentPolicy }), reason('project_scope_denied'));
    assert.equal(captured.workspaceIds.includes('main'), true);
  });

  it('allows authorized read without peer mutation authority', () => {
    const { registry, caller, target, captured } = fixture({ policy: { capabilities: ['chat.read'] } });
    assert.equal(assertCallerCanTarget(caller, target, { operation: 'read', registry, currentPolicy: captured }).caller, caller);
    assert.throws(() => assertCallerCanTarget(caller, target, { operation: 'send', registry, currentPolicy: captured }), reason('capability_denied'));
  });

  it('requires a live calling execution for agent mutations and rejects self-send', () => {
    const { registry, scope, caller, target, captured } = fixture();
    const inactive = createChatCaller({ actor: 'agent', ingress: 'cli', chatId: 'source', scope, policy: captured });
    assert.throws(() => assertCallerCanTarget(inactive, target, { operation: 'send', registry, currentPolicy: captured }), reason('execution_caller_required'));
    assert.throws(() => assertCallerCanTarget(caller, { ...target, chatId: 'source' }, { operation: 'send', registry, currentPolicy: captured }), reason('self_target_denied'));
    assert.equal(assertCallerCanTarget(inactive, target, { operation: 'read', registry, currentPolicy: captured }).caller, inactive);
  });

  it('rejects a broader target profile even when caller and target share the same mode', () => {
    const { registry, caller, target, captured } = fixture({ policy: { toolPermissions: { read_file: 'full' } } });
    assert.throws(() => assertCallerCanTarget(caller, { ...target, policy: policy() }, { operation: 'send', registry, currentPolicy: captured }), reason('broader_target_denied'));
  });

  it('permits devices to submit authorized human commands but never own execution', () => {
    const { registry, scope, caller, target, captured } = fixture();
    const device = createChatCaller({ actor: 'human', ingress: 'device', chatId: 'source', scope, policy: captured });
    assert.equal(assertCallerCanTarget(device, target, { operation: 'send', registry, currentPolicy: captured }).caller, device);
    assert.throws(() => assertExecutionCaller(device), reason('execution_caller_required'));
    assert.throws(() => createChatCaller({ actor: 'human', ingress: 'device', chatId: 'source', executionId: 'execution', executionActive: true, scope, policy: captured }), reason('invalid_caller'));
    assert.equal(assertExecutionCaller(caller), caller);
  });
});
