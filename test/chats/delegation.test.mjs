import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatPolicy, intersectChatPolicies } from '../../server/chats/policy.js';
import { createChatProjectRegistry, resolveProjectScope, createChatCaller } from '../../server/chats/caller.js';
import { createChatDelegation } from '../../server/chats/delegation.js';
import { createPersistentSubAgentEffector, createLazyPersistentSubAgentEffector, observePersistentAgentTurn } from '../../server/chats/task-bridge.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { createChatTaskDelivery } from '../../server/chats/task-delivery.js';
import { createServerChatExecutionHost } from '../../server/chats/execution-host.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createSubAgentGraph } from '../../server/sub-agents/graph.js';
import * as agentsJournal from '../../server/sub-agents/journal.js';
import { createChatPolicy as policyFromStored } from '../../server/chats/policy.js';
import { derive, serializeState } from '../../server/sub-agents/derive.js';
import { plan } from '../../server/sub-agents/plan.js';
import { makeEvent, EVENT_TYPES } from '../../server/sub-agents/events.js';
import { subscribeLive } from '../../server/orchestrator/live-events.js';
import { readTranscript } from '../../server/orchestrator/transcripts.js';

const enabled = () => ({ version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true, reason: 'development_opt_in' });
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) { for (let n = 0; n < 400; n++) { if (await predicate()) return; await pause(); } throw new Error('Durable task did not reach the expected state'); }
function response() { return new Response('data: {"choices":[{"delta":{"content":"A complete result."}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); }
function deps(post) { return {
  postChatCompletions: post, resolveProvider: async () => ({ id: 'fixture', apiKind: 'openai-v1' }),
  getSubAgentTypeConfig: async () => ({}), resolveSamplerPreset: () => ({ preset: {}, maxTokens: 100 }),
  resolveThinkingMode: () => ({ mode: 'off' }), resolveThinkingBudgetTokens: () => ({ budgetTokens: null }),
  loadToolCallsMeta: async () => {}, getToolCallsMetaSync: () => ({ useConstrainedDecoding: false }),
  isConstrainedDecodingEnabledForProvider: () => false, readProviderCapabilities: async () => null,
  isStructuredOutcomeResponseFormatAvailable: () => false, resolveSendCapabilities: () => ({}),
  resolveModelContextLimit: () => null, applyContextPolicy: async input => ({ applied: false, messages: input.messages }),
}; }
function fixture(overrides = {}) {
  const previousHome = process.env.MINNOW_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-delegation-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache(); agentsJournal.resetJournalCache();
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'parent', name: 'Parent', workspacePath: home, providerId: 'fixture', modelId: 'parent-model', modeId: 'plan' });
  const sourceFence = repository.claimExecution({ chatId: 'parent', executionId: 'parent-execution', ownerId: 'parent-host', captured: { modelSelection: { providerId: 'fixture', modelId: 'captured-parent', options: { reasoningEffort: 'high' } } } });
  const registry = createChatProjectRegistry([{ projectId: 'project', workspaceId: 'workspace', canonicalKey: home }]);
  const scope = resolveProjectScope(registry, { projectId: 'project', workspaceKey: home });
  const policy = createChatPolicy({ modeId: 'plan', workspaceIds: ['workspace'], toolPermissions: { read_file: 'full', spawn_sub_agent: 'full' },
    fileWriteScope: 'plans', capabilities: ['chat.read', 'chat.send', 'chat.stop', 'agent.spawn', 'request.respond', 'execution.host'] });
  const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: 'parent-execution', executionActive: true, scope, policy });
  const human = createChatCaller({ actor: 'human', ingress: 'renderer', chatId: 'human', scope, policy });
  const context = { async resolveTarget(chatId) {
    const chat = repository.getChat(chatId), profile = repository.getLatestProfile(chatId);
    return { chat, scope, registry, profile, currentPolicy: policy,
      policy: profile ? intersectChatPolicies(policyFromStored(profile.snapshot.policy), policy) : policy, project: { projectId: 'project', registry, scope } };
  } };
  let canRun = false, posts = 0, modelResolutions = 0;
  const requests = [], settlements = [], errors = [], engines = new Map();
  let delegation;
  const service = createChatCommandService({ repository, context, feature: enabled,
    resolveModelSelection: ({ selection }) => selection,
    admitChildTask: input => delegation.admitChildTask(input), onCommand: record => delegation?.onCommand(record), onError: error => errors.push(error) });
  const host = createServerChatExecutionHost({ repository, onEvent: observePersistentAgentTurn, resolveCurrentPolicy: async input => (await context.resolveTarget(input.command.chatId)).policy,
    prepareExecution: async ({ command }) => ({ systemPrompt: 'Captured role prompt used by the deterministic fixture.', tools: [],
      model: { providerId: command.modelSelection.providerId, id: command.modelSelection.modelId }, cwd: home,
      policy: (await context.resolveTarget(command.chatId)).policy,
      deps: deps(async (_provider, body) => {
        posts++; requests.push(body);
        const events = await agentsJournal.readEvents('parent'); assert.ok(events.some(event => event.type === 'attempt.started'));
        return overrides.post ? overrides.post({ body, posts }) : response();
      }), runOptions: { injectReportTool: false, nudgeToolUse: false, finalizeStructuredOutcome: false } }) });
  service.registerHost({ id: 'fixture-host', kind: 'server', supportsSteer: true, canRun: () => canRun, execute: input => host.execute(input) });
  async function getEngine(owner) {
    if (engines.has(owner)) return engines.get(owner);
    let engine;
    const legacy = { inspect: () => [], async start() { throw new Error('Legacy path must not execute managed work'); }, async stop() {}, onEnd() {}, async preflight() {} };
    const bridge = (overrides.bridgeFactory ?? createPersistentSubAgentEffector)({ legacyEffector: legacy, repository, service, getState: () => engine.getState(),
      onError: error => errors.push(error), onSettled: ({ run, result, executionId, attemptId }) => {
        settlements.push({ runId: run.runId, childChatId: run.childChatId, phase: run.phase, completionPolicy: run.completionPolicy, summary: result.summary });
        if (run.phase !== 'passed') return;
        service.settleChildTask({ commandId: run.commandId, runId: run.runId, result: { version: 1, runId: run.runId, childChatId: run.childChatId,
          journalOwnerId: run.journalOwnerId, executionId, attemptId, status: 'completed', summary: result.summary, settledAt: Date.now(), completionPolicy: run.completionPolicy } });
      } });
    engine = createEngine({ boardId: owner, effector: bridge, graph: createSubAgentGraph({ globalMaxConcurrent: 2, maxConcurrentByType: { explore: 2 } }), journal: agentsJournal, tickMs: 50 });
    engines.set(owner, engine); await engine.load(); return engine;
  }
  delegation = createChatDelegation({ repository, context, service, getEngine, feature: enabled,
    validateSourceCaller: source => { try { return source === caller && Boolean(repository.assertFence('parent', sourceFence)); } catch { return false; } },
    loadConfig: async () => ({ enabled: true, types: { explore: { enabled: true } } }),
    captureProfile: async () => ({ policy, exactModel: false, typeId: 'explore', typeConfig: { enabled: true }, prompt: { sources: { captured: 'Private role instructions' } } }),
    resolveModelSelection: async input => { modelResolutions++; return { selection: input.target ?? input.parentSelection, source: input.target ? 'explicit' : 'parent', exactModel: Boolean(input.target) }; },
    ...overrides,
  });
  return { repository, db, caller, human, context, delegation, service, engines, settlements, requests, errors, home, policy,
    get posts() { return posts; }, get modelResolutions() { return modelResolutions; }, enableHost() { canRun = true; }, getEngine,
    async cleanup() { for (const engine of engines.values()) engine.dispose(); await service.dispose(); db.close(); agentsJournal.resetJournalCache();
      if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome; resetMinnowHomeCache();
      assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(home, { recursive: true, force: true }); }
  };
}

test('a family engine cached before chat runtime boot later executes canonical managed tasks', async () => {
  let runtime, lookups = 0;
  const s = fixture({ bridgeFactory: ({ service, repository, onSettled, ...options }) => createLazyPersistentSubAgentEffector({ ...options,
    getRuntime: async () => { lookups++; assert.ok(runtime, 'runtime is only needed at managed admission'); return runtime; },
  }) });
  try {
    await s.getEngine('parent');
    assert.equal(lookups, 0, 'booting a legacy family must not recursively boot chat runtime');
    runtime = { service: s.service, repository: s.repository, taskDelivery: { onSettled: ({ run, result, executionId, attemptId }) => {
      s.service.settleChildTask({ commandId: run.commandId, runId: run.runId, result: { version: 1, runId: run.runId,
        childChatId: run.childChatId, journalOwnerId: run.journalOwnerId, executionId, attemptId, status: 'completed',
        summary: result.summary, settledAt: Date.now(), completionPolicy: run.completionPolicy } });
    } } };
    s.enableHost();
    const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Execute after boot', client_request_id: 'late-runtime' });
    await until(() => s.repository.getCommand(receipt.commandId).state === 'settled');
    assert.ok(lookups > 0);
    assert.equal(s.posts, 1);
    assert.equal(s.repository.readTranscript(receipt.childChatId).messages.at(-1).content, 'A complete result.');
    assert.equal(s.errors.length, 0);
  } finally { await s.cleanup(); }
});

test('spawn atomically captures one child/profile/command and append-once journal; repeated or conflicting requests cannot manufacture chats', async () => {
  const s = fixture();
  try {
    const input = { type: 'explore', task: 'Inspect the build', title: 'Build inspection', client_request_id: 'request' };
    const [first, concurrent] = await Promise.all([s.delegation.spawn(s.caller, input, { toolCallId: 'spawn' }), s.delegation.spawn(s.caller, input, { toolCallId: 'spawn' })]);
    assert.equal(first.childChatId, concurrent.childChatId); assert.equal(first.runId, concurrent.runId);
    assert.equal(s.repository.listChats().length, 2);
    const relation = s.repository.getRelation(first.childChatId), profile = s.repository.getLatestProfile(first.childChatId);
    assert.equal(relation.parentChatId, 'parent'); assert.equal(relation.journalOwnerId, 'parent');
    assert.equal(profile.snapshot.policy.modeId, 'plan'); assert.equal(profile.snapshot.policy.toolPermissions.spawn_sub_agent, 'off');
    assert.equal(profile.snapshot.policy.capabilities.includes('agent.spawn'), false);
    assert.equal(s.repository.readTranscript(first.childChatId).messages.length, 0);
    assert.deepEqual(first.modelSelection, { providerId: 'fixture', modelId: 'captured-parent', options: { reasoningEffort: 'high' } });
    assert.equal(first.completionPolicy.kind, 'wake_delegator'); assert.equal(first.completionPolicy.recipientChatId, 'parent');
    const replay = await s.delegation.spawn(s.caller, input, { toolCallId: 'spawn' }); assert.equal(replay.replayed, true);
    await assert.rejects(s.delegation.spawn(s.caller, { ...input, title: 'Changed title' }, { toolCallId: 'spawn' }), { code: 'idempotency_conflict' });
    const events = await agentsJournal.readEvents('parent'); assert.equal(events.length, 1); assert.equal(events[0].childChatId, first.childChatId);
    assert.equal(s.posts, 0);
  } finally { await s.cleanup(); }
});

test('invalid model, unavailable checkout, forged caller and cancellation during async capture leave no phantom child', async () => {
  for (const failure of ['model', 'checkout', 'caller', 'cancel']) {
    let release, captured;
    const s = fixture(failure === 'model' ? { resolveModelSelection: async () => { throw Object.assign(new Error('Missing explicit model'), { code: 'model_unavailable' }); } }
      : failure === 'cancel' ? { captureProfile: async () => { captured = true; await new Promise(resolve => { release = resolve; }); return { policy: s.policy }; } } : {});
    try {
      const pending = s.delegation.spawn(failure === 'caller' ? { ...s.caller } : s.caller,
        { type: 'explore', task: 'Inspect', ...(failure === 'checkout' ? { workspace_strategy: 'new_worktree' } : {}) }, { toolCallId: 'spawn' });
      pending.catch(() => {});
      if (failure === 'cancel') { while (!captured) await pause(); s.repository.advanceCancellationEpoch('parent'); release(); }
      await assert.rejects(pending);
      assert.equal(s.repository.listChats().length, 1); assert.equal(s.repository.listCommands().length, 0);
      assert.equal(s.repository.listOutbox().length, 0); assert.equal(s.posts, 0);
    } finally { await s.cleanup(); }
  }
});

test('existing graph defers ownership without attempts, then activates canonical shared runner only after its journal start', async () => {
  const s = fixture();
  try {
    const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Inspect' }, { toolCallId: 'spawn' });
    const engine = await s.getEngine('parent');
    for (let n = 0; n < 4; n++) await engine.tick();
    assert.equal(engine.getState().runs.get(receipt.runId).attempts.length, 0); assert.deepEqual(engine.getStartFailures(), []);
    s.enableHost(); await engine.tick();
    await until(() => s.repository.getCommand(receipt.commandId).state === 'settled');
    assert.equal(s.posts, 1); assert.equal(s.settlements[0].phase, 'passed');
    const history = s.repository.readTranscript(receipt.childChatId).messages;
    assert.deepEqual(history.map(row => row.role), ['user', 'assistant']); assert.equal(history[0].content, 'Inspect');
    assert.equal(engine.getState().runs.get(receipt.runId).attempts.length, 1);
    assert.equal(s.errors.length, 0);
  } finally { await s.cleanup(); }
});

test('human follow-up keeps the canonical child, >50 rows and family, with a new immutable local-only task after parent deletion', async () => {
  const s = fixture();
  try {
    s.enableHost(); const first = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Initial assignment' }, { toolCallId: 'spawn' });
    await until(() => s.repository.getCommand(first.commandId).state === 'settled');
    const initial = s.repository.getCommand(first.commandId).result;
    const maintenance = s.repository.claimExecution({ chatId: first.childChatId, executionId: 'history-fixture', ownerId: 'fixture' });
    for (let index = 0; index < 52; index++) s.repository.appendMessage(first.childChatId, { role: index % 2 ? 'assistant' : 'user', content: `Saved history ${index}` }, { fence: maintenance, messageId: `history-${index}` });
    s.repository.updateExecution('history-fixture', { status: 'completed' }, { fence: maintenance }); s.repository.releaseLease(first.childChatId, maintenance);
    s.db.prepare('DELETE FROM chats WHERE id=?').run('parent');
    const followup = await s.service.send(s.human, { chatId: first.childChatId, message: 'A second assignment', clientRequestId: 'followup' });
    await until(() => s.repository.getCommand(followup.commandId).state === 'settled');
    const record = s.repository.getCommand(followup.commandId), run = (await s.getEngine('parent')).getState().runs.get(record.runId);
    assert.notEqual(record.runId, first.runId); assert.equal(run.childChatId, first.childChatId); assert.equal(run.journalOwnerId, 'parent');
    assert.deepEqual(run.completionPolicy, { version: 1, kind: 'local_only' });
    assert.deepEqual(s.repository.getCommand(first.commandId).result, initial);
    assert.equal(s.repository.readTranscript(first.childChatId).messages.length, 56);
    assert.ok(s.requests.at(-1).messages.length > 50);
    assert.equal(s.requests.at(-1).messages.filter(row => row.content === 'A second assignment').length, 1);
    assert.equal(s.errors.length, 0);
  } finally { await s.cleanup(); }
});

test('pure managed graph retains seven events, stable task identity, recovery barrier and FIFO child slots', () => {
  const requested = (runId, childChatId) => makeEvent('run.requested', { runId, childChatId, journalOwnerId: 'family', commandId: `command-${runId}`,
    executionKind: 'chat', agentType: 'explore', task: runId, parentChatId: 'family', cwd: '/fixture', requestedAt: 1,
    completionPolicy: { version: 1, kind: 'local_only' }, profileReference: { profileId: 'profile', profileVersion: 1 }, policy: {} });
  const events = [requested('first', 'one'), requested('second', 'one'), requested('third', 'two')];
  const state = derive(events); assert.equal(EVENT_TYPES.length, 7);
  assert.deepEqual(plan(state, { globalMaxConcurrent: 2, maxConcurrentByType: { explore: 2 } }).map(row => row.taskId), ['first', 'third']);
  const held = derive([...events, makeEvent('attempt.started', { runId: 'first', attemptId: 'attempt', seed: {} }),
    makeEvent('attempt.ended', { runId: 'first', attemptId: 'attempt', outcome: 'crashed', evidence: { recoveryRequired: true } }),
    requested('first', 'changed')]);
  assert.equal(held.runs.get('first').phase, 'recovery_required'); assert.equal(held.runs.get('first').task, 'first');
  assert.deepEqual(plan(held, { globalMaxConcurrent: 2, maxConcurrentByType: { explore: 2 } }).map(row => row.taskId), ['third']);
  assert.equal(serializeState(held), serializeState(derive([...events, makeEvent('attempt.started', { runId: 'first', attemptId: 'attempt', seed: {} }),
    makeEvent('attempt.ended', { runId: 'first', attemptId: 'attempt', outcome: 'crashed', evidence: { recoveryRequired: true } })])));
});

test('lost child transaction acknowledgement and journal acknowledgement recover through the original outbox identity', async () => {
  for (const boundary of ['child', 'journal']) {
    const s = fixture();
    try {
      const atomic = s.repository.atomic, finish = s.repository.finishOutbox;
      let injected = false, depth = 0;
      if (boundary === 'child') s.repository.atomic = work => {
        depth++;
        try {
          const result = atomic(work);
          // Subscription storage nests a transaction; lose only the completed
          // outer commit acknowledgement rather than rolling that commit back.
          if (depth === 1 && !injected) { injected = true; throw new Error('Child commit acknowledgement lost'); }
          return result;
        } finally { depth--; }
      };
      else s.repository.finishOutbox = (...args) => { if (!injected) { injected = true; throw new Error('Journal acknowledgement lost'); } return finish(...args); };
      const input = { type: 'explore', task: 'Inspect', client_request_id: 'stable-request' };
      await assert.rejects(s.delegation.spawn(s.caller, input, { toolCallId: 'spawn' }), /acknowledgement lost/);
      assert.equal(s.repository.listChats().length, 2);
      s.repository.atomic = atomic; s.repository.finishOutbox = finish;
      // The same outbox owner may retry its lost acknowledgement immediately;
      // append-once retains the original journal sequence without a TTL wait.
      const recovered = await s.delegation.spawn(s.caller, input, { toolCallId: 'spawn' });
      assert.equal(recovered.replayed, true); assert.equal(s.repository.listChats().length, 2);
      assert.equal((await agentsJournal.readEvents('parent')).filter(event => event.type === 'run.requested').length, 1);
      assert.equal(s.repository.getOutbox(`request-${recovered.runId}`).state, 'applied');
      assert.equal(s.posts, 0);
    } finally { await s.cleanup(); }
  }
});

test('append-once journal rejects changed payload and concurrent retries consume one durable sequence', async () => {
  const s = fixture();
  try {
    const engine = await s.getEngine('parent');
    const event = makeEvent('run.requested', { runId: 'run', agentType: 'explore', task: 'Original', parentChatId: 'parent', cwd: s.home, requestedAt: 1 });
    const [first, replay] = await Promise.all([engine.append([event], { idempotencyKey: 'append-key' }), engine.append([event], { idempotencyKey: 'append-key' })]);
    assert.equal(first[0].seq, replay[0].seq); assert.equal((await agentsJournal.readEvents('parent')).length, 1);
    await assert.rejects(engine.append([{ ...event, task: 'Changed' }], { idempotencyKey: 'append-key' }), { code: 'idempotency_conflict' });
    assert.equal(engine.getState().runs.get('run').task, 'Original');
  } finally { await s.cleanup(); }
});

test('journal start failure cancels the prepared owner before provider work and never records a phantom attempt', async () => {
  const s = fixture();
  try {
    const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Inspect' }, { toolCallId: 'spawn' });
    const engine = await s.getEngine('parent');
    const append = agentsJournal.appendEvent;
    // The real journal remains on disk; replace only the engine adapter's
    // start event commit so its prepared service lease is exercised normally.
    const badJournal = { ...agentsJournal, appendEvent(owner, event, options) {
      if (event.type === 'attempt.started') throw new Error('Start journal unavailable');
      return append(owner, event, options);
    } };
    engine.dispose(); s.engines.delete('parent');
    let replacement;
    const legacy = { inspect: () => [], async start() { throw new Error('Unexpected legacy work'); }, async stop() {}, onEnd() {} };
    const bridge = createPersistentSubAgentEffector({ legacyEffector: legacy, service: s.service, repository: s.repository,
      getState: () => replacement.getState(), onError: error => s.errors.push(error) });
    replacement = createEngine({ boardId: 'parent', effector: bridge, graph: createSubAgentGraph(), journal: badJournal, tickMs: 1000 });
    s.engines.set('parent', replacement); await replacement.load(); s.enableHost();
    await assert.rejects(replacement.tick(), /Start journal unavailable/);
    assert.equal(s.posts, 0); assert.equal(replacement.getState().runs.get(receipt.runId).attempts.length, 0);
    assert.equal(s.repository.getCommand(receipt.commandId).held, true);
    assert.equal(s.repository.getLease(receipt.childChatId).state, 'released');
  } finally { await s.cleanup(); }
});

test('ordinary crash retry resumes the same canonical child and task without duplicating its accepted assignment', async () => {
  const s = fixture({ post: ({ posts }) => { if (posts === 1) throw new Error('Transient transport failed'); return response(); } });
  try {
    s.enableHost(); const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Complete one assignment' }, { toolCallId: 'spawn' });
    await until(() => s.repository.getCommand(receipt.commandId).state === 'settled');
    const run = (await s.getEngine('parent')).getState().runs.get(receipt.runId);
    assert.equal(run.task, 'Complete one assignment'); assert.equal(run.phase, 'passed');
    assert.equal(run.attempts.length, 2); assert.notEqual(run.attempts[0].executionId, run.attempts[1].executionId);
    const messages = s.repository.readTranscript(receipt.childChatId).messages;
    assert.equal(messages.filter(row => row.role === 'user').length, 1); assert.equal(messages[0].content, 'Complete one assignment');
    assert.equal(s.posts, 2); assert.equal(s.errors.length, 0);
  } finally { await s.cleanup(); }
});

test('passive attempt activity uses one family channel and flushes auxiliary audit before terminal publication', async () => {
  const s = fixture(); const family = [], unrelated = [];
  const offFamily = subscribeLive('parent', frame => family.push(frame));
  const offOther = subscribeLive('other-family', frame => unrelated.push(frame));
  try {
    s.enableHost(); const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Inspect' }, { toolCallId: 'spawn' });
    await until(() => s.repository.getCommand(receipt.commandId).state === 'settled');
    const run = (await s.getEngine('parent')).getState().runs.get(receipt.runId), attempt = run.attempts[0];
    assert.equal(run.executionId, attempt.executionId); assert.equal(unrelated.length, 0);
    assert.ok(family.some(frame => frame.event.type === 'delta' && frame.event.text === 'A complete result.'));
    assert.ok(family.every(frame => frame.taskId === receipt.runId && frame.attemptId === attempt.attemptId));
    const audit = await readTranscript('parent', attempt.attemptId, { entryDir: agentsJournal.agentsDir('parent') });
    assert.equal(audit.events.at(-1).type, 'attempt_end'); assert.equal(audit.events.at(-1).name, 'pass');
    const count = family.length;
    observePersistentAgentTurn({ chatId: receipt.childChatId, executionId: attempt.executionId, event: { type: 'delta', text: 'Late stale event' } });
    assert.equal(family.length, count); assert.equal(s.repository.readTranscript(receipt.childChatId).messages.at(-1).content, 'A complete result.');
  } finally { offFamily(); offOther(); await s.cleanup(); }
});

test('model validation precedes checkout effects and the verified allocator receives stable identities plus source abort', async () => {
  let allocations = 0;
  const rejected = fixture({ resolveModelSelection: async () => { throw new Error('Model unavailable'); }, resolveWorkspace: async () => { allocations++; } });
  try {
    await assert.rejects(rejected.delegation.spawn(rejected.caller, { type: 'explore', task: 'Inspect', workspace_strategy: 'new_worktree' }, { toolCallId: 'spawn' }), /Model unavailable/);
    assert.equal(allocations, 0); assert.equal(rejected.repository.listChats().length, 1);
  } finally { await rejected.cleanup(); }
  let allocationStarted = false; const identities = [];
  const s = fixture({ resolveWorkspace: async input => {
    identities.push({ allocationId: input.allocationId, childChatId: input.childChatId });
    assert.equal(input.strategy.kind, 'new_worktree');
    if (identities.length === 1) {
      allocationStarted = true;
      await new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    }
    return { workspacePath: input.target.scope.canonicalKey, scope: input.target.scope, registry: input.target.registry };
  } });
  try {
    const stop = new AbortController();
    const input = { type: 'explore', task: 'Inspect', workspace_strategy: 'new_worktree', client_request_id: 'checkout' };
    const first = s.delegation.spawn(s.caller, input, { toolCallId: 'spawn', signal: stop.signal }); first.catch(() => {});
    while (!allocationStarted) await pause(); stop.abort(new DOMException('Stop setup', 'AbortError'));
    await assert.rejects(first, { name: 'AbortError' }); assert.equal(s.repository.listChats().length, 1);
    const retry = await s.delegation.spawn(s.caller, input, { toolCallId: 'spawn', signal: new AbortController().signal });
    assert.deepEqual(identities[0], identities[1]); assert.equal(retry.childChatId, identities[0].childChatId);
  } finally { await s.cleanup(); }
});

test('family live projection coalesces burst prose and thoughts and rejects another child or execution', async () => {
  let release, entered = false;
  const s = fixture({ post: () => { entered = true; return new Promise(resolve => { release = () => resolve(response()); }); } });
  const frames = [], off = subscribeLive('parent', frame => frames.push(frame));
  try {
    s.enableHost(); const receipt = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Inspect' }, { toolCallId: 'spawn' });
    while (!entered) await pause();
    const executionId = s.repository.getCommand(receipt.commandId).executionId;
    for (let index = 0; index < 50; index++) {
      observePersistentAgentTurn({ chatId: receipt.childChatId, executionId, event: { type: 'delta', text: `Prose ${index}` } });
      observePersistentAgentTurn({ chatId: receipt.childChatId, executionId, event: { type: 'thinking', text: `Thought ${index}` } });
    }
    observePersistentAgentTurn({ chatId: 'other-child', executionId, event: { type: 'delta', text: 'Wrong child' } });
    observePersistentAgentTurn({ chatId: receipt.childChatId, executionId: 'other-execution', event: { type: 'delta', text: 'Wrong execution' } });
    observePersistentAgentTurn({ chatId: receipt.childChatId, executionId, event: { type: 'phase', phase: 'tools' } });
    assert.deepEqual(frames.filter(frame => frame.event.type === 'delta').map(frame => frame.event.text), ['Prose 49']);
    assert.deepEqual(frames.filter(frame => frame.event.type === 'thinking').map(frame => frame.event.text), ['Thought 49']);
    release(); await until(() => s.repository.getCommand(receipt.commandId).state === 'settled');
    assert.equal(s.repository.readTranscript(receipt.childChatId).messages.at(-1).content, 'A complete result.');
  } finally { release?.(); off(); await s.cleanup(); }
});

test('removing a queued child input cancels its licensed task and cannot block a later child continuation', async () => {
  let delivery;
  const s = fixture({ onTerminal: input => delivery.onSettled(input) });
  delivery = createChatTaskDelivery({ repository: s.repository, context: s.context, service: s.service,
    isRecipientBusy: () => true, retryMs: 1000000 });
  try {
    const original = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Remove this queued assignment' }, { toolCallId: 'queued-spawn' });
    const record = s.repository.getCommand(original.commandId);
    await s.service.removeQueued(s.human, { chatId: original.childChatId, targetCommandId: original.commandId,
      expectedRevision: record.revision, clientRequestId: 'remove-queued-task' });
    const engine = await s.getEngine('parent');
    await until(() => engine.getState().runs.get(original.runId)?.phase === 'cancelled');
    await until(() => delivery.tasks.getResult(original.runId)?.status === 'cancelled');
    s.enableHost();
    const next = await s.service.send(s.human, { chatId: original.childChatId, message: 'A later task in the same child', clientRequestId: 'later-task' });
    await until(() => s.repository.getCommand(next.commandId).state === 'settled');
    assert.equal(s.posts, 1);
    assert.equal(s.repository.getCommand(original.commandId).result.disposition, 'removed');
    assert.deepEqual(s.repository.readTranscript(original.childChatId).messages.map(row => row.role), ['user', 'assistant']);
    assert.equal(s.errors.length, 0);
  } finally { await delivery.dispose(); await s.cleanup(); }
});

test('Push now applied as canonical steering retires its queued task instead of running that input twice', async () => {
  let release, waiting = false, delivery;
  const s = fixture({ onTerminal: input => delivery.onSettled(input), post: async ({ posts }) => {
    if (posts === 2) { waiting = true; await new Promise(resolve => { release = resolve; }); }
    return response();
  } });
  delivery = createChatTaskDelivery({ repository: s.repository, context: s.context, service: s.service,
    isRecipientBusy: () => true, retryMs: 1000000 });
  try {
    s.enableHost();
    const initial = await s.delegation.spawn(s.caller, { type: 'explore', task: 'Initial' }, { toolCallId: 'initial' });
    await until(() => s.repository.getCommand(initial.commandId).state === 'settled');
    const active = await s.service.send(s.human, { chatId: initial.childChatId, message: 'Active task', clientRequestId: 'active' });
    await until(() => waiting);
    const queued = await s.service.send(s.human, { chatId: initial.childChatId, message: 'Push this correction', mode: 'queue', clientRequestId: 'queued-correction' });
    const engine = await s.getEngine('parent');
    await until(() => Boolean(engine.getState().runs.get(s.repository.getCommand(queued.commandId).runId)));
    const task = s.repository.getCommand(queued.commandId);
    await s.service.pushQueued(s.human, { chatId: initial.childChatId, targetCommandId: queued.commandId,
      expectedRevision: task.revision, clientRequestId: 'push-correction' });
    const execution = s.repository.getLatestExecution(initial.childChatId);
    const consumed = s.service.consumeSteers(execution.executionId, s.repository.getLease(initial.childChatId));
    assert.equal(consumed.messages[0].content, 'Push this correction');
    await until(() => engine.getState().runs.get(task.runId)?.phase === 'cancelled');
    await until(() => delivery.tasks.getResult(task.runId)?.status === 'cancelled');
    assert.equal(delivery.tasks.getResult(task.runId).executionId, undefined);
    assert.equal(s.repository.getCommand(queued.commandId).result.disposition, 'steered');
    release();
    await until(() => s.repository.getCommand(active.commandId).state === 'settled');
    assert.equal(s.posts, 2);
    assert.equal(s.repository.readTranscript(initial.childChatId).messages.filter(row => row.content === 'Push this correction').length, 1);
    assert.equal(s.errors.length, 0);
  } finally { release?.(); await delivery.dispose(); await s.cleanup(); }
});
