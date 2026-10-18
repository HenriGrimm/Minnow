import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { addIssue, findIssueById, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
import { disposeChatRunActivity } from '../../src/state/chat-run-activity.ts';
import { parseHomeIssueRun } from '../../src/home/flow-run.ts';
import { flowColumn } from '../../src/home/flow-model.ts';
import { createDefaultIssuesTaxonomy } from '../../src/issues/taxonomy.ts';

let markdown = '', failLaunch = false;
const reads: URL[] = [], saves: any[] = [], launches: any[] = [], sends: any[] = [];
mock.module('../../src/ui/orchestrate-launch.ts', { namedExports: {
  launchBoardFromPlan: async (...args: any[]) => { launches.push(args); return failLaunch ? null : { boardId: 'issue-board' }; },
} });
mock.module('../../src/tools/client.ts', { namedExports: {
  executeTool: async (...args: any[]) => { saves.push(args); return { content: 'Saved plan' }; },
} });
mock.module('../../src/chat/messaging.ts', { namedExports: {
  sendProgrammaticChatText: async (...args: any[]) => { sends.push(args); },
} });
const { approveHomePlan, reconcileHomeFlow } = await import('../../src/home/flow-actions.ts');
let win: Window, chat: ReturnType<typeof seedMinimalSession>, rows: ReturnType<typeof addIssue>[];
const originalSanitize = DOMPurify.sanitize;
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

beforeEach(() => {
  win = new Window({ url: 'http://localhost/' });
  installHappyDomGlobals(win, { fetch: (async input => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.startsWith('/api/preview/file/')) { reads.push(url); return new Response(markdown); }
    return Response.json({ ok: true, runs: [], agents: [] });
  }) as typeof fetch });
  DOMPurify.sanitize = DOMPurify(win as any).sanitize;
  chat = seedMinimalSession('planner'); chat.modeId = 'plan'; chat.modelId = 'chosen-model'; chat.providerId = 'chosen-provider'; chat.worktreeRoot = '/repo/.worktrees/planner';
  setStorageModeForTests('localStorage');
  setWorkspaceFromServer({ path: '/repo', label: 'Project', userChosen: true } as any);
  setIssuesStateForTests({ version: 2, issues: [] } as any);
  rows = ['First issue', 'Second issue'].map(title => addIssue({ title, workspacePath: '/repo', status: 'planned' }));
  for (const issue of rows) updateIssue(issue.id, { planPath: 'documentation/plans/issues/shared.md', agent: { agentId: 'builder', phase: 'review', chatId: chat.id, startedAt: 1, updatedAt: 2, home: { groupId: 'batch', mode: 'plan', state: 'planned', modelId: chat.modelId, baseBranch: 'release' } } });
  markdown = '---\nplanType: build\n---\n# Sequential plan'; failLaunch = false;
  reads.length = saves.length = launches.length = sends.length = 0;
});
afterEach(async () => { DOMPurify.sanitize = originalSanitize; disposeChatRunActivity(); setIssuesStateForTests(null); setStorageModeForTests(null); await teardownHappyDomAsync(win); });

test('Build approval continues the planning chat and never creates a board', async () => {
  await approveHomePlan(findIssueById(rows[0].id)!);
  assert.equal(reads[0].searchParams.get('workspaceRoot'), chat.worktreeRoot);
  assert.equal(chat.modeId, 'build');
  assert.match(sends[0][1], /documentation\/plans\/issues\/shared.md/);
  assert.equal(launches.length, 0); assert.equal(saves.length, 0);
  for (const row of rows) assert.equal(findIssueById(row.id)?.agent?.home?.mode, 'build');
});

test('Orchestrate approval publishes the worktree plan and opens a board for the whole batch', async () => {
  markdown = '---\nname: Board plan\n---\n# Legacy Orchestrate plan';
  await approveHomePlan(findIssueById(rows[0].id)!);
  assert.equal(chat.modeId, 'plan'); assert.equal(sends.length, 0);
  assert.deepEqual(saves[0], ['save_file', { path: 'documentation/plans/issues/shared.md', content: markdown }, { workspaceRoot: '/repo', modeId: 'plan' }]);
  assert.deepEqual(launches[0], ['documentation/plans/issues/shared.md', { baseBranch: 'release', providerId: 'chosen-provider', id: 'chosen-model' }]);
  for (const row of rows) {
    const issue = findIssueById(row.id)!;
    assert.equal(issue.agent?.home?.boardId, 'issue-board');
    assert.equal(parseHomeIssueRun(issue.agent?.home)?.boardId, 'issue-board');
    assert.equal(flowColumn(issue, createDefaultIssuesTaxonomy()), 'progress');
  }
  chat.runs = [{ runId: 'plan', branchId: 'main', forkHistoryIndex: 0, status: 'completed', createdAt: 1, endedAt: 2 }];
  reconcileHomeFlow();
  assert.equal(findIssueById(rows[0].id)?.status, 'in_progress');
});

test('invalid types and failed board creation preserve the planned batch for recovery', async () => {
  markdown = '---\nplanType: unknown\n---\n# Invalid';
  await assert.rejects(approveHomePlan(findIssueById(rows[0].id)!), /invalid planType/);
  assert.equal(launches.length, 0); assert.equal(sends.length, 0);
  markdown = '---\nplanType: orchestrate\n---\n# Board'; failLaunch = true;
  await assert.rejects(approveHomePlan(findIssueById(rows[0].id)!), /Could not create/);
  assert.equal(chat.modeId, 'plan');
  for (const row of rows) { assert.equal(findIssueById(row.id)?.agent?.home?.state, 'planned'); assert.equal(findIssueById(row.id)?.agent?.home?.boardId, undefined); }
});

test('Dashboard approval follows the saved type, including revisions, and invokes the board action', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const { mountIssueDock } = await import('../../src/home/flow-dock.ts');
  const dock = mountIssueDock(host, { issue: findIssueById(rows[0].id)!, issues: rows, workspace: '/repo', modelLabel: 'Chosen', start() {}, select() {}, addToChat() {} });
  try {
    await flush();
    const primary = host.querySelector<HTMLButtonElement>('[data-approve]')!;
    assert.equal(primary.textContent, 'Approve plan & build'); assert.equal(primary.disabled, false);
    markdown = '---\nplanType: orchestrate\n---\n# Revised board plan';
    const issue = findIssueById(rows[0].id)!;
    updateIssue(issue.id, { agent: { ...issue.agent!, updatedAt: 3 } });
    dock.update(); assert.equal(primary.disabled, true);
    await flush();
    assert.equal(primary.textContent, 'Orchestrate'); assert.equal(primary.disabled, false);
    primary.click(); await flush();
    assert.equal(launches.length, 1); assert.equal(sends.length, 0);
    assert.equal(primary.textContent, 'Open orchestrator board');
  } finally { dock.dispose(); }
});
