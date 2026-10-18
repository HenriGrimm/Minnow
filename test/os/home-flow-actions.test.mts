import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setIssuesStateForTests, addIssue, updateIssue, findIssueById, updateIssueAgentRun } from '../../src/state/issues-store.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { setAutopilotMetaForTests } from '../../src/config/autopilot-meta.ts';
import { sendHomeIssues, reconcileHomeFlow } from '../../src/home/flow-actions.ts';

test('dispatch keeps a blocked batch together, reserves slots by chat, and recovers interrupted work', async () => {
  const win = new Window(); installHappyDomGlobals(win); seedMinimalSession('active');
  setStorageModeForTests('localStorage'); setAutopilotMetaForTests({ maxConcurrentTasks: 1 });
  setWorkspaceFromServer({ path: '/repo', label: 'Project', userChosen: true } as Parameters<typeof setWorkspaceFromServer>[0]);
  setIssuesStateForTests({ version: 2, issues: [] } as Parameters<typeof setIssuesStateForTests>[0]);
  try {
    const blocker = addIssue({ title: 'Shared foundation', workspacePath: '/repo', status: 'todo' });
    const a = addIssue({ title: 'First change', workspacePath: '/repo', status: 'todo' });
    const b = addIssue({ title: 'Second change', workspacePath: '/repo', status: 'todo' });
    for (const row of [a, b]) updateIssue(row.id, { issueRefs: [{ issueId: blocker.id, kind: 'blocked-by', addedAt: 1 }] });
    const ids = await sendHomeIssues([[a, b]], { modelId: 'test-model', mode: 'build', baseBranch: 'main' });
    assert.equal(ids.length, 2); assert.equal(a.agent?.home?.groupId, b.agent?.home?.groupId);
    assert.equal(findIssueById(a.id)?.agent?.home?.state, 'held'); assert.equal(findIssueById(b.id)?.agent?.home?.state, 'held'); assert.equal(findIssueById(a.id)?.agent?.chatId, undefined);
    updateIssue(blocker.id, { agent: { agentId: 'builder', phase: 'running', startedAt: 1, updatedAt: 1, chatId: 'busy-chat', home: { groupId: 'busy', state: 'working', mode: 'build', modelId: 'test-model', baseBranch: 'main' } } });
    const queued = addIssue({ title: 'Wait for capacity', workspacePath: '/repo', status: 'todo' });
    await sendHomeIssues([[queued]], { modelId: 'test-model', mode: 'build', baseBranch: 'main' });
    assert.equal(findIssueById(queued.id)?.agent?.home?.state, 'waitslot'); assert.equal(findIssueById(queued.id)?.agent?.chatId, undefined);
    reconcileHomeFlow();
    assert.equal(findIssueById(blocker.id)?.agent?.home?.state, 'paused');
    updateIssueAgentRun(queued.id, { home: { ...findIssueById(queued.id)!.agent!.home!, state: 'paused' } });
    const other = addIssue({ title: 'Other workspace', workspacePath: '/other', status: 'todo' });
    assert.deepEqual(await sendHomeIssues([[other]], { modelId: 'test-model', mode: 'build', baseBranch: 'main' }), []);
    assert.equal(other.agent, undefined);
  } finally { setIssuesStateForTests(null); setStorageModeForTests(null); await teardownHappyDomAsync(win); }
});
