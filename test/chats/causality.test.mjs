import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatCausality } from '../../server/chats/causality.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { getAgentConversationsFeature } from '../../server/chats/feature.js';

const hasCode = code => error => error?.code === code;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, options = {}) {
  const folder = options.disk ? mkdtempSync(join(tmpdir(), 'minnow-causality-')) : null;
  const filename = folder ? join(folder, 'sessions.db') : ':memory:';
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'main', canonicalKey: 'C:/causal-fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/causal-fixture' });
  const policy = createChatPolicy({ modeId: 'build', toolPermissions: { read_file: 'full' }, toolEffects: { read_file: 'read' },
    workspaceIds: ['main'], capabilities: ['chat.read', 'chat.send', 'chat.stop', 'agent.spawn', 'request.respond', 'execution.host'] });
  const human = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  let db, repository, causality, service, serial = 0;
  function open() {
    db = new Database(filename); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    repository = createChatRepository({ db, now: () => 1000 });
    for (const chatId of ['a', 'b', 'c', 'd']) {
      if (!db.prepare('SELECT 1 FROM chats WHERE id=?').get(chatId)) repository.createChat({ id: chatId, name: chatId,
        workspacePath: 'C:/causal-fixture', providerId: 'provider', modelId: 'model', modeId: 'build' });
    }
    const context = { async resolveTarget(chatId) {
      const chat = repository.getChat(chatId);
      return { chat, scope, policy, currentPolicy: policy, profile: repository.getLatestProfile(chatId), registry,
        project: { registry, projectId: scope.projectId, scope } };
    } };
    causality = createChatCausality({ repository, ...options.limits, isCallerActive: options.isCallerActive });
    service = createChatCommandService({ repository, context, admitCausality: input => causality.admit(input),
      feature: () => getAgentConversationsFeature({ NODE_ENV: 'test', MINNOW_AGENT_CONVERSATIONS: '1' }),
      resolveModelSelection: ({ selection }) => selection, now: () => 1000, id: () => 'allocated-' + (++serial), onError: () => {},
      isExternalExecutionActive: options.isExternalExecutionActive });
  }
  async function close() { await service?.dispose(); causality?.dispose(); if (db?.open) db.close(); }
  open();
  t.after(async () => { await close(); if (folder) rmSync(folder, { recursive: true, force: true }); });
  function agent(chatId, captured = {}, executionId = 'source-' + chatId) {
    const fence = repository.claimExecution({ chatId, executionId, ownerId: 'owner-' + executionId,
      captured: { causalRootId: 'human-request', causalDepth: 0, cancellationEpoch: repository.getCancellationEpoch(chatId), ...captured } });
    const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId, executionId, executionActive: true, scope, policy });
    return { caller, fence, execution: repository.getExecution(executionId) };
  }
  function caller(execution) { return createChatCaller({ actor: 'agent', ingress: 'tool', chatId: execution.chatId,
    executionId: execution.executionId, executionActive: true, scope, policy }); }
  return { human, scope, policy, agent, caller, close, reopen: async () => { await close(); open(); },
    get db() { return db; }, get repository() { return repository; }, get service() { return service; }, get causality() { return causality; } };
}

test('peer budgets survive new client keys, settled commands, retries, and actual database reopen', async t => {
  const f = await fixture(t, { disk: true, limits: { maxPeerCommands: 2, maxPendingPeerInputs: 10 } });
  const source = f.agent('a');
  const request = { chatId: 'b', message: 'First peer instruction', clientRequestId: 'first' };
  const first = await f.service.send(source.caller, request);
  await f.service.idle('b');
  f.repository.updateCommand(first.commandId, { state: 'settled', result: { outcome: 'no_report' } });
  const second = await f.service.send(source.caller, { ...request, message: 'Second instruction', clientRequestId: 'second' });
  await f.service.idle('b');
  assert.equal(f.repository.getCommand(second.commandId).captured.agentCoordination, true);
  await assert.rejects(f.service.send(source.caller, { ...request, clientRequestId: 'fresh-key' }), hasCode('causal_limit'));
  const replay = await f.service.send(source.caller, request);
  assert.equal(replay.commandId, first.commandId); assert.equal(replay.replayed, true);
  await assert.rejects(f.service.send(source.caller, { ...request, message: 'Changed' }), hasCode('idempotency_conflict'));
  await f.reopen();
  assert.equal((await f.service.send(source.caller, request)).commandId, first.commandId);
  await assert.rejects(f.service.send(source.caller, { ...request, clientRequestId: 'after-reopen' }), hasCode('causal_limit'));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_commands WHERE json_extract(captured_json,'$.agentCoordination')=1").get().n, 2);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_chat_commands_causal_peer'").get()['1'], 1);
});

test('failed canonical admission rolls back the shared durable budget transaction', async t => {
  const f = await fixture(t, { limits: { maxPeerCommands: 1 } }); const source = f.agent('a');
  const original = f.repository.updateCommand;
  f.repository.updateCommand = () => { throw new Error('Injected post-insert failure'); };
  await assert.rejects(f.service.send(source.caller, { chatId: 'b', message: 'Will roll back', clientRequestId: 'failed' }), /Injected post-insert/);
  f.repository.updateCommand = original;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_commands').get().n, 0);
  const accepted = await f.service.send(source.caller, { chatId: 'b', message: 'Accepted once', clientRequestId: 'accepted' });
  assert.equal(f.repository.getCommand(accepted.commandId).captured.causalRootId, 'human-request');
  await assert.rejects(f.service.send(source.caller, { chatId: 'c', message: 'Too much', clientRequestId: 'over' }), hasCode('causal_limit'));
});

test('concurrent admissions to different targets share one canonical root budget', async t => {
  const f = await fixture(t, { limits: { maxPeerCommands: 1 } }); const a = f.agent('a');
  const outcomes = await Promise.allSettled(['b', 'c', 'd'].map(chatId => f.service.send(a.caller,
    { chatId, message: 'Concurrent peer input', clientRequestId: 'concurrent-' + chatId })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected' && outcome.reason.code === 'causal_limit').length, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM chat_commands WHERE json_extract(captured_json,'$.agentCoordination')=1").get().n, 1);
});

test('forwarded peer messages preserve the human root and reject hop overflow', async t => {
  const f = await fixture(t, { limits: { maxHops: 2 } }); const a = f.agent('a');
  const first = await f.service.send(a.caller, { chatId: 'b', message: 'Forward once', clientRequestId: 'a-b' });
  await f.service.idle('b');
  const firstRecord = f.repository.getCommand(first.commandId);
  assert.equal(firstRecord.captured.causalDepth, 1);
  const b = f.agent('b', firstRecord.captured);
  const second = await f.service.send(b.caller, { chatId: 'c', message: 'Forward twice', clientRequestId: 'b-c' });
  await f.service.idle('c');
  const secondRecord = f.repository.getCommand(second.commandId);
  assert.equal(secondRecord.captured.causalRootId, 'human-request'); assert.equal(secondRecord.captured.causalDepth, 2);
  assert.equal(secondRecord.command.provenance.causalRootId, 'human-request');
  const c = f.agent('c', secondRecord.captured);
  await assert.rejects(f.service.send(c.caller, { chatId: 'd', message: 'Third hop', clientRequestId: 'c-d' }), hasCode('causal_limit'));
});

test('queued peer inputs are bounded independently of human Stop and a new human root', async t => {
  const f = await fixture(t, { limits: { maxPendingPeerInputs: 2, maxPeerCommands: 2 } }); const a = f.agent('a');
  await f.service.send(a.caller, { chatId: 'b', message: 'One', clientRequestId: 'one' });
  await f.service.send(a.caller, { chatId: 'b', message: 'Two', clientRequestId: 'two' });
  await f.service.idle('b');
  const otherRoot = f.agent('c', { causalRootId: 'another-human-request' });
  await assert.rejects(f.service.send(otherRoot.caller, { chatId: 'b', message: 'Overflow inbox', clientRequestId: 'inbox-over' }), hasCode('causal_limit'));
  const stop = await f.service.stop(f.human, { chatId: 'b', scope: 'turn', clientRequestId: 'human-stop' });
  assert.ok(stop.commandId);
  const fresh = await f.service.send(f.human, { chatId: 'b', message: 'New human instruction', clientRequestId: 'new-human' });
  const record = f.repository.getCommand(fresh.commandId);
  assert.equal(record.captured.causalRootId, fresh.commandId); assert.equal(record.captured.causalDepth, 0);
  assert.equal(record.captured.agentCoordination, undefined);
  await f.service.send(otherRoot.caller, { chatId: 'd', message: 'Different inbox and budget', clientRequestId: 'other-root' });
});

test('only consumed steering changes active causality; peer steering inherits and human steering starts a fresh root', async t => {
  const f = await fixture(t); const a = f.agent('a'); const started = deferred(), finish = deferred(); let running;
  f.service.registerHost({ id: 'server', kind: 'server', supportsSteer: true, canRun: ({ command }) => command.chatId === 'b', execute: async input => {
    input.signal.addEventListener('abort', () => finish.resolve(), { once: true });
    running = input; started.resolve(); await finish.promise; return { outcome: 'no_report' };
  } });
  t.after(() => finish.resolve());
  const initial = await f.service.send(f.human, { chatId: 'b', message: 'Original human root', clientRequestId: 'initial' });
  await started.promise;
  const b = f.caller(running.execution);
  assert.deepEqual(f.causality.source(b), { causalRootId: initial.commandId, causalDepth: 0 });
  const human = await f.service.send(f.human, { chatId: 'b', message: 'Earlier queued human instruction', mode: 'queue', clientRequestId: 'queued-human' });
  const peer = await f.service.send(a.caller, { chatId: 'b', message: 'Peer steer', mode: 'steer', clientRequestId: 'peer-steer' });
  assert.equal(f.causality.source(b).causalRootId, initial.commandId);
  const consumed = running.takeSteers(); assert.equal(consumed.messages.length, 1);
  assert.deepEqual(f.causality.source(b), { causalRootId: 'human-request', causalDepth: 1 });
  const forwarded = await f.service.send(b, { chatId: 'c', message: 'Forward consumed peer instruction', clientRequestId: 'forward-peer' });
  assert.equal(f.repository.getCommand(forwarded.commandId).captured.causalDepth, 2);
  assert.equal(f.repository.getCommand(peer.commandId).result.disposition, 'steered');
  await f.service.pushQueued(f.human, { chatId: 'b', targetCommandId: human.commandId,
    expectedRevision: f.repository.getCommand(human.commandId).revision, clientRequestId: 'push-earlier-human' });
  assert.equal(f.causality.source(b).causalRootId, 'human-request');
  running.takeSteers();
  assert.deepEqual(f.causality.source(b), { causalRootId: human.commandId, causalDepth: 0 });
  const newPeer = await f.service.send(b, { chatId: 'd', message: 'Forward fresh human instruction', clientRequestId: 'forward-human' });
  assert.equal(f.repository.getCommand(newPeer.commandId).captured.causalRootId, human.commandId);
  finish.resolve(); await f.service.idle();
});

test('explicit delegation inherits lineage without consuming the peer message budget', async t => {
  const f = await fixture(t, { limits: { maxPeerCommands: 1 } }); const a = f.agent('a');
  for (let index = 0; index < 200; index++) assert.deepEqual(f.causality.inherit(a.caller), { causalRootId: 'human-request', causalDepth: 1 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_commands').get().n, 0);
  await f.service.send(a.caller, { chatId: 'b', message: 'Still one allowed peer command', clientRequestId: 'one' });
  await assert.rejects(f.service.send(a.caller, { chatId: 'c', message: 'Budget exhausted', clientRequestId: 'two' }), hasCode('causal_limit'));
  assert.deepEqual(f.causality.inherit(a.caller), { causalRootId: 'human-request', causalDepth: 1 });
});

test('wait graph rejects self and multi-execution cycles, with reference-counted release and abort cleanup', async t => {
  const f = await fixture(t); const a = f.agent('a'), b = f.agent('b'), c = f.agent('c');
  const wait = (source, target, signal) => f.causality.beforeWait({ caller: source.caller, chatId: target.execution.chatId,
    executionId: target.execution.executionId, signal });
  assert.throws(() => wait(a, a), hasCode('wait_cycle'));
  const releaseAB = wait(a, b), releaseAB2 = wait(a, b), releaseBC = wait(b, c);
  assert.throws(() => wait(c, a), hasCode('wait_cycle'));
  releaseAB(); releaseAB();
  assert.throws(() => wait(c, a), hasCode('wait_cycle'));
  releaseAB2(); const releaseCA = wait(c, a); releaseCA(); releaseBC();
  const controller = new AbortController(); wait(a, b, controller.signal); controller.abort();
  const reverse = wait(b, a); reverse();
  const aborted = new AbortController(); aborted.abort(); assert.throws(() => wait(a, b, aborted.signal), { name: 'AbortError' });
  wait(a, b); f.causality.dispose(); const afterDispose = wait(b, a); afterDispose();
});

test('wait edges pin execution identities and stale stopped owners do not block new live waits', async t => {
  const f = await fixture(t); const a = f.agent('a'), b = f.agent('b');
  assert.throws(() => f.causality.beforeWait({ caller: a.caller, chatId: 'c', executionId: b.execution.executionId }), hasCode('request_not_found'));
  f.causality.beforeWait({ caller: a.caller, chatId: 'b', executionId: b.execution.executionId });
  f.repository.updateExecution(a.execution.executionId, { status: 'stopped' }, { fence: a.fence });
  f.repository.releaseLease('a', a.fence);
  const replacement = f.agent('a', { causalRootId: 'replacement-root' }, 'replacement-a');
  const release = f.causality.beforeWait({ caller: b.caller, chatId: 'a', executionId: replacement.execution.executionId });
  release();
  assert.throws(() => f.causality.source(a.caller), hasCode('caller_not_active'));
  assert.equal(f.causality.source(replacement.caller).causalRootId, 'replacement-root');
});

test('causality rejects forged callers, model-provided lineage, stale epochs, and invalid configuration', async t => {
  const f = await fixture(t); const a = f.agent('a');
  assert.throws(() => f.causality.source({ ...a.caller }), hasCode('caller_denied'));
  await assert.rejects(f.service.send(a.caller, { chatId: 'b', message: 'Forged root', clientRequestId: 'forged', causalRootId: 'free-budget' }), hasCode('invalid_request'));
  f.repository.advanceCancellationEpoch('a');
  assert.throws(() => f.causality.source(a.caller), hasCode('caller_not_active'));
  assert.throws(() => createChatCausality({ repository: f.repository, maxHops: 0 }), TypeError);
  assert.throws(() => createChatCausality({ repository: f.repository, maxPeerCommands: Infinity }), TypeError);
  assert.throws(() => f.causality.admit({ caller: f.human, command: {} }), /share.*transaction/);
});

test('raw legacy roots require exact private active-owner proof and cannot reset their budget with client keys', async t => {
  const live = new WeakSet();
  const f = await fixture(t, { limits: { maxPeerCommands: 1 }, isCallerActive: caller => live.has(caller),
    isExternalExecutionActive: caller => live.has(caller) });
  const raw = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'a', executionId: 'raw-turn', executionActive: true, scope: f.scope, policy: f.policy });
  assert.throws(() => f.causality.source(raw), hasCode('caller_not_active'));
  live.add(raw);
  assert.deepEqual(f.causality.source(raw), { causalRootId: 'raw-turn', causalDepth: 0 });
  const request = { chatId: 'b', message: 'Raw root peer input', clientRequestId: 'raw-first' };
  const first = await f.service.send(raw, request);
  assert.equal(f.repository.getCommand(first.commandId).captured.causalRootId, 'raw-turn');
  await assert.rejects(f.service.send(raw, { ...request, clientRequestId: 'raw-reset-attempt' }), hasCode('causal_limit'));
  assert.equal((await f.service.send(raw, request)).commandId, first.commandId);
  const another = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'a', executionId: 'raw-turn', executionActive: true, scope: f.scope, policy: f.policy });
  assert.throws(() => f.causality.source(another), hasCode('caller_not_active'));
  live.delete(raw); assert.throws(() => f.causality.inherit(raw), hasCode('caller_not_active'));
});
