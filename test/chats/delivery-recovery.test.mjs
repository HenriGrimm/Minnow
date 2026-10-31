import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatTaskDelivery } from '../../server/chats/task-delivery.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { createJournalStore } from '../../server/orchestrator/journal-store.js';
import { derive } from '../../server/sub-agents/derive.js';
import { makeEvent, validateEvent } from '../../server/sub-agents/events.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { upsertMessageRow } from '../../server/config/sessions-import.js';

const enabled = () => ({ version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true });
const failCode = expected => error => error?.code === expected;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-task-delivery-'));
  const previousHome = process.env.MINNOW_HOME; process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  const journal = createJournalStore({ namespace: 'agents', idKind: 'parentChat', fold: derive, validate: validateEvent });
  const file = path.join(home, 'session-fixture.db');
  let db, repository, context, service, delivery, unregister;
  let clock = 1000, busy = false, legacyActive = false, ready = true;
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: 'C:/fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const policy = createChatPolicy({ modeId: 'build', toolPermissions: { read_file: 'full' }, toolEffects: { read_file: 'read' },
    workspaceIds: ['workspace'], capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'] });
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const calls = [], errors = [];
  let execute = async input => {
    const store = createChatTranscriptStore({ chatId: input.command.chatId, fence: input.fence, repository });
    repository.appendMessage(input.command.chatId, { role: 'user', content: input.command.message,
      commandId: input.command.commandId, provenance: input.command.provenance },
    { fence: input.fence, messageId: 'input-' + input.command.commandId, commandId: input.command.commandId });
    store.append(input.command.chatId, { role: 'assistant', content: input.command.chatId === 'parent' ? 'Parent resumed.' : 'Child result.' });
    return input.command.chatId === 'parent' ? { outcome: 'no_report' } : { outcome: 'pass', summary: 'Child result.' };
  };
  const chat = id => ({ id, name: id, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
  function open() {
    db = new Database(file); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    repository = createChatRepository({ db, now: () => clock });
    context = { async resolveTarget(chatId) {
      return { chat: repository.getChat(chatId), scope, policy, currentPolicy: policy, registry,
        profile: repository.getLatestProfile(chatId), project: { projectId: 'project', scope, registry } };
    } };
    service = createChatCommandService({ repository, context, feature: enabled, resolveModelSelection: ({ selection }) => selection,
      hasExternalOwner: chatId => chatId === 'parent' && legacyActive,
      cancelTree: input => delivery.cancelTree(input),
      admitChildTask: ({ record }) => ({ runId: record.runId ?? 'task-' + record.commandId }),
      onEvent: event => delivery?.onServiceEvent(event), onError: error => errors.push(error) });
    delivery = createChatTaskDelivery({ repository, context, service, journal, now: () => clock, retryMs: 1000000,
      isReady: () => ready, isRecipientBusy: () => busy || legacyActive,
      isSourceActive: () => legacyActive, onError: error => errors.push(error) });
    unregister = service.registerHost({ id: 'server', kind: 'server', supportsSteer: true, async execute(input) {
      calls.push({ chatId: input.command.chatId, commandId: input.command.commandId, executionId: input.execution.executionId, input });
      return execute(input);
    } });
  }
  open(); repository.createChat(chat('parent'));
  t.after(async () => {
    await delivery.dispose(); unregister(); await service.dispose(); db.close(); journal.resetCache();
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
  });
  async function spawn(runId, { local = false, inline = false, childChatId = 'child-' + runId, parentChatId = 'parent' } = {}) {
    const completionPolicy = local ? { version: 1, kind: 'local_only' } : { version: 1, kind: 'wake_delegator',
      recipientChatId: parentChatId, subscriptionId: 'subscription-' + runId, cancellationEpoch: repository.getCancellationEpoch(parentChatId) };
    const command = { version: 1, commandId: 'assignment-' + runId, chatId: childChatId, kind: 'send', mode: 'auto',
      message: 'Task ' + runId, requestedAt: clock, modelSelection: { providerId: 'provider', modelId: 'model' },
      provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'parent', sourceTurnId: 'parent-execution' } };
    repository.createChild({ chat: chat(childChatId), relation: { version: 1, childChatId, parentChatId, rootChatId: 'parent',
      journalOwnerId: 'family', origin: 'delegated', createdAt: clock }, profile: { profileId: 'profile-' + runId, profileVersion: 1, snapshot: { policy } },
      projectId: 'project', command, producerId: 'spawn', requestKey: runId, captured: { runId, policy, scope, completionPolicy,
        ...(inline ? { inlineWait: { chatId: 'parent', executionId: 'parent-execution', toolCallId: 'spawn-' + runId } } : {}) } });
    repository.updateCommand(command.commandId, { runId, state: 'queued' });
    await journal.appendEvent('family', makeEvent('run.requested', { runId, agentType: 'explore', task: command.message,
      parentChatId: 'family', journalOwnerId: 'family', childChatId, commandId: command.commandId, executionKind: 'chat',
      requestedAt: clock, cwd: 'C:/fixture', completionPolicy }), { now: () => clock });
    return { runId, commandId: command.commandId, childChatId, completionPolicy };
  }
  async function complete(task, { publish = true } = {}) {
    const handle = await service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'attempt-' + task.runId });
    assert.notEqual(handle.deferred, true);
    await journal.appendEvent('family', makeEvent('attempt.started', { runId: task.runId, attemptId: handle.attemptId,
      executionId: handle.executionId, seed: { kind: 'initial' } }), { now: () => ++clock });
    const result = await handle.activate();
    await journal.appendEvent('family', makeEvent('attempt.ended', { runId: task.runId, attemptId: handle.attemptId,
      executionId: handle.executionId, outcome: result.outcome, summary: result.summary ?? result.error ?? 'Finished' }), { now: () => ++clock });
    const input = { run: (await journal.loadState('family')).runs.get(task.runId), executionId: handle.executionId,
      attemptId: handle.attemptId, result };
    if (publish) await delivery.onSettled(input);
    return { handle, input, result };
  }
  async function interrupted(task, { activated = true, effect = false } = {}) {
    const executionId = 'interrupted-' + task.runId, attemptId = 'attempt-' + task.runId;
    repository.createExecution({ chatId: task.childChatId, executionId, runId: task.runId, attemptId, commandId: task.commandId,
      captured: { taskOwned: true, policy, completionPolicy: task.completionPolicy } });
    const fence = repository.claimExecution({ chatId: task.childChatId, executionId, ownerId: 'vanished-host' });
    repository.updateCommand(task.commandId, { state: 'running', executionId });
    if (activated) {
      repository.markExecutionActivated(executionId, { fence });
      await journal.appendEvent('family', makeEvent('attempt.started', { runId: task.runId, attemptId, executionId, seed: { kind: 'initial' } }));
    }
    if (effect) {
      repository.recordToolIntent({ invocationId: 'lost-effect-' + task.runId, chatId: task.childChatId, executionId,
        toolCallId: 'write', toolName: 'save_file', input: { path: 'effect.txt' } }, { fence });
      await fs.writeFile(path.join(home, 'effect.txt'), 'One effect');
    }
    return { executionId, attemptId, fence };
  }
  return {
    get db() { return db; }, get repository() { return repository; }, get service() { return service; }, get delivery() { return delivery; },
    get context() { return context; }, journal, home, caller, policy, scope, calls, errors, spawn, complete, interrupted,
    setBusy: value => { busy = value; }, setLegacyActive: value => { legacyActive = value; },
    setReady: value => { ready = value; }, setExecute: fn => { execute = fn; }, advance: ms => { clock += ms; },
    async reopen() { await delivery.dispose(); unregister(); await service.dispose(); db.close(); journal.resetCache(); open(); },
  };
}

test('terminal journal commit precedes immutable result publication and renderer-free parent admission precedes acknowledgement', async t => {
  const f = await fixture(t), task = await f.spawn('ordering');
  const reserved = await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'ordering-attempt' });
  await f.delivery.onSettled({ run: (await f.journal.loadState('family')).runs.get(task.runId), result: { outcome: 'pass', summary: 'Too early' } });
  assert.equal(f.delivery.tasks.getResult(task.runId), null);
  await f.journal.appendEvent('family', makeEvent('attempt.started', { runId: task.runId, attemptId: reserved.attemptId, executionId: reserved.executionId, seed: { kind: 'initial' } }));
  const result = await reserved.activate();
  await f.journal.appendEvent('family', makeEvent('attempt.ended', { runId: task.runId, attemptId: reserved.attemptId, executionId: reserved.executionId, outcome: 'pass', summary: result.summary }));
  const originalAppend = f.journal.appendEvent;
  f.journal.appendEvent = async (owner, event, options) => {
    if (event.type === 'result.delivered') assert.equal(f.repository.getCommand(event.commandId)?.command.provenance.kind, 'delegation_result');
    return originalAppend(owner, event, options);
  };
  await f.delivery.onSettled({ run: (await f.journal.loadState('family')).runs.get(task.runId), result });
  await f.service.idle('parent');
  assert.equal(f.delivery.tasks.getResult(task.runId).summary, 'Child result.');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
  assert.equal((await f.journal.loadState('family')).runs.get(task.runId).delivered, true);
  await f.delivery.drain(); assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
});

test('busy recipient coalesces completions and later results form another immutable continuation cohort', async t => {
  const f = await fixture(t); f.setBusy(true);
  const first = await f.spawn('first'), second = await f.spawn('second');
  await f.complete(first); await f.complete(second);
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  const open = f.delivery.tasks.listCohorts();
  assert.equal(open.length, 1); assert.deepEqual(open[0].runIds, ['first', 'second']);
  f.setBusy(false); await f.delivery.drain(); await f.service.idle('parent');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
  const original = f.delivery.tasks.getResult('first');
  f.setBusy(true); const later = await f.spawn('later'); await f.complete(later);
  assert.equal(f.delivery.tasks.listCohorts()[0].runIds[0], 'later');
  f.setBusy(false); await f.delivery.drain(); await f.service.idle('parent');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 2);
  assert.deepEqual(f.delivery.tasks.getResult('first'), original);
});

test('local-only child continuation publishes its task result without an implicit parent wake', async t => {
  const f = await fixture(t), task = await f.spawn('local', { local: true });
  await f.complete(task); await f.service.idle();
  assert.equal(f.delivery.tasks.getResult(task.runId).completionPolicy.kind, 'local_only');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  assert.equal((await f.journal.loadState('family')).runs.get(task.runId).delivered, true);
});

test('inline wait holds automatic wake until its exact terminal tool result is canonical', async t => {
  const f = await fixture(t); f.setBusy(true);
  const fence = f.repository.claimExecution({ chatId: 'parent', executionId: 'parent-execution', ownerId: 'parent-host', captured: { policy: f.policy } });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: fence.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  const task = await f.spawn('inline', { inline: true }); await f.complete(task);
  const result = await f.delivery.waitForRun({ caller, runId: task.runId, journalOwnerId: 'family', toolCallId: 'spawn-inline' });
  assert.equal(result.status, 'completed'); assert.equal(f.delivery.tasks.getSubscription(task.runId).state, 'inline_returned');
  await f.delivery.drain(); assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  createChatTranscriptStore({ chatId: 'parent', fence, repository: f.repository }).append('parent',
    { role: 'tool', tool_call_id: 'spawn-inline', content: JSON.stringify(result) });
  await f.delivery.drain();
  assert.equal(f.delivery.tasks.getSubscription(task.runId).state, 'delivered');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('parent', fence);
});

test('raw parent Stop flag disposes an inline wake while missing canonical result after a crash permits one safe fallback', async t => {
  const f = await fixture(t); f.setLegacyActive(true);
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('parent');
  const first = await f.spawn('raw-stopped', { inline: true }); await f.complete(first);
  assert.equal(f.repository.getChat('parent').chatCommandVersion, undefined);
  f.repository.setAutoResumeBlocked('parent', true); f.setLegacyActive(false);
  await f.delivery.drain();
  assert.equal(f.delivery.tasks.getSubscription(first.runId).state, 'disposed');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  f.repository.setAutoResumeBlocked('parent', false); f.setLegacyActive(true);
  const fallback = await f.spawn('raw-crashed', { inline: true }); await f.complete(fallback);
  f.setLegacyActive(false); await f.delivery.drain(); await f.service.idle('parent');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
  assert.equal(f.delivery.tasks.getSubscription(fallback.runId).state, 'delivered');
});

test('lost delivery acknowledgement retries immediately without duplicating journal events or parent commands', async t => {
  const f = await fixture(t), task = await f.spawn('ack-loss');
  const finish = f.repository.finishOutbox; let fail = true;
  f.repository.finishOutbox = (...args) => {
    if (fail && f.repository.getOutbox(args[0]).kind === 'agent.result.ack') { fail = false; throw new Error('Lost SQLite acknowledgement'); }
    return finish(...args);
  };
  await assert.rejects(f.complete(task), /Lost SQLite acknowledgement/);
  await f.delivery.drain(); await f.service.idle('parent');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
  assert.equal((await f.journal.readEvents('family')).filter(event => event.type === 'result.delivered' && event.runId === task.runId).length, 1);
});

test('restart reconstructs missing publication after terminal journal durability without rerunning the child', async t => {
  const f = await fixture(t), task = await f.spawn('restart');
  await f.complete(task, { publish: false });
  assert.equal(f.delivery.tasks.getResult(task.runId), null);
  await f.reopen(); await f.delivery.recover(); await f.delivery.start(); await f.service.idle('parent');
  assert.equal(f.delivery.tasks.getResult(task.runId).status, 'completed');
  assert.equal(f.calls.filter(call => call.chatId === task.childChatId).length, 1);
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
});

test('recovery reconciles a removed queued command before graph admission and preserves its cancellation receipt', async t => {
  const f = await fixture(t), task = await f.spawn('removed-before-journal');
  const original = f.repository.getCommand(task.commandId);
  await f.service.removeQueued(f.caller, { chatId: task.childChatId, targetCommandId: task.commandId,
    expectedRevision: original.revision, clientRequestId: 'remove-before-crash' });
  assert.equal((await f.journal.loadState('family')).runs.get(task.runId).phase, 'idle');
  await f.delivery.recover(); await f.delivery.recover();
  assert.equal((await f.journal.loadState('family')).runs.get(task.runId).phase, 'cancelled');
  assert.equal(f.delivery.tasks.getResult(task.runId).status, 'cancelled');
  assert.equal(f.repository.getCommand(task.commandId).result.disposition, 'removed');
  assert.equal((await f.journal.readEvents('family')).filter(event => event.type === 'run.cancelled').length, 1);
  assert.equal(f.calls.filter(call => call.chatId === task.childChatId).length, 0);
});

test('cancelled epoch and a missing recipient resolve subscriptions without losing immutable results or waking a replacement', async t => {
  const f = await fixture(t); f.setBusy(true);
  const stopped = await f.spawn('old-epoch'); await f.complete(stopped);
  f.repository.advanceCancellationEpoch('parent'); f.setBusy(false);
  await f.delivery.drain(); assert.equal(f.delivery.tasks.getSubscription(stopped.runId).state, 'disposed');
  const missing = await f.spawn('missing'); await f.complete(missing, { publish: false });
  f.db.prepare('DELETE FROM chats WHERE id=?').run('parent');
  await f.delivery.onSettled({ run: (await f.journal.loadState('family')).runs.get(missing.runId), result: { outcome: 'pass' } });
  assert.equal(f.delivery.tasks.getSubscription(missing.runId).state, 'disposed');
  assert.equal(f.delivery.tasks.getResult(stopped.runId).status, 'completed');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
});

test('benign interrupted child ownership recovers into a retryable command before journal replay', async t => {
  const f = await fixture(t), task = await f.spawn('interrupted');
  const prior = await f.interrupted(task);
  await f.service.recoverExecutions(() => ({ verified: true, source: 'test-runtime-quiescent', checkedAt: 2000 }));
  assert.equal(f.repository.getCommand(task.commandId).state, 'queued');
  assert.equal(f.repository.getCommand(task.commandId).held, false);
  await f.delivery.recover();
  const state = await f.journal.loadState('family');
  assert.equal(state.runs.get(task.runId).attempts[0].ended, true);
  assert.equal(f.delivery.tasks.getResult(task.runId), null);
  const handle = await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'retry-after-interruption' });
  assert.notEqual(handle.executionId, prior.executionId);
  handle.stop(); await handle.finished;
});

test('a crash before attempt.started retires the empty reservation without consuming a graph attempt', async t => {
  const f = await fixture(t), task = await f.spawn('unstarted');
  const prior = await f.interrupted(task, { activated: false });
  await f.service.recoverExecutions(() => ({ verified: true, source: 'test-no-native-owner', checkedAt: 2000 }));
  await f.delivery.recover();
  assert.equal((await f.journal.loadState('family')).runs.get(task.runId).attempts.length, 0);
  const handle = await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: prior.attemptId });
  assert.notEqual(handle.deferred, true); assert.notEqual(handle.executionId, prior.executionId);
  handle.stop(); await handle.finished;
});

test('restart preserves an ambiguous real effect as a held recovery barrier and never repeats it', async t => {
  const f = await fixture(t), task = await f.spawn('ambiguous');
  await f.interrupted(task, { effect: true });
  await f.service.recoverExecutions(() => ({ verified: true, source: 'test-process-replaced', checkedAt: 2000 }));
  await f.delivery.recover(); await f.delivery.recover();
  const state = await f.journal.loadState('family');
  assert.equal(state.runs.get(task.runId).recoveryRequired, true);
  assert.equal(f.repository.getCommand(task.commandId).held, true);
  assert.equal(f.repository.getCommand(task.commandId).state, 'queued');
  assert.equal(f.delivery.tasks.getResult(task.runId), null);
  assert.equal((await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'unsafe-repeat' })).deferred, true);
  assert.equal(await fs.readFile(path.join(f.home, 'effect.txt'), 'utf8'), 'One effect');
  assert.equal((await f.journal.readEvents('family')).filter(event => event.type === 'attempt.ended').length, 1);
});

test('chat Stop cancels running and queued descendants, retains partials and holds queued parent input', async t => {
  const f = await fixture(t);
  const child = await f.spawn('running-child');
  const grandchild = await f.spawn('running-grandchild', { parentChatId: child.childChatId });
  const queued = await f.spawn('queued-grandchild', { parentChatId: child.childChatId });
  f.setExecute(async input => {
    const store = createChatTranscriptStore({ chatId: input.command.chatId, fence: input.fence, repository: f.repository });
    store.append(input.command.chatId, { role: 'assistant', content: 'Saved partial output' });
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'crashed', error: 'Stopped' };
  });
  const parent = await f.service.send(f.caller, { chatId: 'parent', message: 'Delegate work', clientRequestId: 'parent-work' });
  const handles = [];
  for (const task of [child, grandchild]) {
    const handle = await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'attempt-' + task.runId });
    await f.journal.appendEvent('family', makeEvent('attempt.started', { runId: task.runId, attemptId: handle.attemptId,
      executionId: handle.executionId, seed: { kind: 'initial' } }));
    void handle.activate(); handles.push(handle);
  }
  for (let i = 0; i < 100 && f.calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 3);
  const followup = await f.service.send(f.caller, { chatId: 'parent', message: 'Preserve this next turn', mode: 'queue', clientRequestId: 'queued-parent' });
  const executionId = f.repository.getCommand(parent.commandId).executionId;
  const stopped = await f.service.stop(f.caller, { chatId: 'parent', executionId, scope: 'tree', clientRequestId: 'stop-chat' });
  await f.service.idle();
  assert.equal(stopped.state, 'settled');
  for (const id of [executionId, ...handles.map(handle => handle.executionId)]) {
    const execution = f.repository.getExecution(id);
    assert.equal(execution.status, 'stopped');
    assert.ok(f.repository.readTranscript(execution.chatId).messages.some(row => row.content === 'Saved partial output'));
  }
  for (const task of [child, grandchild, queued]) {
    assert.equal(f.delivery.tasks.getResult(task.runId).status, 'cancelled');
  }
  assert.equal(f.repository.getCommand(followup.commandId).held, true);
  await f.delivery.drain();
  assert.equal(f.calls.length, 3, 'cancelled children cannot wake the parent or start queued work');
});

test('tree cancellation snapshots its scope, stops a live child and cannot cancel newer work on replay', async t => {
  const f = await fixture(t);
  const old = await f.spawn('original'); f.setBusy(true); await f.complete(old);
  const originalResult = f.delivery.tasks.getResult(old.runId);
  const live = await f.spawn('live');
  let began; const started = new Promise(resolve => { began = resolve; });
  f.setExecute(async input => {
    began();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'crashed', error: 'Stopped' };
  });
  const handle = await f.service.startAdmittedChildTask({ commandId: live.commandId, runId: live.runId, attemptId: 'live-attempt' });
  await f.journal.appendEvent('family', makeEvent('attempt.started', { runId: live.runId, attemptId: handle.attemptId,
    executionId: handle.executionId, seed: { kind: 'initial' } }));
  void handle.activate(); await started;
  const boundary = f.repository.listCommands({ limit: 1000 }).at(-1).position;
  f.repository.advanceCancellationEpoch('parent');
  await f.delivery.cancelTree({ chatId: 'parent', commandId: 'tree-stop', throughPosition: boundary });
  assert.equal(f.repository.getExecution(handle.executionId).status, 'stopped');
  assert.equal(f.delivery.tasks.getResult(live.runId).status, 'cancelled');
  assert.deepEqual(f.delivery.tasks.getResult(old.runId), originalResult);
  const childEpoch = f.repository.getCancellationEpoch(live.childChatId);
  const future = await f.service.send(f.caller, { chatId: live.childChatId, message: 'Explicit new work', clientRequestId: 'new-work' });
  await f.service.idle(live.childChatId);
  await f.delivery.cancelTree({ chatId: 'parent', commandId: 'tree-stop', throughPosition: boundary });
  assert.equal(f.repository.getCommand(future.commandId).held, false);
  assert.equal(f.repository.getCancellationEpoch(live.childChatId), childEpoch);
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
});

test('a lost admission receipt reuses its durable completion command instead of scheduling a second parent turn', async t => {
  const f = await fixture(t), task = await f.spawn('admission-loss');
  const settle = f.delivery.tasks.settleCohort; let fail = true;
  f.delivery.tasks.settleCohort = (...args) => {
    if (fail && args[1].state === 'admitted') { fail = false; throw new Error('Crashed after durable command admission'); }
    return settle(...args);
  };
  await assert.rejects(f.complete(task), /durable command admission/);
  await f.delivery.drain(); await f.service.idle('parent');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
  assert.equal(f.repository.listCommands({ chatId: 'parent' }).length, 1);
  assert.equal(f.delivery.tasks.getSubscription(task.runId).state, 'delivered');
});

test('the human agents-only scope settles a live child without stopping the parent or consuming its queued turn', async t => {
  const f = await fixture(t);
  let parentReady, childReady, finishParent;
  const parentStarted = new Promise(resolve => { parentReady = resolve; });
  const childStarted = new Promise(resolve => { childReady = resolve; });
  const parentFinished = new Promise(resolve => { finishParent = resolve; });
  f.setExecute(async input => {
    if (input.command.chatId === 'parent') {
      parentReady();
      await Promise.race([parentFinished, new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))]);
      return { outcome: 'no_report' };
    }
    childReady();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'crashed', error: 'Stopped' };
  });
  const parent = await f.service.send(f.caller, { chatId: 'parent', message: 'Continue the parent', clientRequestId: 'parent-work' });
  await parentStarted;
  const queued = await f.service.send(f.caller, { chatId: 'parent', message: 'A later human turn', mode: 'queue', clientRequestId: 'later-human' });
  const task = await f.spawn('agents-only');
  const handle = await f.service.startAdmittedChildTask({ commandId: task.commandId, runId: task.runId, attemptId: 'child-attempt' });
  await f.journal.appendEvent('family', makeEvent('attempt.started', { runId: task.runId, attemptId: handle.attemptId,
    executionId: handle.executionId, seed: { kind: 'initial' } }));
  void handle.activate(); await childStarted;
  const receipt = await f.service.stop(f.caller, { chatId: 'parent', scope: 'agents', clientRequestId: 'stop-agents' });
  assert.equal(receipt.state, 'settled');
  assert.equal(f.repository.getExecution(handle.executionId).status, 'stopped');
  assert.equal(f.delivery.tasks.getResult(task.runId).status, 'cancelled');
  const parentExecution = f.repository.getCommand(parent.commandId).executionId;
  assert.equal(f.repository.getExecution(parentExecution).status, 'running');
  assert.equal(f.calls.find(call => call.executionId === parentExecution).input.signal.aborted, false);
  assert.equal(f.repository.getCommand(queued.commandId).held, false);
  finishParent(); await f.service.idle('parent');
  assert.equal(f.repository.getCommand(queued.commandId).state, 'settled');
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 2);
  assert.equal(f.delivery.tasks.getSubscription(task.runId).state, 'disposed');
});

test('escaped long summaries remain a bounded complete cohort with links to the full canonical task results', async t => {
  const f = await fixture(t); f.setBusy(true);
  const summary = '"Escaped control\\path"\n'.repeat(6000);
  f.setExecute(async input => input.command.chatId === 'parent' ? { outcome: 'no_report' } : { outcome: 'pass', summary });
  for (const runId of ['long-one', 'long-two']) await f.complete(await f.spawn(runId));
  f.setBusy(false); await f.delivery.drain(); await f.service.idle('parent');
  const command = f.repository.listCommands({ chatId: 'parent' })[0];
  assert.ok(command.command.message.length < 120000);
  assert.match(command.command.message, /long-one/); assert.match(command.command.message, /long-two/);
  assert.match(command.command.message, /summaryTruncated/);
  assert.equal(f.delivery.tasks.getResult('long-one').summary.length, 120000);
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 1);
});

test('pending inline task wait pauses the same parent execution and returns it to running after the durable result', async t => {
  const f = await fixture(t); f.setBusy(true);
  const fence = f.repository.claimExecution({ chatId: 'parent', executionId: 'parent-execution', ownerId: 'parent-host', captured: { policy: f.policy } });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: fence.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  const task = await f.spawn('pending-inline', { inline: true });
  let notify; const paused = new Promise(resolve => { notify = resolve; });
  const update = f.repository.updateExecution;
  f.repository.updateExecution = (...args) => { const row = update(...args); if (row.status === 'waiting_for_agents') notify(row); return row; };
  const waiting = f.delivery.waitForRun({ caller, runId: task.runId, journalOwnerId: 'family', toolCallId: 'spawn-pending-inline' });
  assert.equal((await paused).executionId, fence.executionId);
  assert.equal(f.repository.getExecution(fence.executionId).status, 'waiting_for_agents');
  await f.complete(task);
  const result = await waiting;
  assert.equal(result.status, 'completed');
  assert.equal(f.repository.getExecution(fence.executionId).status, 'running');
  assert.equal(f.delivery.tasks.getSubscription(task.runId).state, 'inline_returned');
  createChatTranscriptStore({ chatId: 'parent', fence, repository: f.repository }).append('parent',
    { role: 'tool', tool_call_id: 'spawn-pending-inline', content: JSON.stringify(result) });
  await f.delivery.drain();
  assert.equal(f.calls.filter(call => call.chatId === 'parent').length, 0);
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('parent', fence);
});
