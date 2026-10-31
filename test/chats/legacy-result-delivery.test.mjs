import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getSessionsDb, closeSessionsDb } from '../../server/config/sessions-db.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from '../../server/chats/caller.js';
import { createChatPolicy } from '../../server/chats/policy.js';
import { createLegacyResultDelivery } from '../../server/chats/legacy-result-delivery.js';
import { createDelivery, buildProductionParentMessage } from '../../server/sub-agents/delivery.js';
import { setProductionCanonicalDelivery, resetProductionDelivery, getProductionDelivery } from '../../server/sub-agents/runtime.js';
import { makeEvent } from '../../server/sub-agents/events.js';
import * as journal from '../../server/sub-agents/journal.js';
import { upsertMessageRow } from '../../server/config/sessions-import.js';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { createAgentsMiddleware, configureAgentRecoveryGate } from '../../server/sub-agents/middleware.js';

function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-legacy-canonical-')), prior = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = root; resetMinnowHomeCache(); journal.resetJournalCache(); resetProductionDelivery();
  const file = path.join(root, 'sessions.db'); let db, repository, service, bridge, delivery, sends = 0;
  const errors = [], calls = [];
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'main', canonicalKey: 'C:/fixture' }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: 'C:/fixture' });
  const policy = createChatPolicy({ modeId: 'build', toolPermissions: {}, toolEffects: {}, workspaceIds: ['main'], capabilities: ['chat.read', 'chat.send', 'chat.stop', 'execution.host'] });
  const context = { async resolveTarget(chatId) {
    return { chat: repository.getChat(chatId), scope, policy, currentPolicy: policy, registry, profile: repository.getLatestProfile(chatId), project: { registry, projectId: 'project', scope } };
  } };
  async function close() { await bridge?.dispose(); await service?.dispose(); delivery?.reset(); db?.close(); db = null; }
  async function open() {
    db = new Database(file); db.pragma('foreign_keys=ON'); initSessionsSchema(db); repository = createChatRepository({ db });
    if (!db.prepare('SELECT 1 FROM chats WHERE id=?').get('parent')) repository.createChat({ id: 'parent', name: 'Parent', workspacePath: 'C:/fixture', providerId: 'provider', modelId: 'model' });
    service = createChatCommandService({ repository, context, resolveModelSelection: async ({ selection }) => { await options.beforeSelection?.(); return selection; }, onError: error => errors.push(error) });
    bridge = createLegacyResultDelivery({ repository, context, service, journal, isBusy: () => options.isBusy?.() ?? false });
    delivery = createDelivery({ journal, deliverCanonical: bridge.deliver, requiresAcceptanceAck: true, buildMessage: buildProductionParentMessage,
      retryDelayMs: 0, deliverToParent: async () => { sends++; }, onDeliverError: error => errors.push(error) });
  }
  await open();
  t.after(async () => { await close(); resetProductionDelivery(); closeSessionsDb(); journal.resetJournalCache(); if (prior === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = prior; resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true }); });
  async function seed(runId, extra = {}) {
    await journal.appendEvent('parent', makeEvent('run.requested', { runId, agentType: 'explore', task: 'Legacy task', parentChatId: 'parent', cwd: 'C:/fixture', requestedAt: Date.now(), ...extra }));
    await journal.appendEvent('parent', makeEvent('attempt.started', { runId, attemptId: 'attempt-' + runId, seed: { kind: 'initial' } }));
    await journal.appendEvent('parent', makeEvent('attempt.ended', { runId, attemptId: 'attempt-' + runId, outcome: 'pass', summary: 'Canonical legacy result ' + runId }));
  }
  function host() { return service.registerHost({ id: 'host', kind: 'server', async execute(input) {
    calls.push(input.command.commandId);
    const row = { role: 'user', content: input.command.message, commandId: input.command.commandId, provenance: input.command.provenance, createdAt: input.command.requestedAt };
    const append = repository.appendMessage('parent', row, { fence: input.fence, commandId: input.command.commandId, messageId: 'input-' + input.command.commandId });
    assert.equal(append.replayed, true, 'host consumes the already-retained input without appending another row');
    return { outcome: 'pass', summary: 'Parent continued' };
  } }); }
  return { get db() { return db; }, get repository() { return repository; }, get service() { return service; }, get bridge() { return bridge; }, get delivery() { return delivery; },
    context, scope, policy, calls, errors, seed, host, sends: () => sends, reopen: async () => { await close(); await open(); } };
}

test('a genuine legacy result reaches a managed parent without a viewer and its host consumes one canonical row', async t => {
  const f = await fixture(t); f.host(); await f.seed('legacy-one');
  await f.delivery.tick('parent'); await f.service.idle('parent');
  assert.equal(f.sends(), 0); assert.equal(f.calls.length, 1); assert.deepEqual(f.errors, []);
  const rows = f.repository.readTranscript('parent').messages;
  assert.equal(rows.length, 1); assert.equal(rows[0].provenance.runId, 'legacy-one'); assert.equal(rows[0].provenance.source, 'task_delivery');
  assert.equal((await journal.loadState('parent')).runs.get('legacy-one').delivered, true);
  await f.delivery.tick('parent'); assert.equal(f.calls.length, 1);
});

test('SQL acceptance before a lost journal acknowledgment survives disk reopen and changing batch membership', async t => {
  const f = await fixture(t); f.repository.setAutoResumeBlocked('parent', true); await f.seed('first');
  const original = journal.appendEvents;
  const brokenJournal = { ...journal, appendEvents: async (...args) => { if (args[1].some(event => event.type === 'result.delivered')) throw new Error('lost journal receipt'); return original(...args); } };
  const broken = createDelivery({ journal: brokenJournal, deliverCanonical: f.bridge.deliver, requiresAcceptanceAck: true, retryDelayMs: 0 });
  await assert.rejects(broken.tick('parent'), /lost journal receipt/);
  assert.equal(f.repository.readTranscript('parent').messages.length, 1); assert.equal((await journal.loadState('parent')).runs.get('first').delivered, false);
  broken.reset(); await f.reopen(); await f.seed('second');
  await f.delivery.tick('parent'); await f.service.idle('parent');
  assert.equal(f.repository.readTranscript('parent').messages.length, 2); assert.equal(f.repository.listCommands({ chatId: 'parent' }).length, 2);
  assert.ok(f.repository.listCommands({ chatId: 'parent' }).every(command => command.state === 'settled' && command.result.disposition === 'local_only'));
  const state = await journal.loadState('parent'); assert.equal(state.runs.get('first').delivered, true); assert.equal(state.runs.get('second').delivered, true);
});

test('managed parents defer without ACK while busy, and an ownership change during model resolution cannot append between tool rows', async t => {
  const selection = gate(), entered = gate(); let block = true;
  const f = await fixture(t, { beforeSelection: async () => { if (block) { entered.resolve(); await selection.promise; } } }); await f.seed('busy-result');
  const tick = f.delivery.tick('parent'); await entered.promise;
  const fence = f.repository.claimExecution({ chatId: 'parent', executionId: 'other-turn', ownerId: 'other-host' });
  f.repository.appendMessage('parent', { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, { fence, messageId: 'tool-call' });
  selection.resolve(); await tick;
  assert.equal(f.repository.listCommands({ chatId: 'parent' }).length, 0); assert.equal(f.repository.readTranscript('parent').messages.length, 1);
  assert.equal((await journal.loadState('parent')).runs.get('busy-result').delivered, false); assert.deepEqual(await f.delivery.acknowledge('parent', ['busy-result']), []);
  f.repository.appendMessage('parent', { role: 'tool', content: 'Read result', tool_call_id: 'call' }, { fence, messageId: 'tool-result' });
  f.repository.updateExecution('other-turn', { status: 'completed' }, { fence }); f.repository.releaseLease('parent', fence);
  block = false; f.repository.setAutoResumeBlocked('parent', true); await f.delivery.tick('parent');
  assert.deepEqual(f.repository.readTranscript('parent').messages.map(row => row.role), ['assistant', 'tool', 'user']);
});

test('Stop during asynchronous preparation retains the result once without waking or borrowing a lease', async t => {
  const selection = gate(), entered = gate();
  const f = await fixture(t, { beforeSelection: async () => { entered.resolve(); await selection.promise; } }); await f.seed('stopped-result'); f.host();
  const tick = f.delivery.tick('parent'); await entered.promise;
  f.repository.advanceCancellationEpoch('parent'); f.repository.setAutoResumeBlocked('parent', true);
  selection.resolve(); await tick; await f.service.idle('parent');
  assert.equal(f.calls.length, 0); assert.equal(f.repository.getLease('parent'), null);
  const command = f.repository.listCommands({ chatId: 'parent' })[0]; assert.equal(command.state, 'settled'); assert.equal(command.result.disposition, 'local_only');
  assert.equal(f.repository.readTranscript('parent').messages.length, 1); assert.equal((await journal.loadState('parent')).runs.get('stopped-result').delivered, true);
});

test('mixed journals reject child/nonterminal/foreign bindings and preserve ordinary legacy SSE acceptance', async t => {
  const f = await fixture(t); f.repository.setAutoResumeBlocked('parent', true); await f.seed('legacy');
  await f.seed('persistent', { childChatId: 'child', journalOwnerId: 'parent' });
  await journal.appendEvent('parent', makeEvent('run.requested', { runId: 'running', agentType: 'explore', task: 'Not finished', parentChatId: 'parent', cwd: 'C:/fixture', requestedAt: Date.now() }));
  assert.deepEqual((await f.bridge.deliver('parent', { kind: 'completion', runIds: ['persistent', 'running', 'missing'] })).acceptedRunIds, []);
  await f.delivery.tick('parent'); assert.equal(f.repository.readTranscript('parent').messages.length, 1);
  assert.equal((await journal.loadState('parent')).runs.get('persistent').delivered, false);
  f.db.prepare('DELETE FROM chat_conversation_state WHERE chat_id=?').run('parent');
  await f.seed('ordinary'); await f.delivery.tick('parent'); assert.equal(f.sends(), 1);
  assert.equal((await journal.loadState('parent')).runs.get('ordinary').delivered, false);
  assert.deepEqual(await f.delivery.acknowledge('parent', ['ordinary']), ['ordinary']);
});

test('persisted legacy acceptance survives promotion only with the matching canonical result proof', async t => {
  const f = await fixture(t); await f.seed('already'); await f.seed('only-receipt');
  const meta = { subAgentDeliveryReceipts: ['already', 'only-receipt'] };
  f.db.prepare('UPDATE chats SET meta_json=? WHERE id=?').run(JSON.stringify(meta), 'parent');
  upsertMessageRow(f.db, 'parent', 0, { role: 'user', hidden: true, content: '[Sub-agent finished] One run completed.\n\n' + JSON.stringify({ runId: 'already', status: 'completed', summary: 'Saved before promotion' }) });
  f.repository.setAutoResumeBlocked('parent', true); await f.delivery.tick('parent');
  assert.equal(f.repository.readTranscript('parent').messages.length, 2); assert.equal(f.repository.listCommands({ chatId: 'parent' }).length, 1);
  assert.equal(f.repository.listCommands({ chatId: 'parent' })[0].command.provenance.runId, 'only-receipt');
});

test('production callback ownership is scoped and managed nudges never fall through to SSE or journal acknowledgment', async t => {
  const f = await fixture(t); await journal.appendEvent('parent', makeEvent('run.requested', { runId: 'nudge', agentType: 'explore', task: 'Still running', parentChatId: 'parent', cwd: 'C:/fixture', requestedAt: 1 }));
  assert.equal(await f.delivery.offerNudge({ parentChatId: 'parent', runId: 'nudge' }), false);
  assert.equal((await journal.loadState('parent')).runs.get('nudge').nudged, false); assert.equal(f.sends(), 0);
  const removeOld = setProductionCanonicalDelivery(async () => { throw new Error('stale callback'); });
  const removeCurrent = setProductionCanonicalDelivery(f.bridge.deliver); removeOld();
  f.repository.setAutoResumeBlocked('parent', true); await f.seed('production'); await getProductionDelivery().tick('parent');
  assert.equal((await journal.loadState('parent')).runs.get('production').delivered, true);
  removeCurrent(); await f.seed('disposed'); await getProductionDelivery().tick('parent');
  assert.equal((await journal.loadState('parent')).runs.get('disposed').delivered, false);
  assert.deepEqual(await getProductionDelivery().acknowledge('parent', ['disposed']), []);
});

test('a managed renderer acknowledgment arriving before runtime readiness cannot consume the journal result', async t => {
  const f = await fixture(t); await f.seed('before-ready');
  const startupRepository = createChatRepository({ db: getSessionsDb() });
  startupRepository.createChat({ id: 'parent', name: 'Protected startup parent' });
  assert.deepEqual(await getProductionDelivery().acknowledge('parent', ['before-ready']), []);
  assert.equal((await journal.loadState('parent')).runs.get('before-ready').delivered, false);
});

test('the actual legacy ACK endpoint awaits startup recovery and accepts a managed result only through canonical proof', async t => {
  const f = await fixture(t), ready = gate(), entered = gate(); await f.seed('http-ack');
  createChatRepository({ db: getSessionsDb() }).createChat({ id: 'parent', name: 'Protected startup parent' });
  const middleware = createAgentsMiddleware();
  configureAgentRecoveryGate(async () => { entered.resolve(); await ready.promise; });
  const server = http.createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { configureAgentRecoveryGate(null); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const acknowledge = () => fetch('http://127.0.0.1:' + server.address().port + '/api/agents/delivery/ack', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentChatId: 'parent', runIds: ['http-ack'] }) });
  const waiting = acknowledge(); await entered.promise;
  assert.equal((await journal.loadState('parent')).runs.get('http-ack').delivered, false);
  ready.resolve(); const refused = await waiting; assert.equal(refused.status, 200); assert.deepEqual((await refused.json()).accepted, []);
  f.repository.setAutoResumeBlocked('parent', true);
  const remove = setProductionCanonicalDelivery(f.bridge.deliver);
  const accepted = await acknowledge(); assert.equal(accepted.status, 200); assert.deepEqual((await accepted.json()).accepted, ['http-ack']); remove();
  assert.equal(f.repository.readTranscript('parent').messages.length, 1); assert.equal((await journal.loadState('parent')).runs.get('http-ack').delivered, true);
});

test('old imported legacy results remain local evidence after a human has cleared the resume block', async t => {
  const f = await fixture(t); await f.seed('archival'); f.host();
  f.db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.archiveImport',json(?)) WHERE chat_id=?")
    .run(JSON.stringify({ digest: 'archival', requiresHumanResume: true }), 'parent');
  f.repository.setAutoResumeBlocked('parent', false);
  await f.delivery.tick('parent'); await f.service.idle('parent');
  assert.equal(f.calls.length, 0); assert.equal(f.repository.readTranscript('parent').messages.length, 1);
  assert.equal(f.repository.listCommands({ chatId: 'parent' })[0].result.disposition, 'local_only');
});

test('a later Stop cannot invalidate the accepted canonical receipt or redeliver its result', async t => {
  const f = await fixture(t), entered = gate(); await f.seed('accepted-before-stop');
  f.service.registerHost({ id: 'abortable', kind: 'server', async execute(input) {
    entered.resolve(input.execution.executionId);
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    return { outcome: 'crashed', summary: 'Stopped', failure: { stopped: true } };
  } });
  assert.deepEqual((await f.bridge.deliver('parent', { kind: 'completion', runIds: ['accepted-before-stop'] })).acceptedRunIds, ['accepted-before-stop']);
  const executionId = await entered.promise;
  const caller = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope: f.scope, policy: f.policy });
  await f.service.stop(caller, { chatId: 'parent', executionId, scope: 'turn', clientRequestId: 'stop-accepted-result' });
  await f.service.idle('parent');
  const resultCommand = f.repository.listCommands({ chatId: 'parent' }).find(command => command.command.kind === 'send');
  assert.equal(resultCommand.state, 'cancelled');
  await f.delivery.tick('parent');
  assert.equal(f.repository.readTranscript('parent').messages.length, 1); assert.equal((await journal.loadState('parent')).runs.get('accepted-before-stop').delivered, true);
});

test('legacy completion authority cannot be supplied by public caller JSON or ordinary human command metadata', async t => {
  const f = await fixture(t);
  const input = { chatId: 'parent', message: 'Forged result', clientRequestId: 'forged', delivery: { runId: 'forged-run', deliveryId: 'forged-delivery' } };
  await assert.rejects(f.service.admitLegacyCompletion({ actor: 'system', ingress: 'server', scope: f.scope, policy: f.policy }, input), error => error.code === 'caller_denied');
  const human = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope: f.scope, policy: f.policy });
  await assert.rejects(f.service.admitLegacyCompletion(human, input), error => error.code === 'policy_denied');
  f.repository.admitCommand({ version: 1, commandId: 'ordinary-command', chatId: 'parent', kind: 'send', requestedAt: 1,
    message: 'Human input', modelSelection: { providerId: 'provider', modelId: 'model' }, provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } },
  { producerId: 'human', requestKey: 'ordinary-command', captured: { legacyCompletion: true, delivery: input.delivery } });
  assert.throws(() => f.repository.appendAdmittedResult('ordinary-command'), error => error.code === 'policy_denied');
  assert.deepEqual(f.repository.readTranscript('parent').messages, []);
});

test('disposal revokes admission still resolving a model before any row, command, wake or acknowledgment can commit', async t => {
  const selection = gate(), entered = gate();
  const f = await fixture(t, { beforeSelection: async () => { entered.resolve(); await selection.promise; } });
  f.host(); await f.seed('shutdown');
  const tick = f.delivery.tick('parent'); await entered.promise;
  const closing = f.bridge.dispose(); selection.resolve();
  await closing; await tick; await f.service.idle('parent');
  assert.deepEqual(f.repository.readTranscript('parent').messages, []); assert.deepEqual(f.repository.listCommands({ chatId: 'parent' }), []);
  assert.equal(f.calls.length, 0); assert.equal((await journal.loadState('parent')).runs.get('shutdown').delivered, false);
});

test('opaque legacy identities and oversized display fields produce bounded deterministic provenance without rewriting their journal', async t => {
  const f = await fixture(t); f.repository.setAutoResumeBlocked('parent', true);
  const runId = 'legacy.native.' + 'x'.repeat(200000), type = 'native agent '.repeat(20000), parentTurnId = 'native/session:opaque?' + 't'.repeat(256);
  await f.seed(runId, { agentType: type, parentTurnId });
  await f.delivery.tick('parent');
  const message = f.repository.readTranscript('parent').messages[0];
  assert.ok(message.content.length <= 115000);
  assert.match(message.provenance.runId, /^legacy-run-[a-f0-9]{48}$/); assert.match(message.provenance.causalRootId, /^legacy-turn-[a-f0-9]{48}$/);
  const body = JSON.parse(message.content.slice(message.content.indexOf('\n\n') + 2));
  assert.equal(body.runIdTruncated, true); assert.equal(body.typeTruncated, true); assert.equal(body.runId.length, 256); assert.equal(body.type.length, 256);
  const run = (await journal.loadState('parent')).runs.get(runId);
  assert.equal(run.delivered, true); assert.equal(run.runId, runId); assert.equal(run.parentTurnId, parentTurnId); assert.equal(run.type, type);
  await f.delivery.tick('parent'); assert.equal(f.repository.readTranscript('parent').messages.length, 1);
});

test('the ready production runtime installs the journal bridge and resumes through its real shared composer without a viewer', { timeout: 15000 }, async t => {
  const environment = await createProductionRuntimeTestEnvironment();
  const f = await environment.fixture(t, { chats: { coordinator: {} }, toolNames: [], respond: body => {
    assert.ok(body.messages.some(row => row.role === 'system' && row.content.includes('REAL COORDINATION COMPOSER')));
    assert.equal(body.messages.filter(row => row.role === 'user' && row.content.includes('production-legacy')).length, 1);
    return 'The legacy result reached the shared production runner.';
  } });
  t.after(async () => { resetProductionDelivery(); journal.resetJournalCache(); await environment.dispose(); });
  await journal.appendEvent('coordinator', makeEvent('run.requested', { runId: 'production-legacy', agentType: 'explore', task: 'Prior legacy assignment', parentChatId: 'coordinator', cwd: f.workspace, requestedAt: Date.now() }));
  await journal.appendEvent('coordinator', makeEvent('attempt.started', { runId: 'production-legacy', attemptId: 'production-attempt', seed: { kind: 'initial' } }));
  await journal.appendEvent('coordinator', makeEvent('attempt.ended', { runId: 'production-legacy', attemptId: 'production-attempt', outcome: 'pass', summary: 'Original legacy work finished.' }));
  await getProductionDelivery().tick('coordinator'); await f.runtime.service.idle('coordinator');
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.readTranscript('coordinator').messages.filter(row => row.provenance?.runId === 'production-legacy').length, 1);
  assert.equal(f.repository.getLatestExecution('coordinator').status, 'completed');
  assert.equal((await journal.loadState('coordinator')).runs.get('production-legacy').delivered, true);
});
