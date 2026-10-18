import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setIssuesStateForTests, addIssue, updateIssue, findIssueById } from '../../src/state/issues-store.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';
import { flowColumn, stateLabel } from '../../src/home/flow-model.ts';
import { parseHomeIssueRun } from '../../src/home/flow-run.ts';
import { disposeChatRunActivity } from '../../src/state/chat-run-activity.ts';
import { replyHomeIssue, reconcileHomeFlow, pauseHomeIssue, approveHomeIssue } from '../../src/home/flow-actions.ts';

let duringTurn: () => void = () => {};
mock.module('../../src/chat/messaging.ts', { namedExports: {
  sendProgrammaticChatText: async () => { duringTurn(); },
} });

test('completed plans return the whole batch to Ready, survive reload, and can start building', async () => {
  const win = new Window(); installHappyDomGlobals(win);
  const chat = seedMinimalSession('planning'); chat.modeId = 'plan';
  setStorageModeForTests('localStorage');
  setWorkspaceFromServer({ path: '/repo', label: 'Project', userChosen: true } as Parameters<typeof setWorkspaceFromServer>[0]);
  setIssuesStateForTests({ version: 2, issues: [] } as Parameters<typeof setIssuesStateForTests>[0]);
  const taxonomy = createDefaultIssuesTaxonomy();
  try {
    const rows = ['First', 'Second'].map(title => addIssue({ title, workspacePath: '/repo', status: 'in_progress' }));
    for (const row of rows) updateIssue(row.id, { agent: { agentId: 'builder', phase: 'running', startedAt: 1, updatedAt: 1, chatId: chat.id, home: { groupId: 'plan-batch', state: 'working', mode: 'plan', modelId: 'test-model', baseBranch: 'main' } } });
    duringTurn = () => {
      chat.history = [
        { role: 'assistant', content: null, tool_calls: [{ id: 'save-plan', type: 'function', function: { name: 'save_file', arguments: JSON.stringify({ path: 'documentation/plans/shared-plan.md' }) } }] },
        { role: 'tool', tool_call_id: 'save-plan', content: 'Saved documentation/plans/shared-plan.md (50 bytes)' },
      ];
      reconcileHomeFlow();
      assert.equal(findIssueById(rows[0].id)?.agent?.home?.state, 'working', 'a finishing turn is not an interrupted run');
    };
    await replyHomeIssue(findIssueById(rows[0].id)!, 'Finish the plan');
    for (const source of rows) {
      const row = findIssueById(source.id)!;
      assert.equal(row.status, 'planned');
      assert.equal(row.planPath, 'documentation/plans/shared-plan.md');
      assert.equal(flowColumn(row, taxonomy), 'ready');
      assert.equal(stateLabel(row.agent?.home?.state), 'Planned');
      assert.equal(parseHomeIssueRun(row.agent?.home)?.state, 'planned');
    }
    chat.runs = [{ runId: 'plan-run', branchId: 'main', forkHistoryIndex: 0, status: 'completed', createdAt: 1, endedAt: 2 }];
    for (const source of rows) {
      const row = findIssueById(source.id)!;
      updateIssue(row.id, { status: 'in_progress', agent: { ...row.agent!, home: { ...row.agent!.home!, state: 'paused' } } });
    }
    reconcileHomeFlow();
    assert.equal(findIssueById(rows[0].id)?.agent?.home?.state, 'planned', 'persisted successful plans recover from the old paused state');
    chat.runs = [];
    await approveHomeIssue(findIssueById(rows[0].id)!);
    assert.equal(findIssueById(rows[0].id)?.agent?.home?.state, 'planned', 'plan approval cannot merge');
    await replyHomeIssue(findIssueById(rows[0].id)!, 'Build the plan', true);
    for (const source of rows) {
      const row = findIssueById(source.id)!;
      assert.equal(row.agent?.home?.mode, 'build');
      assert.equal(row.agent?.home?.state, 'ready');
      assert.equal(flowColumn(row, taxonomy), 'review');
    }
    chat.modeId = 'plan';
    duringTurn = () => pauseHomeIssue(rows[0]);
    await replyHomeIssue(findIssueById(rows[0].id)!, 'Revise the plan');
    assert.equal(findIssueById(rows[0].id)?.agent?.home?.state, 'paused', 'explicit pauses stay paused');
  } finally {
    duringTurn = () => {};
    disposeChatRunActivity();
    setIssuesStateForTests(null); setStorageModeForTests(null); await teardownHappyDomAsync(win);
  }
});
