import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createProductionRuntimeTestEnvironment } from './production-runtime-fixture.mjs';
import { captureChatProfile } from '../../server/chats/preparation.js';
import { installChatDelegation } from '../../server/chats/delegation.js';
import { createPersistentSubAgentEffector } from '../../server/chats/task-bridge.js';
import { createChatTranscriptStore } from '../../server/chats/transcript-store.js';
import { chatInputMessageId } from '../../server/chats/execution-host.js';
import { createEngine } from '../../server/orchestrator/engine.js';
import { createSubAgentGraph } from '../../server/sub-agents/graph.js';
import { makeEvent } from '../../server/sub-agents/events.js';
import * as journal from '../../server/sub-agents/journal.js';

let environment;
before(async () => { environment = await createProductionRuntimeTestEnvironment(); });
after(async () => { journal.resetJournalCache(); await environment?.dispose(); });
async function until(read, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Did not reach ' + label);
}

for (const alreadyAnswered of [false, true]) test(`startup reattaches the original question execution and journal attempt (${alreadyAnswered ? 'answer committed before crash' : 'answer after restart'})`, { timeout: 20000 }, async t => {
  const parentId = alreadyAnswered ? 'answered-parent' : 'question-parent';
  const childId = parentId + '-child', runId = parentId + '-task', executionId = parentId + '-execution', attemptId = parentId + '-attempt', commandId = parentId + '-command';
  const engines = new Map(), errors = [];
  let request, savedFence;
  const f = await environment.fixture(t, { chats: { [parentId]: {} }, toolNames: ['ask_question'],
    respond: body => body.messages.some(row => row.role === 'tool' && String(row.content).includes('Version two'))
      ? [{ id: 'recovered-report', type: 'function', function: { name: 'report_outcome', arguments: JSON.stringify({ outcome: 'pass', summary: 'Recovered answer was consumed.', evidence: ['Saved answer'] }) } }]
      : 'Parent resumed with the recovered result.',
    install: async (runtime, adapters) => {
      const repository = runtime.repository;
      const target = await runtime.context.resolveTarget(parentId);
      const childChatId = childId;
      const modelSelection = { providerId: adapters.providerId, modelId: 'model' };
      const shell = { id: childChatId, name: 'Question child', workspacePath: adapters.workspace, modeId: 'build', ...modelSelection };
      const snapshot = await captureChatProfile(shell, target.scope, { adapters: adapters.preparationAdapters,
        workspaceIds: target.currentPolicy.workspaceIds, modelSelection });
      const profile = { profileId: parentId + '-profile', profileVersion: 1, snapshot };
      const completionPolicy = { version: 1, kind: 'wake_delegator', recipientChatId: parentId,
        subscriptionId: parentId + '-subscription', cancellationEpoch: 0 };
      const command = { version: 1, commandId: commandId, chatId: childChatId, kind: 'send', mode: 'auto',
        message: 'Inspect the chosen version', requestedAt: 1000, modelSelection,
        provenance: { version: 1, actor: 'human', source: 'composer', kind: 'human_message' } };
      const captured = { runId, policy: snapshot.policy, scope: target.scope, projectId: target.scope.projectId,
        modelSelection, profileReference: { profileId: profile.profileId, profileVersion: 1 }, completionPolicy, cancellationEpoch: 0 };
      repository.createChild({ chat: shell, relation: { version: 1, childChatId, parentChatId: parentId, rootChatId: parentId,
        journalOwnerId: parentId, origin: 'delegated', createdAt: 1000 }, profile, projectId: target.scope.projectId,
        command, producerId: 'fixture-spawn', requestKey: runId, captured });
      savedFence = repository.claimExecution({ chatId: childChatId, executionId, commandId: command.commandId, runId, attemptId,
        ownerId: 'vanished-server', captured: { ...captured, taskOwned: true } });
      repository.updateCommand(command.commandId, { state: 'running', executionId, runId });
      repository.markExecutionActivated(executionId, { fence: savedFence });
      repository.appendMessage(childChatId, { role: 'user', content: command.message, commandId: command.commandId,
        provenance: command.provenance, createdAt: command.requestedAt }, { fence: savedFence, commandId: command.commandId, messageId: chatInputMessageId(command.commandId) });
      const store = createChatTranscriptStore({ repository, chatId: childChatId, fence: savedFence });
      store.append(childChatId, { role: 'assistant', content: '', tool_calls: [{ id: 'saved-question-call', type: 'function',
        function: { name: 'ask_question', arguments: JSON.stringify({ questions: [{ id: 'version', prompt: 'Which version?' }] }) } }] });
      request = runtime.requests.open({ chatId: childChatId, executionId, toolCallId: 'saved-question-call', kind: 'question',
        title: 'Choose version', presentation: { question: { questions: [{ id: 'version', prompt: 'Which version?' }] } }, fence: savedFence });
      if (alreadyAnswered) repository.respondToRequest(request.requestId, { answerCommandId: 'saved-answer', answer: 'Version two' });
      repository.updateExecution(executionId, { status: 'waiting_for_input' }, { fence: savedFence });
      await journal.appendEvent(parentId, makeEvent('run.requested', { runId, agentType: 'reviewer', task: command.message,
        parentChatId: parentId, cwd: adapters.workspace, requestedAt: 1000, childChatId, journalOwnerId: parentId,
        commandId: command.commandId, executionKind: 'chat', model: { providerId: adapters.providerId, id: 'model' }, completionPolicy }));
      await journal.appendEvent(parentId, makeEvent('attempt.started', { runId, attemptId, executionId, seed: { kind: 'initial' } }));
      async function getEngine(owner) {
        if (engines.has(owner)) return engines.get(owner);
        let engine;
        const effector = createPersistentSubAgentEffector({ legacyEffector: { inspect: () => [], onEnd() {}, async stop() {},
          async start() { throw new Error('Legacy runner must not start'); } }, repository, service: runtime.service,
          getState: () => engine.getState(), onSettled: input => runtime.taskDelivery.onSettled(input), onError: error => errors.push(error) });
        engine = createEngine({ boardId: owner, effector, graph: createSubAgentGraph(), journal, tickMs: 20 });
        engines.set(owner, engine); await engine.load(); return engine;
      }
      installChatDelegation(runtime, { getEngine, loadConfig: async () => ({ enabled: true, types: { reviewer: { enabled: true } } }) });
      return { async dispose() { for (const engine of engines.values()) engine.dispose(); } };
    } });
  if (!alreadyAnswered) {
    assert.equal(f.calls.length, 0, 'no inference before the saved question is answered');
    await until(() => f.runtime.requests.hasLiveWaiter(request.requestId), 'reattached question waiter');
    assert.equal(f.repository.getExecution(executionId).status, 'waiting_for_input');
    assert.ok(f.repository.getLease(childId).epoch > savedFence.epoch);
    const answer = await f.request(`/api/chats/${childId}/requests/${request.requestId}/respond`, { clientRequestId: 'after-restart-answer', answer: 'Version two' });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  }
  await until(() => f.repository.getCommand(commandId).state === 'settled', 'original task settlement');
  await until(() => f.repository.listCommands({ chatId: parentId }).some(row => row.state === 'settled'), 'one parent wake');
  const state = await journal.loadState(parentId), run = state.runs.get(runId);
  assert.equal(run.attempts.length, 1); assert.equal(run.attempts[0].attemptId, attemptId);
  assert.equal(run.attempts[0].executionId, executionId); assert.equal(run.phase, 'passed');
  const history = f.repository.readTranscript(childId).messages;
  assert.equal(history.filter(row => row.commandId === commandId).length, 1);
  assert.equal(history.filter(row => row.role === 'tool' && row.tool_call_id === 'saved-question-call').length, 1);
  assert.match(f.runtime.taskDelivery.tasks.getResult(runId).summary, /Recovered answer was consumed/);
  assert.equal(f.calls.filter(body => body.messages.some(row => row.role === 'tool' && row.tool_call_id === 'saved-question-call')).length, 1);
  assert.equal(f.repository.listCommands({ chatId: parentId }).length, 1);
  assert.deepEqual(errors, []);
  journal.resetJournalCache();
});
