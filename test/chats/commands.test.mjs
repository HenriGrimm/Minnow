import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { getAgentConversationsFeature } from '../../server/chats/feature.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function hasCode(expected) { return (error) => error?.code === expected; }
async function fixture(t, options = {}) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db, now: () => 1000 });
  const registry = createChatProjectRegistry([
    { projectId: 'project', workspaceId: 'main', canonicalKey: 'C:/fixture' },
    { projectId: 'project', workspaceId: 'worktree', canonicalKey: 'C:/worktree' },
    { projectId: 'other-project', workspaceId: 'other', canonicalKey: 'C:/other' },
  ]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const policy = createChatPolicy({ modeId: 'build', toolPermissions: { read_file: 'full' },
    toolEffects: { read_file: 'read' }, workspaceIds: ['main', 'worktree'],
    capabilities: ['chat.read', 'chat.send', 'chat.stop', 'agent.spawn', 'request.respond', 'execution.host'] });
  for (const name of ['target', 'sender']) repository.createChat({
    id: name, name, workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build',
  });
  repository.createChat({ id: 'foreign', name: 'foreign', workspacePath: 'C:/other', providerId: 'provider', modelId: 'model', modeId: 'build' });
  const overrides = new Map();
  const context = { async resolveTarget(chatId) {
    const chat = repository.getChat(chatId);
    const resolvedScope = resolveProjectScope(registry, {
      projectId: chatId === 'foreign' ? 'other-project' : 'project', workspaceKey: chat.workspacePath,
    });
    const currentPolicy = overrides.get(chatId) ?? policy;
    return { chat, scope: resolvedScope, policy: currentPolicy, currentPolicy, profile: repository.getLatestProfile(chatId),
      registry, project: { registry, projectId: resolvedScope.projectId, scope: resolvedScope } };
  } };
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  let modelCalls = 0, count = 0;
  const events = [], errors = [];
  const service = createChatCommandService({
    repository, context, feature: () => getAgentConversationsFeature({ NODE_ENV: 'test', MINNOW_AGENT_CONVERSATIONS: '1' }),
    resolveModelSelection: ({ selection }) => { modelCalls += 1; return selection; },
    now: () => 1000, id: () => 'allocated-' + (++count), onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error), ...options,
  });
  t.after(async () => { await service.dispose(); db.close(); });
  function host(execute, extra = {}) {
    return service.registerHost({ id: 'server-host', kind: 'server', supportsSteer: true, execute, ...extra });
  }
  function appendInitial({ command, fence }) {
    const messageId = 'input-' + command.commandId;
    repository.appendMessage(command.chatId, { role: 'user', content: command.message, provenance: command.provenance,
      commandId: command.commandId, ...(command.images ? { images: command.images } : {}) }, { fence, messageId, commandId: command.commandId });
  }
  return { db, repository, registry, scope, policy, context, caller, service, host, appendInitial, events, errors, overrides,
    modelCalls: () => modelCalls };
}

test('durable acceptance starts one host and repeated keys return the original captured model before catalog resolution', async t => {
  const f = await fixture(t);
  let turns = 0;
  f.host(async (input) => { turns += 1; f.appendInitial(input); return { outcome: 'no_report' }; });
  const first = await f.service.send(f.caller, { chatId: 'target', message: 'Original instruction', clientRequestId: 'request' });
  await f.service.idle('target');
  f.repository.configureChat('target', { providerId: 'other', modelId: 'new-model' });
  const again = await f.service.send(f.caller, { chatId: 'target', message: 'Original instruction', clientRequestId: 'request' });
  assert.equal(again.commandId, first.commandId);
  assert.equal(again.replayed, true);
  assert.equal(f.modelCalls(), 1);
  assert.equal(turns, 1);
  assert.equal(f.repository.readTranscript('target').messages.length, 1);
  assert.equal(f.repository.getCommand(first.commandId).command.modelSelection.modelId, 'model');
  assert.equal(f.repository.getLease('target').state, 'released');
  await assert.rejects(f.service.send(f.caller, { chatId: 'target', message: 'Changed instruction', clientRequestId: 'request' }), hasCode('idempotency_conflict'));
});

test('command observer failures drain asynchronous error reporting before disposal completes', async t => {
  const observed = deferred(), release = deferred(), reporting = deferred();
  const f = await fixture(t, { onCommand: async () => { observed.resolve(); throw new Error('observer failed'); },
    onError: async () => { reporting.resolve(); await release.promise; throw new Error('reporter failed'); } });
  await f.service.send(f.caller, { chatId: 'target', message: 'Accepted despite observer error', clientRequestId: 'async-report' });
  await observed.promise; await reporting.promise;
  let disposed = false; const disposal = f.service.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  release.resolve(); await disposal; assert.equal(disposed, true);
});

test('scoped idle waits for command observers only in its chat and reports their admission failures', async t => {
  const gate = deferred(); let began = false;
  const f = await fixture(t, { onCommand: async record => {
    if (record.chatId === 'target' && !began) { began = true; await gate.promise; }
  } });
  await f.service.send(f.caller, { chatId: 'target', message: 'Track my observer', clientRequestId: 'observer' });
  let completed = false; const pending = f.service.idle('target').then(() => { completed = true; });
  await f.service.idle('sender');
  assert.equal(began, true); assert.equal(completed, false);
  gate.resolve(); await pending; assert.equal(completed, true);
  let failed = false;
  const other = await fixture(t, { onCommand() { if (!failed) { failed = true; throw new Error('Observer admission failed'); } } });
  const receipt = await other.service.send(other.caller, { chatId: 'target', message: 'Durably accepted', clientRequestId: 'observer-failure' });
  assert.ok(other.repository.getCommand(receipt.commandId));
  await assert.rejects(other.service.idle('target'), /Observer admission failed/);
  assert.equal(other.errors.length, 1);
});

test('dispose drains observers and follow-on observer work before their repository may close', async t => {
  const initial = deferred(), nested = deferred(), nestedStarted = deferred();
  let f, sawInitial = false, sawNested = false, reads = 0;
  f = await fixture(t, { onCommand: async record => {
    if (record.command.kind === 'send' && !sawInitial) {
      sawInitial = true; await initial.promise; f.repository.getChat('target'); reads++;
      await f.service.stop(f.caller, { chatId: 'target', scope: 'turn', clientRequestId: 'observer-stop' });
    } else if (record.command.kind === 'stop' && !sawNested) {
      sawNested = true; nestedStarted.resolve(); await nested.promise; f.repository.getChat('target'); reads++;
    }
  } });
  await f.service.send(f.caller, { chatId: 'target', message: 'Drain background registration', clientRequestId: 'dispose-observer' });
  let disposed = false; const disposing = f.service.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  initial.resolve(); await nestedStarted.promise;
  assert.equal(disposed, false); nested.resolve(); await disposing;
  assert.equal(disposed, true); assert.equal(reads, 2); assert.deepEqual(f.errors, []);
});

test('first admission captures an immutable profile without taking unflushed legacy history ownership', async t => {
  let external = true, captures = 0;
  const f = await fixture(t, { hasExternalOwner: () => external,
    captureProfile: async ({ target, selection }) => {
      captures++;
      return { profileId: 'captured-root', profileVersion: 1,
        snapshot: { policy: target.policy, modelSelection: selection, prompt: 'Original admission prompt' } };
    },
  });
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('target');
  const request = { chatId: 'target', message: 'Continue after the original owner', clientRequestId: 'capture-root' };
  const accepted = await f.service.send(f.caller, request);
  await f.service.idle('target');
  assert.equal(captures, 1);
  assert.equal(f.repository.getChat('target').chatCommandVersion, undefined);
  const command = f.repository.getCommand(accepted.commandId);
  assert.deepEqual(command.command.profileReference, { profileId: 'captured-root', profileVersion: 1 });
  assert.equal(command.captured.profile.snapshot.prompt, 'Original admission prompt');
  f.repository.saveProfile('target', { profileId: 'captured-root', profileVersion: 2,
    snapshot: { policy: f.policy, modelSelection: { providerId: 'other', modelId: 'later' }, prompt: 'Later configuration' } });
  assert.equal((await f.service.send(f.caller, request)).replayed, true);
  assert.equal(captures, 1);
  let executing;
  f.host(async input => { executing = input.execution; f.appendInitial(input); return { outcome: 'no_report' }; });
  await f.service.idle('target'); assert.equal(executing, undefined);
  external = false; await f.service.kick('target');
  assert.equal(executing.captured.profile.snapshot.prompt, 'Original admission prompt');
  assert.equal(executing.captured.profile.profileVersion, 1);
  assert.equal(f.repository.getChat('target').chatCommandVersion, 1);
  assert.equal(f.repository.getCommand(accepted.commandId).state, 'settled');
});

test('Stop during initial profile capture commits neither a stale profile nor its pending input', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { captureProfile: async ({ target, selection }) => {
    entered.resolve(); await release.promise;
    return { profileId: 'cancelled-profile', profileVersion: 1, snapshot: { policy: target.policy, modelSelection: selection } };
  } });
  const pending = f.service.send(f.caller, { chatId: 'target', message: 'Stopped during capture', clientRequestId: 'capture-stop' });
  pending.catch(() => {});
  await entered.promise;
  await f.service.stop(f.caller, { chatId: 'target', clientRequestId: 'stop-capture' });
  release.resolve();
  await assert.rejects(pending, hasCode('ownership_conflict'));
  assert.equal(f.repository.getLatestProfile('target'), null);
  assert.equal(f.repository.listCommands({ chatId: 'target' }).filter(row => row.command.kind === 'send').length, 0);
});

test('accepted commands and explicit steers retain order, provenance and canonical row identities', async t => {
  const f = await fixture(t);
  const started = deferred(), finish = deferred(); let activeInput;
  f.host(async (input) => {
    f.appendInitial(input);
    if (!activeInput) { activeInput = input; started.resolve(); await finish.promise; }
    return { outcome: 'no_report' };
  });
  await f.service.send(f.caller, { chatId: 'target', message: 'Initial work', clientRequestId: 'initial' });
  await started.promise;
  const first = await f.service.send(f.caller, { chatId: 'target', message: 'First correction', mode: 'steer', clientRequestId: 'steer-1' });
  const second = await f.service.send(f.caller, { chatId: 'target', message: 'Second correction', mode: 'steer', clientRequestId: 'steer-2' });
  const queued = await f.service.send(f.caller, { chatId: 'target', message: 'Separate next turn', mode: 'queue', clientRequestId: 'queued' });
  const consumed = activeInput.takeSteers();
  assert.deepEqual(consumed.messages.map((row) => row.content), ['First correction', 'Second correction']);
  assert.deepEqual(consumed.rowIds, [1, 2]);
  assert.equal(consumed.messages[0].provenance.actor, 'human');
  assert.equal(activeInput.takeSteers(), null);
  assert.equal(f.repository.getCommand(first.commandId).state, 'settled');
  assert.equal(f.repository.getCommand(second.commandId).result.disposition, 'steered');
  finish.resolve(); await f.service.idle('target');
  assert.equal(f.repository.getCommand(queued.commandId).state, 'settled');
  assert.deepEqual(f.repository.readTranscript('target').messages.map((row) => row.content), [
    'Initial work', 'First correction', 'Second correction', 'Separate next turn',
  ]);
});

test('three concurrent admitted sends run serially and preserve captured bindings across local configuration changes', async t => {
  const f = await fixture(t);
  const started = deferred(), finish = deferred(); let calls = 0, simultaneous = 0, maxLive = 0;
  f.host(async (input) => {
    simultaneous += 1; maxLive = Math.max(maxLive, simultaneous); calls += 1;
    f.appendInitial(input);
    if (calls === 1) { started.resolve(); await finish.promise; }
    simultaneous -= 1; return { outcome: 'no_report' };
  });
  await f.service.send(f.caller, { chatId: 'target', message: 'First', clientRequestId: 'first' });
  await started.promise;
  const [second, third] = await Promise.all([
    f.service.send(f.caller, { chatId: 'target', message: 'Second', clientRequestId: 'second' }),
    f.service.send(f.caller, { chatId: 'target', message: 'Third', clientRequestId: 'third' }),
  ]);
  f.repository.configureChat('target', { providerId: 'new-provider', modelId: 'new-model' });
  assert.equal(f.repository.getCommand(second.commandId).command.modelSelection.modelId, 'model');
  assert.ok(third.position > second.position);
  finish.resolve(); await f.service.idle('target');
  assert.equal(maxLive, 1);
  assert.deepEqual(f.repository.readTranscript('target').messages.map((row) => row.content), ['First', 'Second', 'Third']);
});

test('queue editing/removal/push are revision-controlled commands and retries do not repeat their effects', async t => {
  const f = await fixture(t);
  const waiting = await f.service.send(f.caller, { chatId: 'target', message: 'Draft', clientRequestId: 'draft' });
  await f.service.idle('target');
  const stored = f.repository.getCommand(waiting.commandId);
  const edited = await f.service.editQueued(f.caller, { chatId: 'target', targetCommandId: waiting.commandId,
    expectedRevision: stored.revision, message: 'Edited', clientRequestId: 'edit' });
  const repeated = await f.service.editQueued(f.caller, { chatId: 'target', targetCommandId: waiting.commandId,
    expectedRevision: stored.revision, message: 'Edited', clientRequestId: 'edit' });
  assert.equal(repeated.commandId, edited.commandId);
  assert.equal(repeated.replayed, true);
  assert.equal(f.repository.getCommand(waiting.commandId).command.message, 'Draft');
  assert.equal(f.repository.getCommand(waiting.commandId).effectiveCommand.message, 'Edited');
  await assert.rejects(f.service.removeQueued(f.caller, { chatId: 'target', targetCommandId: waiting.commandId,
    expectedRevision: stored.revision, clientRequestId: 'stale-remove' }), hasCode('stale_revision'));
  await f.service.removeQueued(f.caller, { chatId: 'target', targetCommandId: waiting.commandId,
    expectedRevision: f.repository.getCommand(waiting.commandId).revision, clientRequestId: 'remove' });
  assert.equal(f.repository.getCommand(waiting.commandId).state, 'cancelled');
});

test('Stop signals the actual host, holds prior queued inputs and preserves unapplied corrections for explicit resumption', async t => {
  const f = await fixture(t); const started = deferred(); let aborted = false, input;
  f.host(async (value) => {
    input = value; f.appendInitial(value); started.resolve();
    await new Promise((resolve) => value.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return { outcome: 'no_report' };
  });
  await f.service.send(f.caller, { chatId: 'target', message: 'Work', clientRequestId: 'work' }); await started.promise;
  const correction = await f.service.send(f.caller, { chatId: 'target', message: 'Keep this correction', mode: 'steer', clientRequestId: 'correction' });
  const following = await f.service.send(f.caller, { chatId: 'target', message: 'Queued work', mode: 'queue', clientRequestId: 'follow' });
  const stopped = await f.service.stop(f.caller, { chatId: 'target', clientRequestId: 'stop' });
  await f.service.idle('target');
  assert.equal(aborted, true); assert.equal(stopped.result.stopRequested, true);
  assert.equal(f.repository.getExecution(input.execution.executionId).status, 'stopped');
  const preserved = f.repository.getCommand(correction.commandId);
  assert.equal(preserved.held, true);
  assert.equal(preserved.effectiveCommand.kind, 'send');
  assert.equal(preserved.effectiveCommand.message, 'Keep this correction');
  assert.equal(f.repository.getCommand(following.commandId).held, true);
  assert.equal(f.repository.readTranscript('target').messages.length, 1);
});

test('a stale pinned Stop cannot abort a later execution', async t => {
  const f = await fixture(t); const started = deferred(), finish = deferred(); let input;
  f.host(async (value) => { input = value; f.appendInitial(value); started.resolve(); await finish.promise; return { outcome: 'no_report' }; });
  await f.service.send(f.caller, { chatId: 'target', message: 'New work' }); await started.promise;
  const stopped = await f.service.stop(f.caller, { chatId: 'target', executionId: 'old-execution', clientRequestId: 'stale-stop' });
  assert.equal(stopped.result.stopRequested, false);
  assert.equal(input.signal.aborted, false);
  finish.resolve(); await f.service.idle('target');
});

test('explicit steering fails without an active capable host and Push now never changes a captured model', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.send(f.caller, { chatId: 'target', message: 'Correction', mode: 'steer' }), hasCode('steer_unsupported'));
  const started = deferred(), finish = deferred(); let input;
  f.host(async (value) => { input = value; f.appendInitial(value); started.resolve(); await finish.promise; return { outcome: 'no_report' }; });
  await f.service.send(f.caller, { chatId: 'target', message: 'Work' }); await started.promise;
  f.repository.configureChat('target', { providerId: 'other', modelId: 'other-model' });
  const queued = await f.service.send(f.caller, { chatId: 'target', message: 'Other-model work', mode: 'queue' });
  await assert.rejects(f.service.pushQueued(f.caller, { chatId: 'target', targetCommandId: queued.commandId,
    expectedRevision: f.repository.getCommand(queued.commandId).revision }), hasCode('options_unsupported'));
  assert.equal(input.signal.aborted, false);
  finish.resolve(); await f.service.idle('target');
});

test('ordinary peers require a live branded caller, same project and a target within their current ceiling', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.send({ ...f.caller }, { chatId: 'target', message: 'Forged' }), hasCode('caller_denied'));
  await assert.rejects(f.service.send(f.caller, { chatId: 'foreign', message: 'Cross project' }), hasCode('workspace_denied'));
  const fence = f.repository.claimExecution({ chatId: 'sender', executionId: 'sender-execution', ownerId: 'sender-host' });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'sender', executionId: fence.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  const sent = await f.service.send(caller, { chatId: 'target', message: 'Peer instruction', clientRequestId: 'peer' });
  const recorded = f.repository.getCommand(sent.commandId);
  assert.equal(recorded.command.provenance.actor, 'agent');
  assert.equal(recorded.command.provenance.sourceChatId, 'sender');
  assert.equal(recorded.command.provenance.sourceTurnId, 'sender-execution');
  await assert.rejects(f.service.send(caller, { chatId: 'sender', message: 'Self' }), hasCode('invalid_request'));
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence });
  f.repository.releaseLease('sender', fence);
  await assert.rejects(f.service.send(caller, { chatId: 'target', message: 'Stale' }), hasCode('caller_not_active'));
});

test('a restricted Plan sender cannot dispatch into a broader target or change another chat model', async t => {
  const f = await fixture(t);
  const restricted = createChatPolicy({ modeId: 'plan', toolPermissions: { read_file: 'full' }, toolEffects: { read_file: 'read' },
    workspaceIds: ['main', 'worktree'], capabilities: ['chat.read', 'chat.send', 'execution.host'] });
  const fence = f.repository.claimExecution({ chatId: 'sender', executionId: 'plan-execution', ownerId: 'planner' });
  f.overrides.set('sender', restricted);
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'sender', executionId: fence.executionId,
    executionActive: true, scope: f.scope, policy: restricted });
  await assert.rejects(f.service.send(caller, { chatId: 'target', message: 'Do broader work' }), hasCode('policy_denied'));
  await assert.rejects(f.service.send(f.caller, { chatId: 'target', message: 'Model override', modelSelection: { providerId: 'evil', modelId: 'evil' } }), hasCode('invalid_request'));
});

test('legacy external ownership delays managed takeover until the old transcript flush completes', async t => {
  let external = true;
  const f = await fixture(t, { hasExternalOwner: () => external });
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('target');
  let executions = 0;
  f.host(async (input) => { executions += 1; f.appendInitial(input); return { outcome: 'no_report' }; });
  const queued = await f.service.send(f.caller, { chatId: 'target', message: 'After legacy work' });
  await f.service.idle('target');
  assert.equal(f.repository.getChat('target').chatCommandVersion, undefined);
  assert.equal(executions, 0);
  external = false;
  await f.service.kick('target');
  assert.equal(f.repository.getChat('target').chatCommandVersion, 1);
  assert.equal(f.repository.getCommand(queued.commandId).state, 'settled');
  assert.equal(executions, 1);
});

test('a child send cannot bypass its existing task capacity scheduler', async t => {
  const f = await fixture(t); let executions = 0;
  f.repository.createChild({
    chat: { id: 'child', name: 'Child', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model', modeId: 'build' },
    relation: { version: 1, childChatId: 'child', parentChatId: 'target', rootChatId: 'target', journalOwnerId: 'target',
      origin: 'delegated', createdAt: 1 },
    profile: { profileId: 'child-profile', profileVersion: 1, snapshot: { policy: f.policy } }, projectId: 'project',
  });
  f.host(async () => { executions += 1; return { outcome: 'no_report' }; });
  const queued = await f.service.send(f.caller, { chatId: 'child', message: 'Child follow-up' });
  await f.service.idle('child');
  assert.equal(executions, 0);
  assert.equal(f.repository.getCommand(queued.commandId).state, 'waiting_for_host');
  assert.equal(f.repository.getLease('child'), null);
});

test('renderer-free waiting inputs restart from durable commands when a capable host registers', async t => {
  const f = await fixture(t);
  const command = await f.service.send(f.caller, { chatId: 'target', message: 'Persisted before a host exists' });
  await f.service.idle('target');
  assert.equal(f.repository.getCommand(command.commandId).state, 'waiting_for_host');
  f.host(async (input) => { f.appendInitial(input); return { outcome: 'no_report' }; });
  await f.service.idle('target');
  assert.equal(f.repository.getCommand(command.commandId).state, 'settled');
  assert.equal(f.repository.readTranscript('target').messages.length, 1);
});

test('missing capability remains waiting and an unresolved tool intent stops automatic continuation', async t => {
  const f = await fixture(t);
  f.host(async () => ({ outcome: 'crashed', failure: { waitingForHost: true, requiredCapabilities: ['browser'] } }));
  const waiting = await f.service.send(f.caller, { chatId: 'target', message: 'Use the browser' });
  await f.service.idle('target');
  assert.equal(f.repository.getCommand(waiting.commandId).state, 'waiting_for_host');
  assert.equal(f.repository.getLease('target').state, 'released');
  let repeated = 0;
  const unregister = f.service.registerHost({ id: 'browser-host', kind: 'renderer', supportsSteer: true, capabilities: ['browser'],
    async execute(input) {
      repeated += 1; f.appendInitial(input);
      f.repository.recordToolIntent({ invocationId: 'unknown-effect', chatId: 'target',
        executionId: input.execution.executionId, toolCallId: 'call', toolName: 'save_file', input: { path: 'scratch' } }, { fence: input.fence });
      return { outcome: 'crashed', failure: { recoveryRequired: true } };
    } });
  await f.service.idle('target');
  assert.equal(repeated, 1);
  assert.equal(f.repository.getCommand(waiting.commandId).error.code, 'recovery_required');
  assert.equal(f.repository.getLatestExecution('target').status, 'recovery_required');
  unregister(); await f.service.kick('target');
  assert.equal(repeated, 1);
});

test('tree cancellation retries a durable control and never reports an unconfirmed subtree stop as settled', async t => {
  let failures = 1, calls = 0;
  const f = await fixture(t, { cancelTree: async ({ commandId, cancellationEpoch, throughPosition }) => {
    calls += 1; assert.ok(commandId); assert.ok(cancellationEpoch > 0); assert.ok(throughPosition > 0);
    if (failures-- > 0) throw new Error('Transient cancellation transport');
  } });
  const result = await f.service.stop(f.caller, { chatId: 'target', scope: 'tree', clientRequestId: 'stop-tree' });
  assert.equal(result.state, 'queued');
  await f.service.kick('target');
  assert.equal(f.repository.getCommand(result.commandId).state, 'settled');
  assert.equal(calls, 2);
  const replay = await f.service.stop(f.caller, { chatId: 'target', scope: 'tree', clientRequestId: 'stop-tree' });
  assert.equal(replay.replayed, true); assert.equal(calls, 2);
});

test('Stop agents preserves the parent turn and its queued human inputs while disposing its old delegation authority', async t => {
  const calls = [], started = deferred(), finish = deferred(); let firstInput;
  const f = await fixture(t, { cancelTree: input => { calls.push(input); } });
  f.host(async input => {
    f.appendInitial(input);
    if (!firstInput) { firstInput = input; started.resolve(); await finish.promise; }
    else assert.equal(input.execution.captured.cancellationEpoch, f.repository.getCancellationEpoch('target'));
    return { outcome: 'no_report' };
  });
  await f.service.send(f.caller, { chatId: 'target', message: 'Keep the parent working', clientRequestId: 'parent-turn' });
  await started.promise;
  const queued = await f.service.send(f.caller, { chatId: 'target', message: 'Keep this next turn', mode: 'queue', clientRequestId: 'next-parent-turn' });
  const formerCaller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'target', executionId: firstInput.execution.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  const receipt = await f.service.stop(f.caller, { chatId: 'target', scope: 'agents', clientRequestId: 'agents-only' });
  assert.equal(receipt.state, 'settled'); assert.equal(calls.length, 1);
  assert.equal(calls[0].record.effectiveCommand.scope, 'agents');
  assert.equal(firstInput.signal.aborted, false);
  assert.equal(f.repository.getExecution(firstInput.execution.executionId).status, 'running');
  assert.equal(f.repository.getCommand(queued.commandId).held, false);
  await assert.rejects(f.service.send(formerCaller, { chatId: 'sender', message: 'Late old delegation', clientRequestId: 'late-peer' }), hasCode('caller_not_active'));
  finish.resolve(); await f.service.idle('target');
  assert.equal(f.repository.getCommand(queued.commandId).state, 'settled');
  assert.deepEqual(f.repository.readTranscript('target').messages.map(row => row.content), ['Keep the parent working', 'Keep this next turn']);
});

test('command queue limits reject new work while Stop remains available and events never contain input bodies', async t => {
  const f = await fixture(t, { maxPendingCommands: 1 });
  await f.service.send(f.caller, { chatId: 'target', message: 'Private queued text' }); await f.service.idle('target');
  await assert.rejects(f.service.send(f.caller, { chatId: 'target', message: 'Overflow' }), hasCode('queue_full'));
  await f.service.stop(f.caller, { chatId: 'target' });
  assert.equal(JSON.stringify(f.events).includes('Private queued text'), false);
  assert.ok(f.events.every((event) => event.chatId === 'target'));
  assert.equal((await f.service.status(f.caller, 'target')).pending[0].held, true);
});

test('corrections accepted after the final runner boundary become ordered next turns instead of disappearing', async t => {
  const f = await fixture(t), started = deferred(), finish = deferred(); let turns = 0;
  f.host(async input => {
    f.appendInitial(input);
    if (++turns === 1) { started.resolve(); await finish.promise; }
    return { outcome: 'no_report' };
  });
  await f.service.send(f.caller, { chatId: 'target', message: 'Initial', clientRequestId: 'initial' });
  await started.promise;
  const correction = await f.service.send(f.caller, { chatId: 'target', message: 'Late correction', mode: 'steer', clientRequestId: 'late' });
  const following = await f.service.send(f.caller, { chatId: 'target', message: 'Following input', mode: 'queue', clientRequestId: 'following' });
  finish.resolve(); await f.service.idle('target');
  assert.equal(turns, 3);
  assert.deepEqual(f.repository.readTranscript('target').messages.map(row => row.content), ['Initial', 'Late correction', 'Following input']);
  assert.equal(f.repository.getCommand(correction.commandId).command.kind, 'steer');
  assert.equal(f.repository.getCommand(correction.commandId).state, 'settled');
  assert.equal(f.repository.getCommand(following.commandId).state, 'settled');
});

test('a captured legacy Stop retries only its original owner and never aborts a replacement', async t => {
  let owner = { ownerId: 'legacy-original', executionId: 'legacy-execution' }, failures = 1, calls = 0;
  const f = await fixture(t, {
    getExternalOwner: () => owner,
    async stopExternalOwner(input) {
      calls += 1;
      assert.equal(input.owner.ownerId, 'legacy-original');
      if (failures-- > 0) throw new Error('Legacy relay unavailable');
      return { stopRequested: input.owner.ownerId === owner?.ownerId };
    },
  });
  const stopped = await f.service.stop(f.caller, { chatId: 'target', clientRequestId: 'legacy-stop' });
  assert.equal(stopped.state, 'queued');
  owner = { ownerId: 'legacy-replacement', executionId: 'later-execution' };
  const repeated = await f.service.stop(f.caller, { chatId: 'target', clientRequestId: 'legacy-stop' });
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.state, 'settled');
  assert.equal(repeated.result.stopRequested, false);
  assert.equal(calls, 2);
  assert.equal(owner.ownerId, 'legacy-replacement');
});

test('legacy Stop requires a bound adapter and confirmed signaling before reporting settlement', async t => {
  const missing = await fixture(t, { hasExternalOwner: () => true });
  await assert.rejects(missing.service.stop(missing.caller, { chatId: 'target' }), hasCode('capability_unavailable'));
  let signaled = false;
  const confirmed = await fixture(t, {
    getExternalOwner: () => ({ ownerId: 'legacy-owner' }),
    stopExternalOwner: () => { signaled = true; return { stopRequested: true }; },
  });
  const receipt = await confirmed.service.stop(confirmed.caller, { chatId: 'target' });
  assert.equal(signaled, true);
  assert.equal(receipt.state, 'settled');
  assert.equal(receipt.result.stopRequested, true);
});

test('Stop cancels admission still resolving a model and leaves no late runnable command', async t => {
  const resolving = deferred(), finish = deferred();
  const f = await fixture(t, { resolveModelSelection: async ({ selection }) => { resolving.resolve(); await finish.promise; return selection; } });
  const send = f.service.send(f.caller, { chatId: 'target', message: 'Do not start after Stop' });
  await resolving.promise;
  await f.service.stop(f.caller, { chatId: 'target', clientRequestId: 'preflight-stop' });
  finish.resolve();
  await assert.rejects(send, hasCode('ownership_conflict'));
  await f.service.idle('target');
  assert.equal(f.repository.listCommands({ chatId: 'target' }).filter(row => row.command.kind === 'send').length, 0);
});

test('held inputs resume only after explicit Push now and keep their original provenance', async t => {
  const f = await fixture(t);
  const queued = await f.service.send(f.caller, { chatId: 'target', message: 'Preserve this' });
  await f.service.idle('target');
  await f.service.stop(f.caller, { chatId: 'target' });
  let turns = 0;
  f.host(async input => { turns += 1; f.appendInitial(input); return { outcome: 'no_report' }; });
  await f.service.idle('target');
  assert.equal(turns, 0);
  await f.service.pushQueued(f.caller, { chatId: 'target', targetCommandId: queued.commandId,
    expectedRevision: f.repository.getCommand(queued.commandId).revision, clientRequestId: 'resume' });
  await f.service.idle('target');
  assert.equal(turns, 1);
  assert.equal(f.repository.getCommand(queued.commandId).state, 'settled');
  assert.equal(f.repository.readTranscript('target').messages[0].provenance.commandId, queued.commandId);
});

test('terminal command output stays pinned to its execution after a later long conversation turn', async t => {
  const f = await fixture(t); let turns = 0;
  const unregister = f.host(async input => {
    f.appendInitial(input); turns += 1;
    const store = createChatTranscriptStore({ chatId: 'target', fence: input.fence, repository: f.repository });
    if (turns === 1) store.append('target', { role: 'assistant', content: 'Original execution answer' });
    else {
      for (let index = 0; index < 25; index += 1) store.append('target', { role: 'tool', content: 'Later tool row ' + index, tool_call_id: 'call-' + index });
      store.append('target', { role: 'assistant', content: 'Later execution answer' });
      store.append('target', { role: 'assistant', content: 'Tool-only prose is not a final answer', tool_calls: [{ id: 'last-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    }
    return { outcome: 'no_report' };
  });
  const first = await f.service.send(f.caller, { chatId: 'target', message: 'First turn', clientRequestId: 'first-answer' });
  await f.service.idle('target');
  const later = await f.service.send(f.caller, { chatId: 'target', message: 'Later turn', clientRequestId: 'later-answer' });
  await f.service.idle('target');
  assert.equal((await f.service.readCommand(f.caller, first.commandId)).assistantFinal, 'Original execution answer');
  assert.equal((await f.service.readCommand(f.caller, later.commandId)).assistantFinal, 'Later execution answer');
  assert.equal(f.repository.readExecutionFinalAssistant(first.executionId ?? f.repository.getCommand(first.commandId).executionId), 'Original execution answer');
  unregister();
  const pending = await f.service.send(f.caller, { chatId: 'sender', message: 'Not executed yet', clientRequestId: 'pending-answer' });
  assert.equal((await f.service.readCommand(f.caller, pending.commandId)).assistantFinal, undefined);
});

test('legacy callers require an exact runtime-approved identity and expire without marking their unflushed source managed', async t => {
  const permitted = new WeakSet(); let live = true;
  const f = await fixture(t, { isExternalExecutionActive: caller => live && permitted.has(caller) });
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('sender');
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'sender', executionId: 'legacy-execution',
    executionActive: true, scope: f.scope, policy: f.policy });
  permitted.add(caller);
  const sent = await f.service.send(caller, { chatId: 'target', message: 'Legacy peer input', clientRequestId: 'legacy-peer' });
  assert.equal(f.repository.getChat('sender').chatCommandVersion, undefined);
  assert.equal(f.repository.getExecution('legacy-execution'), null);
  assert.equal(f.repository.getCommand(sent.commandId).command.provenance.causalRootId, caller.executionId);
  await assert.rejects(f.service.send({ ...caller }, { chatId: 'target', message: 'Forged copy' }), hasCode('caller_denied'));
  const unrelated = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'sender', executionId: 'legacy-execution',
    executionActive: true, scope: f.scope, policy: f.policy });
  await assert.rejects(f.service.send(unrelated, { chatId: 'target', message: 'Unregistered identity' }), hasCode('caller_not_active'));
  live = false;
  await assert.rejects(f.service.send(caller, { chatId: 'target', message: 'After release' }), hasCode('caller_not_active'));
});

test('disabling new creation preserves protected human continuations while blocking unmanaged migration and new agent sends', async t => {
  const f = await fixture(t, { feature: () => ({ version: 1, capability: 'agentConversationsV1', creationEnabled: false, recoveryEnabled: true }) });
  const continued = await f.service.send(f.caller, { chatId: 'target', message: 'Continue saved work', clientRequestId: 'saved-continuation' });
  assert.ok(continued.commandId);
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('foreign');
  await assert.rejects(f.service.send(f.caller, { chatId: 'foreign', message: 'Do not migrate an unmanaged chat' }), hasCode('capability_disabled'));
  const fence = f.repository.claimExecution({ chatId: 'sender', executionId: 'disabled-peer-source', ownerId: 'sender-host' });
  const agent = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'sender', executionId: fence.executionId,
    executionActive: true, scope: f.scope, policy: f.policy });
  await assert.rejects(f.service.send(agent, { chatId: 'target', message: 'New peer mutation' }), hasCode('capability_disabled'));
  f.repository.updateExecution(fence.executionId, { status: 'completed' }, { fence }); f.repository.releaseLease('sender', fence);
});

test('a pinned legacy Stop cannot affect a replacement legacy owner or a newer server execution', async t => {
  let external = { ownerId: 'new-renderer' }, signals = 0;
  const f = await fixture(t, { getExternalOwner: () => external, stopExternalOwner: () => { signals++; return { stopRequested: true }; } });
  const epoch = f.repository.getCancellationEpoch('target');
  const stale = await f.service.stop(f.caller, { chatId: 'target', expectedLegacyOwnerId: 'old-renderer', clientRequestId: 'stale-raw-stop' });
  assert.equal(stale.result.stopRequested, false); assert.equal(signals, 0);
  assert.equal(f.repository.getCancellationEpoch('target'), epoch);
  external = null;
  const started = deferred(), finish = deferred(); let active;
  f.host(async input => { active = input; started.resolve(); await finish.promise; return { outcome: 'no_report' }; });
  await f.service.send(f.caller, { chatId: 'target', message: 'New server work', clientRequestId: 'new-server' }); await started.promise;
  const server = await f.service.stop(f.caller, { chatId: 'target', expectedLegacyOwnerId: 'old-renderer', clientRequestId: 'stale-server-stop' });
  assert.equal(server.result.stopRequested, false); assert.equal(active.signal.aborted, false);
  assert.equal(f.repository.getCancellationEpoch('target'), epoch);
  finish.resolve(); await f.service.idle('target');
});

test('queued input cannot follow a replacement Git project occupying the same checkout path', async t => {
  const f = await fixture(t);
  const admitted = await f.service.send(f.caller, { chatId: 'target', message: 'Original project only', clientRequestId: 'checkout-binding' });
  await f.service.idle('target');
  const original = f.context.resolveTarget;
  const replacedRegistry = createChatProjectRegistry([{ projectId: 'replacement-project', workspaceId: 'main', canonicalKey: 'C:/fixture' }]);
  const replacedScope = resolveProjectScope(replacedRegistry, { projectId: 'replacement-project', workspaceKey: 'C:/fixture' });
  f.context.resolveTarget = async chatId => ({ ...await original(chatId), scope: replacedScope, registry: replacedRegistry,
    project: { projectId: 'replacement-project', scope: replacedScope, registry: replacedRegistry } });
  let calls = 0;
  f.host(async input => { calls++; f.appendInitial(input); return { outcome: 'no_report' }; });
  await f.service.idle('target');
  const blocked = f.repository.getCommand(admitted.commandId);
  assert.equal(calls, 0); assert.equal(blocked.held, true); assert.equal(blocked.error.code, 'workspace_denied');
  assert.equal(f.repository.getLease('target'), null);
  f.context.resolveTarget = original;
  await f.service.pushQueued(f.caller, { chatId: 'target', targetCommandId: admitted.commandId,
    expectedRevision: blocked.revision, clientRequestId: 'resume-restored-checkout' });
  await f.service.idle('target');
  assert.equal(calls, 1); assert.equal(f.repository.getCommand(admitted.commandId).state, 'settled');
});
