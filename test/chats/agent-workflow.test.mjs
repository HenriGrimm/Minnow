import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { withFactoryActivity } from '../../server/chats/factory-activity.js';

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

test('production delegation runs two independent durable child requests, coalesces one parent wake, and accounts usage on each owning chat', { timeout: 45000 }, async t => {
  const parentGate = deferred(), parentWaiting = deferred(); t.after(() => parentGate.resolve());
  const config = { enabled: true, types: { questioner: { enabled: true }, reviewer: { enabled: true } }, defaultContextEnforcementPolicy: 'compact' };
  let f;
  f = await environment.fixture(t, { subAgentTypes: config,
    toolNames: ['spawn_sub_agent', 'ask_question', 'save_file', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop', 'agent_capabilities'],
    chats: { 'workflow-parent': {} }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    install: async (runtime, adapters) => {
      adapters.modelAdapters.listModels = async () => [{ id: 'model' }, { id: 'question-model' }, { id: 'approval-model' }];
      adapters.modelAdapters.readCapabilities = async () => ({ models: Object.fromEntries(['model', 'question-model', 'approval-model']
        .map(model => [model, { tool_use: true, vision: false }])) });
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
        if (!tools.length) return [tool('save_file', { path: 'evidence.txt', content: 'Canonical evidence from the actual file tool.' }, 'child-write')];
        return [tool('report_outcome', { outcome: 'pass', summary: 'Approval child saved canonical evidence.', evidence: ['Saved the actual workspace file.'] }, 'approval-report')];
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
  f.settings.meta.toolSecurity.permissionLevel = 'manual';
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
  }, 'independent question and approval').catch(withWorkflowState);
  function withWorkflowState(error) {
    throw new Error(error.message + '\n' + JSON.stringify({
      commands: f.repository.listCommands().map(row => ({ chat: row.chatId, state: row.state, error: row.error, result: row.result })),
      executions: f.repository.listExecutions().map(row => ({ chat: row.chatId, status: row.status, result: row.result })),
      calls: f.calls.map(body => ({ model: body.model, user: lastUser(body), tools: body.tools.map(row => row.function.name) })),
      errors: f.installation.errors.map(error => String(error)),
    }), { cause: error });
  }
  assert.equal(requests.q.kind, 'question'); assert.equal(requests.a.kind, 'approval');
  const { caller } = await f.runtime.context.executionCaller(f.repository.getLatestExecution('workflow-parent').executionId);
  const wait = await f.runtime.chatTools.execute('chat_wait', {
    chat_id: question.chatId, execution_id: requests.q.executionId, timeout_ms: 120000,
  }, { caller });
  assert.equal(wait.state, 'blocked');
  assert.equal(wait.requests[0].requestId, requests.q.requestId);
  assert.equal(f.repository.getActivity(question.chatId).agentExecution.status, 'waiting_for_input');
  assert.equal(f.repository.getActivity(approval.chatId).agentExecution.status, 'waiting_for_approval');
  assert.equal(f.repository.readTranscript(approval.chatId).messages.some(row => row.role === 'tool' && row.tool_call_id === 'child-write'), false);
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
  const approvalInput = { clientRequestId: 'allow-write', answer: 'allow_once' };
  const answeredApproval = await f.request(`/api/chats/${approval.chatId}/requests/${requests.a.requestId}/respond`, approvalInput);
  assert.equal(answeredApproval.status, 200, JSON.stringify(answeredApproval.body));
  await until(() => assignments.every(row => f.runtime.taskDelivery.tasks.getResult(row.runId)), 'both immutable task results', 20000)
    .catch(withWorkflowState);
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
  assert.equal(f.repository.readTranscript(approval.chatId).messages.filter(row => row.role === 'tool' && row.tool_call_id === 'child-write').length, 1);
  assert.equal(await fs.readFile(path.join(f.workspace, 'evidence.txt'), 'utf8'), 'Canonical evidence from the actual file tool.');
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

test('a plan in the source checkout builds through a managed factory builder and reviewer and ends with launch instructions', { timeout: 75000 }, async t => {
  const config = { enabled: true, types: { generalPurpose: { enabled: true } } };
  const plan = 'documentation/plans/demo.md';
  const calls = [];
  const builderGate = deferred();
  t.after(() => builderGate.resolve());
  const f = await environment.fixture(t, { chats: { 'factory-family': {} }, subAgentTypes: config,
    toolNames: ['execute_command', 'spawn_sub_agent', 'read_file'],
    loadSkill: async id => (await import('../../server/skills/scan.js')).getSkillById(process.cwd(), id),
    async install(runtime, adapters) {
      const cwd = adapters.workspace;
      const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true });
      git('init', '-b', 'main');
      // The provider fixture uses real tools in the thread worktree for each stage.
      await fs.writeFile(path.join(cwd, 'fixture.cjs'), [
        "const fs = require('node:fs'), { execFileSync } = require('node:child_process');",
        "const step = process.argv[2];",
        "if (step === 'implement') { fs.writeFileSync('app.txt', 'works'); process.exit(0); }",
        "if (step === 'check') { process.exit(fs.existsSync('app.txt') ? 0 : 1); }",
        "const check = 'node fixture.cjs check';",
        "fs.mkdirSync('factory', { recursive: true });",
        "fs.writeFileSync('factory/spec.md', 'Deliver the demo app.');",
        "const feature = { id: 'F1', title: 'Build demo', passes: step !== 'contract', checks: [check] };",
        "fs.writeFileSync('factory/factory.json', JSON.stringify({ gates: [check], full: [check] }));",
        "fs.writeFileSync('factory/progress.json', JSON.stringify({ features: [feature], reviews: step === 'review' ? [{ afterFeature: 'F1' }] : [] }));",
        "if (step === 'review') fs.writeFileSync('factory/REPORT.md', '## How to run\\nRead app.txt\\n## Next steps\\nMerge the branch.');",
        "execFileSync('git', ['add', '.']);",
        "execFileSync('git', ['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','factory: ' + step]);",
      ].join('\n'));
      git('add', 'fixture.cjs');
      git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','Initial project');
      await fs.mkdir(path.join(cwd, 'documentation/plans'), { recursive: true });
      await fs.writeFile(path.join(cwd, plan), 'Untracked plan: deliver the demo app.');
      return installFamily(runtime, adapters, config);
    },
    async respond(body) {
      const input = lastUser(body);
      const shell = step => [tool('execute_command', { command: 'node fixture.cjs ' + step }, step)];
      if (input.includes('Implement only feature')) {
        await builderGate.promise;
        if (body.messages.at(-1).role !== 'tool') return shell('implement');
        return [tool('report_outcome', { outcome: 'pass', summary: 'Wrote app.txt', evidence: ['app.txt'] }, 'builder-result')];
      }
      if (input.includes('Review the committed changes')) {
        return [tool('report_outcome', { outcome: 'pass', summary: 'No blockers', evidence: ['app.txt'] }, 'review-result')];
      }
      if (input.includes('assigned builder result')) {
        calls.push('build');
        if (calls.filter(stage => stage === 'build').length === 1) return 'Builder finished; checkpoint was not committed.';
        return shell('feature');
      }
      if (input.includes('assigned reviewer result')) { calls.push('review'); return shell('review'); }
      if (input.includes('Verify the completed factory contract')) { calls.push('verify'); return 'Reviewed the delivery.\nYES'; }
      assert.match(JSON.stringify(body.messages), /Untracked plan: deliver the demo app/);
      calls.push('setup'); return shell('contract');
    },
  });
  f.settings.meta.toolSecurity.permissionLevel = 'full';
  const accepted = await f.request('/api/chats/factory-family/commands', { action: 'send', text: plan, clientRequestId: 'start-build',
    intent: { version: 1, goalDriven: true, skill: { id: 'factory', source: 'slash', input: plan } } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const get = () => f.repository.getChat('factory-family');
  const publishedTools = [];
  const projectId = f.repository.getCommand(accepted.body.receipt.commandId).captured.projectId;
  const unsubscribe = f.runtime.presentation.subscribe({ projectId, chatId: 'factory-family',
    send: event => { for (const msg of event.frame?.history?.messages ?? []) publishedTools.push(...(msg.factoryTools ?? [])); } });
  try {
    const pending = await until(() => publishedTools.find(tool => tool.name === 'spawn_sub_agent'), 'live builder call before its result', 20000);
    assert.equal(pending.args.title, 'Builder · F1');
    assert.equal(pending.result, undefined);
  } finally { unsubscribe(); builderGate.resolve(); }
  const deadline = Date.now() + 52000;
  while (Date.now() < deadline && !get().activeGoal?.achieved && !get().activeGoal?.paused) await new Promise(r => setTimeout(r, 70));
  assert.ok(get().activeGoal?.achieved, JSON.stringify({ run: get().factoryRun, calls, receipts: f.db.prepare('SELECT tool_name,result_json FROM chat_tool_invocations').all().map(r => [r.tool_name,r.result_json?.slice(-350)]) }));
  assert.deepEqual(calls, ['setup', 'build', 'build', 'review', 'verify']);
  const children = f.repository.listCommands().filter(r => r.runId && r.command.provenance.sourceChatId === 'factory-family');
  assert.equal(children.length, 2, 'An unfinished parent checkpoint reuses the completed child');
  const history = f.repository.readTranscript('factory-family').messages;
  assert.ok(history.every(message => !message.factoryTools), 'display data stays out of the model transcript');
  const activity = withFactoryActivity(f.db, 'factory-family', history).flatMap(message => message.factoryTools ?? []);
  const assignments = activity.filter(tool => tool.name === 'spawn_sub_agent');
  assert.deepEqual(assignments.map(tool => tool.args.title), ['Builder · F1', 'Reviewer · F1']);
  assert.deepEqual(new Set(assignments.map(tool => JSON.parse(tool.result).runId)), new Set(children.map(row => row.runId)));
  const checks = activity.filter(tool => tool.name === 'execute_command');
  assert.ok(checks.length >= 2 && checks.every(tool => tool.result.startsWith('node fixture.cjs check (exit 0)')));
  assert.equal(new Set(activity.map(tool => tool.id)).size, activity.length);
  assert.equal(f.repository.listCommands({ chatId: 'factory-family' }).filter(row => row.command.provenance.source === 'task_delivery').length, 0);
  assert.ok(children.every(r => path.resolve(f.repository.getChat(r.chatId).worktreeRoot).toLowerCase() === path.resolve(get().worktreeRoot).toLowerCase()));
  assert.equal(children.find(r => r.command.message.startsWith('Review')).captured.policy.turnClamp, 'read-only');
  assert.equal(await fs.readFile(path.join(get().worktreeRoot, 'app.txt'), 'utf8'), 'works');
  assert.equal(await fs.stat(path.join(get().workspacePath, 'app.txt')).catch(() => null), null);
  assert.match(f.repository.readTranscript('factory-family').messages.at(-1).content, /How to run[\s\S]*Next steps/);
});
