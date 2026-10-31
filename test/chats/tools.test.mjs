import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatPolicy, intersectChatPolicies } from '../../server/chats/policy.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatTools, installChatTools } from '../../server/chats/tools.js';
import { AGENT_CHAT_TOOL_IDS, projectAgentConversationTools } from '../../server/chats/tool-catalog.js';
import { CHAT_READ_MAX_BYTES, createChatToolReads } from '../../server/chats/tool-reads.js';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { normalizeToolConfig } from '../../server/config/validators.js';
import { buildAgentCliToolCatalog } from '../../server/generations/agent-cli/bridge.js';
import { isParallelSafeTool } from '../../server/runner/parallel-tool-policy.js';

const enabled = () => ({ creationEnabled: true, recoveryEnabled: true });
const effects = Object.fromEntries(AGENT_CHAT_TOOL_IDS.map(name => [name, ['chat_send', 'chat_stop'].includes(name) ? 'external-write' : 'read']));
const pair = { providerId: 'fixture', modelId: 'model' };
async function fixture(run, extra = {}) {
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  const root = path.resolve('test-tools-workspace'), foreign = path.resolve('test-tools-foreign');
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'main', canonicalKey: root },
    { projectId: 'foreign', workspaceId: 'other', canonicalKey: foreign }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: root });
  const initial = createChatPolicy({ modeId: extra.mode ?? 'build', workspaceIds: ['main'],
    toolPermissions: { ...Object.fromEntries(AGENT_CHAT_TOOL_IDS.map(name => [name, 'full'])), read_file: 'full' },
    toolEffects: { ...effects, read_file: 'read' }, filesystemAccess: 'workspace',
    fileWriteScope: extra.mode === 'plan' ? 'plans' : 'workspace', capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'] });
  let live = initial, valid = true;
  const policies = new Map();
  for (let n = 0; n < (extra.foreignChats ?? 0); n++) {
    repository.createChat({ id: 'unrelated-' + n, name: 'Unrelated chat', workspacePath: foreign, modeId: 'build' });
  }
  for (const id of ['source', 'target', 'other', 'foreign-chat']) {
    repository.createChat({ id, name: id === 'target' ? 'Target chat' : id, workspacePath: id === 'foreign-chat' ? foreign : root,
      providerId: pair.providerId, modelId: pair.modelId, modeId: initial.modeId });
    policies.set(id, id === 'foreign-chat' ? createChatPolicy({ ...initial, workspaceIds: ['other'] }) : initial);
  }
  const fence = repository.claimExecution({ chatId: 'source', executionId: 'source-execution', ownerId: 'source-host',
    captured: { policy: initial, modelSelection: pair } });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'source', executionId: fence.executionId,
    executionActive: true, scope, policy: initial });
  const context = { async resolveTarget(chatId) {
    const chat = repository.getChat(chatId), currentPolicy = chatId === 'source' ? live : policies.get(chatId) ?? initial;
    const targetScope = resolveProjectScope(registry, { projectId: chatId === 'foreign-chat' ? 'foreign' : 'project', workspaceKey: chatId === 'foreign-chat' ? foreign : root });
    return { chat, scope: targetScope, registry, currentPolicy, policy: intersectChatPolicies(currentPolicy, policies.get(chatId) ?? initial),
      project: { projectId: targetScope.projectId, registry, scope: targetScope }, profile: repository.getLatestProfile(chatId) };
  } };
  const errors = [], service = createChatCommandService({ repository, context, feature: enabled,
    resolveModelSelection: ({ selection }) => selection, onError: error => errors.push(error) });
  const options = { repository, context, service, feature: enabled, validateCaller: candidate => {
    try { return valid && candidate === caller && Boolean(repository.assertFence('source', fence)); } catch { return false; }
  }, ...extra.options };
  const tools = createChatTools(options);
  const execute = (name, args = {}, overrides = {}) => tools.execute(name, args, { caller, toolCallId: 'call', ...overrides });
  try { await run({ db, repository, context, caller, fence, tools, options, policies, initial, service, errors, execute,
    revoke() { live = createChatPolicy({ ...initial, toolPermissions: { ...initial.toolPermissions, chat_wait: 'off', chat_send: 'off' } }); },
    invalidate() { valid = false; } });
  } finally { await service.dispose(); db.close(); }
}

test('six catalog schemas and defaults stay gated, with explicit off/ask preserved', () => {
  const catalog = BUILT_IN_TOOLS.filter(row => AGENT_CHAT_TOOL_IDS.includes(row.id));
  assert.equal(catalog.length, 6);
  assert.equal(projectAgentConversationTools(catalog.map(row => row.definition)).length, 0);
  assert.equal(projectAgentConversationTools(catalog.map(row => row.definition), { creationEnabled: true }).length, 6);
  const defaults = normalizeToolConfig({});
  for (const name of AGENT_CHAT_TOOL_IDS) assert.equal(defaults.permissions.default[name], 'full');
  const stored = normalizeToolConfig({ enabled: { chat_send: false }, permissions: { default: { chat_send: 'off', chat_stop: 'ask' } } });
  assert.equal(stored.permissions.default.chat_send, 'off'); assert.equal(stored.permissions.default.chat_stop, 'ask');
});

test('native CLI handoff advertises exactly the same bounded tool schemas, with coordination mutations sequential', () => {
  const definitions = BUILT_IN_TOOLS.filter(row => AGENT_CHAT_TOOL_IDS.includes(row.id)).map(row => row.definition);
  const native = buildAgentCliToolCatalog({ tools: definitions });
  assert.deepEqual(native.map(row => row.name), AGENT_CHAT_TOOL_IDS);
  for (const row of native) assert.deepEqual(row.inputSchema, definitions.find(tool => tool.function.name === row.name).function.parameters);
  for (const name of ['agent_capabilities', 'chat_list', 'chat_read']) assert.equal(isParallelSafeTool(name), true);
  for (const name of ['chat_send', 'chat_wait', 'chat_stop']) assert.equal(isParallelSafeTool(name), false);
});

test('tools require branded active callers, exact current tool grant and known arguments', async () => {
  await fixture(async f => {
    await assert.rejects(f.tools.execute('chat_list', {}, { caller: { ...f.caller } }), error => error.code === 'caller_denied');
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'x', providerId: 'forged' }), error => error.code === 'invalid_request');
    f.revoke();
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'x' }), error => error.code === 'policy_denied');
    f.invalidate();
    await assert.rejects(f.execute('chat_list'), error => error.code === 'caller_not_active');
    assert.equal(f.repository.listCommands().length, 0);
  });
});

test('send derives stable retry identity and source attribution without creation or configuration', async () => {
  await fixture(async f => {
    const first = await f.execute('chat_send', { chat_id: 'target', message: 'Review this change', mode: 'queue' });
    const duplicate = await f.execute('chat_send', { chat_id: 'target', message: 'Review this change', mode: 'queue' });
    assert.equal(first.commandId, duplicate.commandId); assert.equal(duplicate.replayed, true);
    const record = f.repository.getCommand(first.commandId);
    assert.equal(record.command.provenance.actor, 'agent'); assert.equal(record.command.provenance.sourceChatId, 'source');
    assert.equal(record.command.provenance.sourceTurnId, 'source-execution');
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'Changed' }), error => error.code === 'idempotency_conflict');
    await assert.rejects(f.execute('chat_send', { chat_id: 'missing', message: 'Never create' }, { toolCallId: 'missing' }), error => error.code === 'chat_not_found');
    await assert.rejects(f.execute('chat_send', { chat_id: 'source', message: 'Loop' }, { toolCallId: 'self' }), error => error.reason === 'self_target_denied');
    assert.equal(f.repository.getChat('target').providerId, pair.providerId);
    assert.equal(f.repository.listChats().length, 4);
  });
});

test('send refuses broader target and foreign project, while read/list stay scope bounded', async () => {
  await fixture(async f => {
    f.policies.set('target', createChatPolicy({ ...f.initial, modeId: 'build', fileWriteScope: 'workspace',
      toolPermissions: { ...f.initial.toolPermissions, git_commit: 'full' }, toolEffects: { ...effects, git_commit: 'git-write' } }));
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'Write' }), error => error.code === 'policy_denied');
    await assert.rejects(f.execute('chat_read', { chat_id: 'foreign-chat' }), error => ['cross_project_denied', 'workspace_denied'].includes(error.code));
    const list = await f.execute('chat_list');
    assert.deepEqual(list.chats.map(row => row.chat_id), ['source', 'target', 'other']);
  }, { mode: 'plan' });
});

test('list cursor binds query and project, and reads never hydrate whole transcripts or attachment bytes', async () => {
  await fixture(async f => {
    f.repository.readTranscript = () => { throw new Error('Full transcript reads are forbidden'); };
    const first = await f.execute('chat_list', { limit: 1 });
    assert.equal(first.chats.length, 1); assert.ok(first.next_cursor);
    const second = await f.execute('chat_list', { limit: 1, cursor: first.next_cursor });
    assert.notEqual(first.chats[0].chat_id, second.chats[0].chat_id);
    await assert.rejects(f.execute('chat_list', { query: 'other', cursor: first.next_cursor }), error => error.code === 'invalid_request');
    const targetFence = f.repository.claimExecution({ chatId: 'target', executionId: 'target-execution', ownerId: 'target-host' });
    for (let n = 0; n < 5; n++) f.repository.appendMessage('target', { role: 'user', content: '漢'.repeat(12000),
      images: [{ name: 'image', dataUrl: 'IMAGE_SECRET'.repeat(30000) }], reasoningBlocks: [{ signature: 'SIGNED_SECRET' }],
      provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'source', sourceTurnId: 'source-execution' } },
    { fence: targetFence, messageId: 'message-' + n });
    const page = await f.execute('chat_read', { chat_id: 'target', limit: 100 });
    const serialized = JSON.stringify(page);
    assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= CHAT_READ_MAX_BYTES + 100);
    assert.ok(!serialized.includes('IMAGE_SECRET')); assert.ok(!serialized.includes('SIGNED_SECRET'));
    assert.equal(page.truncated, true); assert.equal(page.has_more, true); assert.ok(page.next_sequence >= 0);
    const next = await f.execute('chat_read', { chat_id: 'target', after_sequence: page.next_sequence, limit: 1 });
    assert.equal(next.messages[0].sequence, page.next_sequence + 1);
    await assert.rejects(f.execute('chat_read', { chat_id: 'target', view: 'activity', limit: 1000 }), error => error.code === 'invalid_request');
  });
});

test('list applies project scope before its scan budget and paginates past unrelated history', async () => {
  await fixture(async f => {
    const resolved = [];
    const resolveTarget = f.context.resolveTarget;
    f.context.resolveTarget = async (...args) => { resolved.push(args[0]); return resolveTarget(...args); };
    const first = await f.execute('chat_list', { limit: 2 });
    assert.deepEqual(first.chats.map(row => row.chat_id), ['source', 'target']);
    assert.equal(first.partial_scan, false);
    assert.ok(first.next_cursor);
    const second = await f.execute('chat_list', { limit: 2, cursor: first.next_cursor });
    assert.deepEqual(second.chats.map(row => row.chat_id), ['other']);
    assert.equal(second.next_cursor, null);
    assert.equal(second.partial_scan, false);
    assert.equal(resolved.some(id => id.startsWith('unrelated-') || id === 'foreign-chat'), false);
  }, { foreignChats: 450 });
});

test('list candidates include registered checkout aliases and use the effective worktree root', async () => {
  await fixture(async f => {
    const root = f.repository.getChat('source').workspacePath;
    const foreign = f.repository.getChat('foreign-chat').workspacePath;
    const alias = root + '-alias', worktree = root + '-worktree';
    f.repository.createChat({ id: 'alias-chat', workspacePath: alias });
    f.repository.createChat({ id: 'worktree-chat', workspacePath: root, worktreeRoot: worktree });
    f.repository.createChat({ id: 'outside-checkout', workspacePath: root, worktreeRoot: foreign });
    const rows = createChatToolReads(f.repository).candidates(0, 100, true, [root, alias, worktree]);
    assert.deepEqual(rows.map(row => row.id), ['source', 'target', 'other', 'alias-chat', 'worktree-chat']);
  });
});

test('wait reports no work, blocks on required host, times out without stopping and rejects self waits', async () => {
  await fixture(async f => {
    assert.equal((await f.execute('chat_wait', { chat_id: 'target', timeout_ms: 0 })).state, 'no_active_execution');
    const fence = f.repository.claimExecution({ chatId: 'target', executionId: 'target-execution', ownerId: 'target-host' });
    assert.equal((await f.execute('chat_wait', { chat_id: 'target', timeout_ms: 0 })).state, 'timed_out');
    assert.equal(f.repository.getExecution('target-execution').status, 'running');
    f.repository.updateExecution('target-execution', { status: 'waiting_for_host' }, { fence });
    assert.equal((await f.execute('chat_wait', { chat_id: 'target' })).state, 'waiting_for_capability');
    await assert.rejects(f.execute('chat_wait', { chat_id: 'source' }), error => error.code === 'wait_cycle');
    await assert.rejects(f.execute('chat_wait', { chat_id: 'target', execution_id: 'foreign-execution' }), error => error.code === 'request_not_found');
  });
});

test('activity preserves the exact pending request count while bounding request details', async () => {
  await fixture(async f => {
    const fence = f.repository.claimExecution({ chatId: 'target', executionId: 'target-execution', ownerId: 'target-host' });
    for (let n = 0; n < 6; n++) f.repository.saveRequest({ version: 1, requestId: 'request-' + n, chatId: 'target',
      executionId: 'target-execution', toolCallId: 'tool-' + n, kind: 'approval', state: 'pending', createdAt: 1,
      title: 'Approve?', presentation: {} }, { fence });
    const activity = await f.execute('chat_read', { chat_id: 'target', view: 'activity' });
    assert.equal(activity.pendingRequestCount, 6); assert.equal(activity.requests.length, 5); assert.equal(activity.requestsTruncated, true);
    const list = await f.execute('chat_list');
    assert.equal(list.chats.find(chat => chat.chat_id === 'target').pending_request_count, 6);
    assert.equal((await f.execute('chat_wait', { chat_id: 'target' })).state, 'blocked');
  });
});

test('wait pins exact execution across replacement, returns only its final text and brackets coordination hooks', async () => {
  let entered = 0, released = 0;
  await fixture(async f => {
    const fence = f.repository.claimExecution({ chatId: 'target', executionId: 'target-execution', ownerId: 'target-host' });
    const waiting = f.execute('chat_wait', { chat_id: 'target', timeout_ms: 1000 });
    setTimeout(() => {
      const prefix = 'm-' + createHash('sha256').update('target-execution').digest('hex').slice(0, 32) + '-';
      f.repository.appendMessage('target', { role: 'assistant', content: 'Pinned answer' }, { fence, messageId: prefix + 'final' });
      f.repository.updateExecution('target-execution', { status: 'completed' }, { fence });
      f.repository.releaseLease('target', fence);
      f.repository.claimExecution({ chatId: 'target', executionId: 'replacement', ownerId: 'new-host' });
    }, 10);
    const result = await waiting;
    assert.equal(result.execution_id, 'target-execution'); assert.equal(result.state, 'terminal'); assert.equal(result.assistant_final, 'Pinned answer');
    assert.equal(f.repository.getExecution('replacement').status, 'running');
    assert.equal(entered, 1); assert.equal(released, 1);
  }, { options: { beforeWait: () => { entered++; return () => { released++; }; } } });
});

test('wait abort/current revocations release hooks and never stop the target', async () => {
  let released = 0;
  await fixture(async f => {
    f.repository.claimExecution({ chatId: 'target', executionId: 'target-execution', ownerId: 'target-host' });
    const controller = new AbortController();
    const waiting = f.execute('chat_wait', { chat_id: 'target', timeout_ms: 1000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(waiting, error => error.name === 'AbortError');
    assert.equal(released, 1);
    const revoked = f.execute('chat_wait', { chat_id: 'target', timeout_ms: 1000 });
    setTimeout(() => f.revoke(), 5);
    await assert.rejects(revoked, error => error.code === 'policy_denied');
    assert.equal(released, 2); assert.equal(f.repository.getExecution('target-execution').status, 'running');
  }, { options: { beforeWait: () => () => { released++; } } });
});

test('stop is idempotent, stale execution never cancels replacement and self-tree cannot deadlock', async () => {
  await fixture(async f => {
    const stopped = await f.execute('chat_stop', { chat_id: 'target', execution_id: 'old' });
    assert.equal(stopped.result.stopRequested, false);
    assert.equal((await f.execute('chat_stop', { chat_id: 'target', execution_id: 'old' })).replayed, true);
    await assert.rejects(f.execute('chat_stop', { chat_id: 'source', scope: 'tree' }), error => error.code === 'policy_denied');
    await assert.rejects(f.execute('chat_stop', { chat_id: 'target', scope: 'forever' }), error => error.code === 'invalid_request');
  });
});

test('native installer derives caller from execution, passes real approval and unregisters all six handlers', async () => {
  await fixture(async f => {
    const handlers = new Map();
    const runtime = { ...f.options, isExecutionCallerActive: f.options.validateCaller,
      context: { ...f.context, executionCaller: async id => { assert.equal(id, 'source-execution'); return { caller: f.caller }; } },
      setToolHandler(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
    const installed = installChatTools(runtime, { feature: enabled });
    const output = await handlers.get('chat_read')({ args: { chat_id: 'target', view: 'activity' }, execution: { executionId: 'source-execution' }, toolContext: {} });
    assert.equal(JSON.parse(output.content).chat_id, 'target'); assert.equal(handlers.size, 6);
    installed.dispose(); assert.equal(handlers.size, 0);
  });
});

test('capabilities use the captured selection and bounded injected production catalogs', async () => {
  await fixture(async f => {
    const tools = createChatTools({ ...f.options, capabilitiesContext: (_caller, source) => {
      assert.equal(source.chat.id, 'source');
      return { inherited: { ...pair, options: { reasoningEffort: 'high' } }, types: { explore: { enabled: true, label: 'Explore' }, hidden: { enabled: false } },
        adapters: { listProviders: async () => [], listLibraryModels: async () => [], listPools: async () => ({ routers: [] }) } };
    } });
    const result = await tools.execute('agent_capabilities', { limit: 2 }, { caller: f.caller });
    assert.deepEqual(result.inherited.options, { reasoningEffort: 'high' });
    assert.deepEqual(result.types.map(row => row.id), ['explore']); assert.equal(result.targets.length, 0);
  });
});

test('explicit Ask requires a trusted approval; feature disable permits recovery reads but no new sends', async () => {
  await fixture(async f => {
    const ask = createChatPolicy({ ...f.initial, toolPermissions: { ...f.initial.toolPermissions, chat_send: 'ask' } });
    f.policies.set('source', ask);
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'Needs approval' }), error => error.reason === 'approval_required');
    assert.equal(f.repository.listCommands().length, 0);
    const approved = await f.execute('chat_send', { chat_id: 'target', message: 'Approved by server host' }, { approvalGranted: true });
    assert.ok(approved.commandId);
    const recovery = createChatTools({ ...f.options, feature: () => ({ creationEnabled: false, recoveryEnabled: true }) });
    assert.equal((await recovery.execute('chat_read', { chat_id: 'target', view: 'activity' }, { caller: f.caller })).chat_id, 'target');
    await assert.rejects(recovery.execute('chat_send', { chat_id: 'target', message: 'Disabled' }, { caller: f.caller }), error => error.code === 'capability_disabled');
    await assert.rejects(f.execute('chat_send', { chat_id: 'target', message: 'Steer', mode: 'steer' }, { toolCallId: 'steer', approvalGranted: true }), error => error.code === 'steer_unsupported');
  });
});
