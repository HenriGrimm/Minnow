/**
 * Offline review reproductions. Run from repository root:
 * node --import tsx --import ./test/test-loader.mjs documentation/reviews/2026-10-23/evidence/chat-context-and-plan-repro.mts
 *
 * No server, provider, real workspace, credentials or profile is read/written.
 * Network requests are stubbed before loading application modules. Forced exit
 * disposes application-owned polling timers after the assertions have finished.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import '../../../../test/tools/install-dom-before-imports.mts';

globalThis.fetch = async () => new Response('{}', { status: 200 });

const { executeTool } = await import('../../../../src/tools/client.ts');
const { setSubAgentExecutorContext } = await import('../../../../src/tools/sub-agent-executor-context.ts');
const { setToolConfigForTests, defaultToolConfig } = await import('../../../../src/tools/config.ts');
const { createEmptyChatObject, setSessionStateForTests } = await import('../../../../src/state/sessions.ts');
const { blockPlanModeWrite: serverPlanGuard } = await import('../../../../server/tools/plan-write-guard.js');
const { blockPlanModeWrite: clientPlanGuard } = await import('../../../../src/chat/modes/plan-write-guard.ts');
const { enqueueComposerMessage, pushQueuedMessageNow } = await import('../../../../src/chat/message-queue.ts');
const { consumePendingSteer } = await import('../../../../src/chat/steer-message.ts');
const { setStreaming } = await import('../../../../src/app-state.ts');

setToolConfigForTests(defaultToolConfig());
const chats = ['a', 'b'].map(id => Object.assign(createEmptyChatObject('m'), {
  id,
  subAgentRuns: [{ runId: `run-${id}`, type: 'explore', task: `Task for ${id}`, status: 'completed', toolTurns: 1 }],
}));
setSessionStateForTests({ version: 3, activeId: 'a', sidebarCollapsed: false, chats });

// This is the real executeTool path, including its asynchronous config and
// dispatch gates. benchmarkAutonomous skips the modal, not those await points.
setSubAgentExecutorContext({ parentChatId: 'a', parentTurnId: 'turn-a', modeId: 'build' });
const pendingA = executeTool('list_sub_agents', {}, { chatId: 'a', benchmarkAutonomous: true });
setSubAgentExecutorContext({ parentChatId: 'b', parentTurnId: 'turn-b', modeId: 'build' });
const pendingB = executeTool('list_sub_agents', {}, { chatId: 'b', benchmarkAutonomous: true });
const results = await Promise.all([pendingA, pendingB]);
const requestA = JSON.parse(results[0].content).runs.map((run: { runId: string }) => run.runId);
const requestB = JSON.parse(results[1].content).runs.map((run: { runId: string }) => run.runId);
assert.deepEqual(requestA, ['run-b']); // Defect: must be run-a.
assert.deepEqual(requestB, ['run-b']);
console.log(JSON.stringify({ concurrentSubAgentLookup: { requestA, requestB } }));

const attemptedPath = 'documentation/plans/../../README.md';
const serverDecision = serverPlanGuard('plan', 'save_file', { path: attemptedPath });
const clientDecision = clientPlanGuard('plan', 'save_file', { path: attemptedPath });
assert.equal(serverDecision, null);
assert.equal(clientDecision, null);
assert.equal(path.posix.normalize(attemptedPath), 'README.md');
console.log(JSON.stringify({ planTraversal: { attemptedPath, normalizedDestination: path.posix.normalize(attemptedPath), clientDecision, serverDecision } }));

// Two visible queue entries are independently promoted before the next round.
const chat = chats[0];
enqueueComposerMessage(chat, 'Preserve existing data');
enqueueComposerMessage(chat, 'Add export support');
const [first, second] = chat.pendingMessageQueue!;
setStreaming(true, chat.id);
assert.equal(pushQueuedMessageNow(chat, first.id), 'sent');
assert.equal(pushQueuedMessageNow(chat, second.id), 'sent');
const consumed = consumePendingSteer(chat, { renderDom: false });
assert.equal(consumed.content, 'Add export support');
assert.equal(chat.pendingMessageQueue, undefined);
assert.equal(chat.history.some(row => row.content === 'Preserve existing data'), false);
console.log(JSON.stringify({ lostSteer: { consumed: consumed.content, firstMessageRetained: false } }));

setStreaming(false);
setSubAgentExecutorContext(null);
setSessionStateForTests(null);
process.exit(0);
