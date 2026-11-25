import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { addIssue, findIssueById, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
import { disposeChatRunActivity } from '../../src/state/chat-run-activity.ts';

let markdown = '';
const reads: URL[] = [], saves: any[] = [], sends: any[] = [];
mock.module('../../src/tools/client.ts', { namedExports: {
  executeTool: async (...args: any[]) => { saves.push(args); return { content: 'Saved plan' }; },
} });
mock.module('../../src/chat/messaging.ts', { namedExports: {
  sendProgrammaticChatText: async (...args: any[]) => { sends.push(args); },
} });
const { approveHomePlan } = await import('../../src/home/flow-actions.ts');
let win: Window, chat: ReturnType<typeof seedMinimalSession>, rows: ReturnType<typeof addIssue>[];
const originalSanitize = DOMPurify.sanitize;

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
  markdown = '---\nplanType: build\n---\n# Sequential plan';
  reads.length = saves.length = sends.length = 0;
});
afterEach(async () => { DOMPurify.sanitize = originalSanitize; disposeChatRunActivity(); setIssuesStateForTests(null); setStorageModeForTests(null); await teardownHappyDomAsync(win); });

test('Build approval continues the planning chat and never creates a board', async () => {
  await approveHomePlan(findIssueById(rows[0].id)!);
  assert.equal(reads[0].searchParams.get('workspaceRoot'), chat.worktreeRoot);
  assert.equal(chat.modeId, 'build');
  assert.match(sends[0][1], /documentation\/plans\/issues\/shared.md/);
  assert.equal(saves.length, 0);
  for (const row of rows) assert.equal(findIssueById(row.id)?.agent?.home?.mode, 'build');
});

test('an older saved plan builds in the same planning chat', async () => {
  markdown = '# Legacy plan';
  await approveHomePlan(findIssueById(rows[0].id)!);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0].id, chat.id);
  for (const row of rows) assert.equal(findIssueById(row.id)?.agent?.home?.mode, 'build');
});

test('invalid types preserve the planned batch for recovery', async () => {
  markdown = '---\nplanType: unknown\n---\n# Invalid';
  await assert.rejects(approveHomePlan(findIssueById(rows[0].id)!), /invalid planType/);
  assert.equal(sends.length, 0);
  assert.equal(chat.modeId, 'plan');
  for (const row of rows) { assert.equal(findIssueById(row.id)?.agent?.home?.state, 'planned'); assert.equal(findIssueById(row.id)?.agent?.home?.boardId, undefined); }
});
