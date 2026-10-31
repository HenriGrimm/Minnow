import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';

const enabled = () => ({ version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true });
const code = expected => error => error?.code === expected;
async function fixture(t, options = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: 'C:/fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const policy = createChatPolicy({ modeId: 'build', toolPermissions: { read_file: 'full' }, toolEffects: { read_file: 'read' },
    workspaceIds: ['workspace'], capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'] });
  const chat = id => ({ id, name: id, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
  repository.createChat(chat('parent'));
  repository.createChild({ chat: chat('child'), projectId: 'project',
    relation: { version: 1, childChatId: 'child', parentChatId: 'parent', rootChatId: 'parent',
      journalOwnerId: 'family', origin: 'delegated', createdAt: 1 },
    profile: { profileId: 'child-profile', profileVersion: 1, snapshot: { policy, modelSelection: { providerId: 'provider', modelId: 'model' } } },
  });
  const context = { async resolveTarget(chatId) {
    return { chat: repository.getChat(chatId), scope, policy, currentPolicy: policy, registry,
      profile: repository.getLatestProfile(chatId), project: { projectId: 'project', scope, registry } };
  } };
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const admissions = [], errors = [];
  const service = createChatCommandService({ repository, context, feature: enabled, resolveModelSelection: ({ selection }) => selection,
    admitChildTask: ({ record }) => { admissions.push(record.commandId); return { ready: true, runId: 'task-' + record.position }; },
    onError: error => errors.push(error), ...options });
  t.after(async () => { await service.dispose(); db.close(); });
  const send = async (message, key = message) => {
    const receipt = await service.send(caller, { chatId: 'child', message, clientRequestId: key });
    await service.idle('child'); return repository.getCommand(receipt.commandId);
  };
  const host = execute => service.registerHost({ id: 'server-host', kind: 'server', supportsSteer: true, execute });
  const input = record => ({ commandId: record.commandId, runId: record.runId, attemptId: 'attempt-one' });
  const terminal = (record, handle, overrides = {}) => ({ version: 1, runId: record.runId, childChatId: 'child',
    journalOwnerId: 'family', executionId: handle.executionId, attemptId: handle.attemptId, status: 'completed', summary: 'Task complete',
    settledAt: 2000, completionPolicy: { version: 1, kind: 'local_only' }, ...overrides });
  function append(value, text) {
    repository.appendMessage('child', { role: 'user', content: value.command.message, commandId: value.command.commandId,
      provenance: value.command.provenance }, { fence: value.fence, commandId: value.command.commandId, messageId: 'input-' + value.command.commandId });
    createChatTranscriptStore({ chatId: 'child', fence: value.fence, repository }).append('child', { role: 'assistant', content: text });
  }
  return { db, repository, service, context, caller, admissions, errors, send, host, input, terminal, append };
}

test('ordinary child admission registers its graph run and never starts a provider even when a host is ready', async t => {
  const f = await fixture(t); let runs = 0;
  f.host(async () => { runs++; return { outcome: 'pass', summary: 'Done' }; });
  const command = await f.send('Delegated work');
  assert.ok(f.admissions.includes(command.commandId));
  assert.equal(command.runId, 'task-1');
  assert.equal(runs, 0);
  assert.equal(f.repository.listExecutions({ chatId: 'child' }).length, 0);
});

test('graph reservation is fenced but performs no model or transcript work before durable-start activation', async t => {
  const f = await fixture(t); let runs = 0;
  f.host(async value => { runs++; f.append(value, 'Attempt prose'); return { outcome: 'pass', summary: 'Done' }; });
  const command = await f.send('Reserve first');
  const reserved = await f.service.startAdmittedChildTask(f.input(command));
  assert.equal(reserved.deferred, undefined);
  assert.equal(runs, 0);
  assert.equal(f.repository.readTranscript('child').messages.length, 0);
  assert.equal(f.repository.getLease('child').executionId, reserved.executionId);
  assert.equal(await f.service.startAdmittedChildTask(f.input(command)), reserved);
  assert.throws(() => f.service.settleChildTask({ commandId: command.commandId, runId: command.runId,
    result: f.terminal(command, reserved) }), code('ownership_conflict'));
  const first = reserved.activate(), again = reserved.activate();
  assert.equal(first, again);
  assert.equal((await reserved.finished).outcome, 'pass'); assert.equal(runs, 1);
  assert.equal(f.repository.getExecution(reserved.executionId).status, 'completed');
  assert.equal(f.repository.getCommand(command.commandId).state, 'queued');
  assert.equal(f.repository.getLease('child').state, 'released');
  assert.deepEqual(f.repository.getExecution(reserved.executionId).captured.completionPolicy, { version: 1, kind: 'local_only' });
  const result = f.terminal(command, reserved);
  assert.equal(f.service.settleChildTask({ commandId: command.commandId, runId: command.runId, result }).state, 'settled');
  assert.equal(f.service.settleChildTask({ commandId: command.commandId, runId: command.runId, result }).state, 'settled');
  assert.throws(() => f.service.settleChildTask({ commandId: command.commandId, runId: command.runId,
    result: { ...result, summary: 'Rewritten terminal result' } }), code('idempotency_conflict'));
});

test('retryable attempt failures retain one command and user input while new attempts obtain new fences', async t => {
  const f = await fixture(t); let runs = 0, firstFence;
  f.host(async value => {
    runs++; f.append(value, 'Attempt ' + runs);
    if (runs === 1) { firstFence = value.fence; return { outcome: 'crashed', error: 'Transient provider failure' }; }
    return { outcome: 'pass', summary: 'Recovered' };
  });
  const command = await f.send('Retry this task');
  const first = await f.service.startAdmittedChildTask(f.input(command)); await first.activate();
  assert.equal(f.repository.getCommand(command.commandId).state, 'queued');
  await assert.rejects(f.service.editQueued(f.caller, { chatId: 'child', targetCommandId: command.commandId,
    expectedRevision: f.repository.getCommand(command.commandId).revision, message: 'Changed consumed task' }), code('stale_revision'));
  const second = await f.service.startAdmittedChildTask({ ...f.input(command), attemptId: 'attempt-two' });
  assert.notEqual(second.executionId, first.executionId);
  assert.ok(f.repository.getLease('child').epoch > firstFence.epoch);
  assert.throws(() => f.repository.appendMessage('child', { role: 'assistant', content: 'Stale attempt' },
    { fence: firstFence, messageId: 'stale-row' }), code('ownership_conflict'));
  await second.activate();
  assert.equal(f.repository.readTranscript('child').messages.filter(row => row.role === 'user').length, 1);
  assert.equal(f.repository.getCommand(command.commandId).state, 'queued');
  f.service.settleChildTask({ commandId: command.commandId, runId: command.runId, result: f.terminal(command, second) });
  assert.equal(f.repository.getCommand(command.commandId).state, 'settled');
  assert.equal(runs, 2);
});

test('FIFO, missing host and existing ownership defer graph starts without manufacturing attempts', async t => {
  const f = await fixture(t);
  const first = await f.send('First task'), second = await f.send('Next task');
  const unavailable = await f.service.startAdmittedChildTask(f.input(first));
  assert.equal(unavailable.deferred, true); assert.equal(unavailable.reason, 'waiting_for_host');
  assert.equal(f.repository.listExecutions({ chatId: 'child' }).length, 0);
  f.host(async () => ({ outcome: 'pass', summary: 'Done' }));
  await f.service.idle('child');
  assert.equal((await f.service.startAdmittedChildTask({ ...f.input(second), runId: 'second-task' })).deferred, true);
  const reserved = await f.service.startAdmittedChildTask(f.input(first));
  const conflict = await f.service.startAdmittedChildTask({ ...f.input(first), attemptId: 'competing-attempt' });
  assert.equal(conflict.deferred, true); assert.equal(conflict.reason, 'owned');
  assert.equal(f.repository.listExecutions({ chatId: 'child' }).length, 1);
  await reserved.activate();
  assert.equal((await f.service.startAdmittedChildTask({ ...f.input(second), runId: 'second-task' })).deferred, true);
  f.service.settleChildTask({ commandId: first.commandId, runId: first.runId, result: f.terminal(first, reserved) });
  await f.service.idle('child');
  assert.equal(f.repository.getCommand(second.commandId).runId, 'task-2');
});

test('Stop before activation releases its reservation and never starts a late provider invocation', async t => {
  const f = await fixture(t); let runs = 0;
  f.host(async () => { runs++; return { outcome: 'pass', summary: 'Must not run' }; });
  const command = await f.send('Reserved task');
  const reserved = await f.service.startAdmittedChildTask(f.input(command));
  await f.service.stop(f.caller, { chatId: 'child', executionId: reserved.executionId, clientRequestId: 'stop-reserved' });
  const stopped = await reserved.finished;
  assert.equal(stopped.failure.stopped, true); assert.equal(runs, 0);
  assert.equal(f.repository.getExecution(reserved.executionId).status, 'stopped');
  assert.equal(f.repository.getCommand(command.commandId).held, true);
  assert.equal(f.repository.getCommand(command.commandId).state, 'queued');
  await reserved.activate(); assert.equal(runs, 0);
});

test('a revoked execution capability defers already-accepted task work before creating an attempt', async t => {
  const f = await fixture(t); let runs = 0;
  f.host(async () => { runs++; return { outcome: 'pass', summary: 'Must not run' }; });
  const command = await f.send('Accepted before configuration revocation');
  const resolve = f.context.resolveTarget;
  f.context.resolveTarget = async chatId => {
    const target = await resolve(chatId);
    const narrowed = createChatPolicy({ ...target.currentPolicy, capabilities: ['chat.read', 'chat.stop'] });
    return { ...target, currentPolicy: narrowed, policy: narrowed };
  };
  const reservation = await f.service.startAdmittedChildTask(f.input(command));
  assert.deepEqual(reservation, { deferred: true, reason: 'capability_unavailable' });
  assert.equal(f.repository.listExecutions({ chatId: 'child' }).length, 0);
  assert.equal(runs, 0);
});

test('an unresolved task effect leaves a held recovery barrier instead of terminal success or an automatic retry', async t => {
  const f = await fixture(t); let runs = 0;
  f.host(async value => {
    runs++;
    f.repository.recordToolIntent({ invocationId: 'uncertain-effect', chatId: 'child', executionId: value.execution.executionId,
      toolCallId: 'write', toolName: 'save_file', input: { path: 'work.txt' } }, { fence: value.fence });
    return { outcome: 'pass', summary: 'An unsafe successful report' };
  });
  const command = await f.send('Uncertain task');
  const reserved = await f.service.startAdmittedChildTask(f.input(command));
  const result = await reserved.activate();
  assert.equal(result.outcome, 'crashed');
  assert.equal(result.failure.recoveryRequired, true);
  assert.equal(f.repository.getExecution(reserved.executionId).status, 'recovery_required');
  assert.equal(f.repository.getCommand(command.commandId).state, 'queued');
  assert.equal(f.repository.getCommand(command.commandId).held, true);
  assert.equal((await f.service.startAdmittedChildTask({ ...f.input(command), attemptId: 'unsafe-retry' })).deferred, true);
  assert.equal(runs, 1);
});
