import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';

let environment, modules;
before(async () => {
  environment = await createProductionRuntimeTestEnvironment();
  modules = Object.assign({}, ...await Promise.all([
    import('../../server/chats/delegation.js'), import('../../server/chats/task-bridge.js'),
    import('../../server/chats/preparation.js'), import('../../server/chats/tools.js'),
    import('../../server/orchestrator/engine.js'), import('../../server/sub-agents/graph.js'),
    import('../../server/sub-agents/journal.js'),
  ]));
  modules.resetJournalCache();
});
after(async () => { modules?.resetJournalCache(); await environment?.dispose(); });
const tool = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const lastUser = body => String(body.messages.filter(row => row.role === 'user').at(-1)?.content ?? '');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate, detail, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Production workflow did not reach: ' + detail);
}
async function installFamily(runtime, adapters, config) {
  const engines = new Map(), effectors = new Map(), errors = [];
  async function getEngine(owner) {
    if (engines.has(owner)) return engines.get(owner);
    let engine;
    const legacy = { inspect: () => [], async start() { throw new Error('Managed production workflow entered legacy execution'); },
      async stop() {}, onEnd() {}, async preflight() {} };
    const effector = modules.createPersistentSubAgentEffector({ legacyEffector: legacy, repository: runtime.repository,
      service: runtime.service, getState: () => engine.getState(), onSettled: input => runtime.taskDelivery.onSettled(input),
      onError: error => errors.push(error) });
    effectors.set(owner, effector);
    engine = modules.createEngine({ boardId: owner, effector, graph: modules.createSubAgentGraph({ globalMaxConcurrent: 2,
      maxConcurrentByType: { questioner: 2, reviewer: 2 } }), journal: modules, tickMs: 20 });
    engines.set(owner, engine); await engine.load(); return engine;
  }
  modules.installChatTools(runtime);
  const delegation = modules.installChatDelegation(runtime, { getEngine, loadConfig: async () => config,
    captureProfile: (chat, scope, options) => modules.captureChatProfile(chat, scope, { ...options, adapters: adapters.preparationAdapters }),
    resolveModelSelection: (input, options) => runtime.resolveModelSelection(input, options),
    onChange: chatId => runtime.presentation.changed(chatId), cancelTree: input => runtime.taskDelivery.cancelTree(input) });
  return { engines, errors, delegation, getEngine, async dispose() {
    try { await until(() => [...effectors.values()].every(effector => effector.inspect().length === 0), 'settled observers during cleanup', 2000); }
    finally { for (const engine of engines.values()) engine.dispose(); }
  } };
}

test('production delegation runs two independent durable child requests, coalesces one parent wake, and accounts usage on each owning chat', { timeout: 30000 }, async t => {
  const parentGate = deferred(), parentWaiting = deferred(); t.after(() => parentGate.resolve());
  const config = { enabled: true, types: { questioner: { enabled: true }, reviewer: { enabled: true } }, defaultContextEnforcementPolicy: 'compact' };
  let f;
  f = await environment.fixture(t, { subAgentTypes: config,
    toolNames: ['spawn_sub_agent', 'ask_question', 'read_file', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop', 'agent_capabilities'],
    chats: { 'workflow-parent': {} }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    install: async (runtime, adapters) => {
      adapters.modelAdapters.listModels = async () => [{ id: 'model' }, { id: 'question-model' }, { id: 'approval-model' }];
      adapters.modelAdapters.readCapabilities = async () => ({ models: Object.fromEntries(['model', 'question-model', 'approval-model']
        .map(model => [model, { tool_use: true, vision: false }])) });
      await fs.writeFile(path.join(adapters.workspace, 'evidence.txt'), 'Canonical evidence from the actual file tool.');
      return installFamily(runtime, adapters, config);
    },
    respond: async body => {
      const input = lastUser(body), tools = body.messages.filter(row => row.role === 'tool');
      if (body.model === 'question-model') {
        if (input.includes('Local child follow-up')) return 'Local follow-up completed.';
        if (input.includes('Question assignment') && !tools.length) return [tool('ask_question', { questions: [{ id: 'version', prompt: 'Which version should I inspect?',
          options: [{ id: 'one', label: 'Version one' }, { id: 'two', label: 'Version two' }] }] }, 'child-question')];
        return [tool('report_outcome', { outcome: 'pass', summary: 'Question child inspected version two.', evidence: ['User answered version two.'] }, 'question-report')];
      }
      if (body.model === 'approval-model') {
        if (!tools.length) return [tool('read_file', { path: 'evidence.txt' }, 'child-read')];
        return [tool('report_outcome', { outcome: 'pass', summary: 'Approval child read canonical evidence.', evidence: ['Read the actual workspace file.'] }, 'approval-report')];
      }
      if (input.includes('[Sub-agent finished]')) return 'Parent combined both durable child results.';
      if (!tools.length) return [
        tool('spawn_sub_agent', { type: 'questioner', task: 'Question assignment', wait: false,
          target: { providerId: f.providerId, modelId: 'question-model' }, client_request_id: 'question-assignment' }, 'spawn-question'),
        tool('spawn_sub_agent', { type: 'reviewer', task: 'Approval assignment', wait: false,
          target: { providerId: f.providerId, modelId: 'approval-model' }, client_request_id: 'approval-assignment' }, 'spawn-approval'),
      ];
      parentWaiting.resolve(); await parentGate.promise; return 'Both assignments were delegated.';
    },
  });
  f.settings.tools.permissions.default.read_file = 'ask';
  const admitted = await f.request('/api/chats/workflow-parent/commands', { action: 'send', text: 'Delegate two independent assignments', clientRequestId: 'parent-start' });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
  await parentWaiting.promise;
  const assignments = await until(() => {
    const rows = f.repository.listCommands().filter(row => row.command.provenance.sourceChatId === 'workflow-parent' && row.runId);
    return rows.length === 2 && rows;
  }, 'two canonical assignments');
  const question = assignments.find(row => row.command.modelSelection.modelId === 'question-model');
  const approval = assignments.find(row => row.command.modelSelection.modelId === 'approval-model');
  assert.ok(question && approval); assert.notEqual(question.chatId, approval.chatId);
  const requests = await until(() => {
    const q = f.repository.listRequests(question.chatId, 'pending')[0], a = f.repository.listRequests(approval.chatId, 'pending')[0];
    return q && a && { q, a };
  }, 'independent question and approval').catch(error => { throw new Error(error.message + '\n' + JSON.stringify({
    commands: f.repository.listCommands().map(row => ({ chat: row.chatId, state: row.state, error: row.error, result: row.result })),
    executions: f.repository.listExecutions().map(row => ({ chat: row.chatId, status: row.status, result: row.result })),
    calls: f.calls.map(body => ({ model: body.model, user: lastUser(body), tools: body.tools.map(row => row.function.name) })),
    errors: f.installation.errors.map(error => String(error)),
  })); });
  assert.equal(requests.q.kind, 'question'); assert.equal(requests.a.kind, 'approval');
  assert.equal(f.repository.getActivity(question.chatId).agentExecution.status, 'waiting_for_input');
  assert.equal(f.repository.getActivity(approval.chatId).agentExecution.status, 'waiting_for_approval');
  assert.equal(f.repository.readTranscript(approval.chatId).messages.some(row => row.role === 'tool' && row.tool_call_id === 'child-read'), false);
  const queuedRemove = await f.request(`/api/chats/${question.chatId}/commands`, { action: 'send', mode: 'queue',
    text: 'Remove this queued assignment', clientRequestId: 'remove-queued-input' });
  assert.equal(queuedRemove.status, 202);
  const removeRecord = await until(() => { const row = f.repository.getCommand(queuedRemove.body.receipt.commandId); return row.runId && row; }, 'queued removal task registration');
  const removed = await f.request(`/api/chats/${question.chatId}/commands`, { action: 'remove', itemId: removeRecord.commandId,
    expectedRevision: removeRecord.revision, clientRequestId: 'remove-queued-control' });
  assert.equal(removed.status, 202, JSON.stringify(removed.body));
  await until(() => f.runtime.taskDelivery.tasks.getResult(removeRecord.runId), 'queued removal graph cancellation');
  assert.equal(f.repository.getCommand(removeRecord.commandId).state, 'cancelled');
  assert.equal(f.repository.getCommand(removeRecord.commandId).result.disposition, 'removed');
  const queuedPush = await f.request(`/api/chats/${question.chatId}/commands`, { action: 'send', mode: 'queue',
    text: 'Push this correction into the current child', clientRequestId: 'push-queued-input' });
  assert.equal(queuedPush.status, 202);
  const pushRecord = await until(() => { const row = f.repository.getCommand(queuedPush.body.receipt.commandId); return row.runId && row; }, 'queued Push task registration');
  const pushed = await f.request(`/api/chats/${question.chatId}/commands`, { action: 'push', itemId: pushRecord.commandId,
    expectedRevision: pushRecord.revision, clientRequestId: 'push-queued-control' });
  assert.equal(pushed.status, 202, JSON.stringify(pushed.body));
  const wrong = await f.request(`/api/chats/${question.chatId}/requests/${requests.a.requestId}/respond`, { clientRequestId: 'wrong-child', answer: 'allow_once' });
  assert.equal(wrong.status, 404); assert.equal(f.repository.getRequest(requests.a.requestId).state, 'pending');
  const answeredQuestion = await f.request(`/api/chats/${question.chatId}/requests/${requests.q.requestId}/respond`, { clientRequestId: 'answer-question', answer: 'Version two' });
  assert.equal(answeredQuestion.status, 200, JSON.stringify(answeredQuestion.body));
  const approvalInput = { clientRequestId: 'allow-read', answer: 'allow_once' };
  const answeredApproval = await f.request(`/api/chats/${approval.chatId}/requests/${requests.a.requestId}/respond`, approvalInput);
  assert.equal(answeredApproval.status, 200, JSON.stringify(answeredApproval.body));
  await until(() => assignments.every(row => f.runtime.taskDelivery.tasks.getResult(row.runId)), 'both immutable task results');
  const originals = assignments.map(row => f.runtime.taskDelivery.tasks.getResult(row.runId));
  assert.ok(originals.every(result => result.status === 'completed'));
  await until(() => f.runtime.taskDelivery.tasks.getResult(pushRecord.runId), 'Push graph cancellation after canonical steer');
  assert.equal(f.repository.getCommand(pushRecord.commandId).state, 'settled');
  assert.equal(f.repository.getCommand(pushRecord.commandId).result.disposition, 'steered');
  assert.equal(f.repository.readTranscript(question.chatId).messages.filter(row => row.commandId === pushRecord.commandId).length, 1);
  assert.equal(f.repository.readTranscript(question.chatId).messages.some(row => row.commandId === removeRecord.commandId), false);
  assert.equal(f.runtime.taskDelivery.tasks.listCohorts().length, 1);
  assert.equal(f.runtime.taskDelivery.tasks.listCohorts()[0].runIds.length, 2);
  assert.equal(f.repository.listCommands({ chatId: 'workflow-parent' }).filter(row => row.command.provenance.source === 'task_delivery').length, 0);
  parentGate.resolve();
  const wake = await until(() => f.repository.listCommands({ chatId: 'workflow-parent' }).find(row => row.command.provenance.source === 'task_delivery' && row.state === 'settled'), 'one durable parent wake');
  assert.ok(assignments.every(row => wake.command.message.includes(row.runId)));
  const replayApproval = await f.request(`/api/chats/${approval.chatId}/requests/${requests.a.requestId}/respond`, approvalInput);
  assert.equal(replayApproval.status, 200);
  assert.equal(f.repository.readTranscript(approval.chatId).messages.filter(row => row.role === 'tool' && row.tool_call_id === 'child-read').length, 1);
  assert.match(f.repository.readTranscript(approval.chatId).messages.find(row => row.role === 'tool' && row.tool_call_id === 'child-read').content, /Canonical evidence/);
  const events = await modules.readEvents('workflow-parent');
  for (const obsolete of [removeRecord, pushRecord]) {
    assert.equal(events.filter(event => event.type === 'attempt.started' && event.runId === obsolete.runId).length, 0);
    assert.equal(events.filter(event => event.type === 'run.cancelled' && event.runId === obsolete.runId).length, 1);
  }
  for (const assignment of assignments) {
    assert.equal(events.filter(event => event.type === 'run.requested' && event.runId === assignment.runId).length, 1);
    assert.equal(events.filter(event => event.type === 'attempt.started' && event.runId === assignment.runId).length, 1);
    assert.equal(events.filter(event => event.type === 'attempt.ended' && event.runId === assignment.runId).length, 1);
    const delivered = events.filter(event => event.type === 'result.delivered' && event.runId === assignment.runId);
    assert.equal(delivered.length, 1); assert.equal(delivered[0].commandId, wake.commandId);
    assert.equal(f.repository.getCommand(assignment.commandId).state, 'settled');
  }
  const followup = await f.request(`/api/chats/${question.chatId}/commands`, { action: 'send', text: 'Local child follow-up', clientRequestId: 'child-followup' });
  assert.equal(followup.status, 202, JSON.stringify(followup.body));
  await until(() => f.repository.getCommand(followup.body.receipt.commandId).state === 'settled', 'local child continuation');
  const local = f.repository.getCommand(followup.body.receipt.commandId);
  assert.equal(local.captured.completionPolicy, undefined);
  assert.equal(f.runtime.taskDelivery.tasks.getResult(local.runId).completionPolicy.kind, 'local_only');
  assert.deepEqual(assignments.map(row => f.runtime.taskDelivery.tasks.getResult(row.runId)), originals);
  assert.equal(f.repository.listCommands({ chatId: 'workflow-parent' }).filter(row => row.command.provenance.source === 'task_delivery').length, 1);
  const parentLedger = f.repository.getChat('workflow-parent').tokenLedger;
  const questionLedger = f.repository.getChat(question.chatId).tokenLedger, approvalLedger = f.repository.getChat(approval.chatId).tokenLedger;
  assert.equal(parentLedger.totals.completionCount, 3); assert.equal(questionLedger.totals.completionCount, 3); assert.equal(approvalLedger.totals.completionCount, 2);
  assert.equal(parentLedger.totals.totalTokens, 45); assert.equal(questionLedger.totals.totalTokens, 45); assert.equal(approvalLedger.totals.totalTokens, 30);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM chat_usage_receipts').get().n, f.calls.length);
  assert.equal(f.calls.length, 8); assert.ok(parentLedger.entries.every(entry => entry.source.kind === 'main'));
  assert.ok(questionLedger.entries.every(entry => entry.modelId === 'question-model'));
  assert.ok(approvalLedger.entries.every(entry => entry.modelId === 'approval-model'));
  assert.deepEqual(f.installation.errors, []);
});
