import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setIssuesStateForTests, addIssue, setIssueLabelColor, collectIssues, deleteIssues } from '../../src/state/issues-store.ts';
import { closeIssueLabelPopovers } from '../../src/ui/issues-label-chip.ts';
import { closeContextMenu } from '../../src/ui/context-menu.ts';
import { getIssuesTaxonomySync, setIssuesTaxonomyForTests } from '../../src/state/issues-taxonomy-store.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { getForegroundAppId, launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createEmptyChatObject, sessionState } from '../../src/state/sessions.ts';

test('Home issue dock uses the main transcript and selects its composer context', async () => {
  const win = new Window(); installHappyDomGlobals(win);
  const originalSanitize = DOMPurify.sanitize;
  DOMPurify.sanitize = DOMPurify(win as unknown as globalThis.Window).sanitize;
  seedMinimalSession('keep-active'); setStorageModeForTests('localStorage');
  const linked = createEmptyChatObject('Issue chat');
  linked.history = [
    { role: 'user', content: 'Fix this issue' },
    { role: 'assistant', content: 'Inspecting the files.', tool_calls: [{ id: 'read-file', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', tool_call_id: 'read-file', content: 'File contents' },
    { role: 'assistant', content: 'The fix is complete.' },
  ];
  sessionState!.chats.push(linked);
  setIssuesStateForTests({ version: 2, issues: [] } as Parameters<typeof setIssuesStateForTests>[0]);
  const issue = addIssue({ title: 'Renderer regression', description: '**Context**\n\n- Preserve the chat.' });
  issue.agent = { agentId: 'builder', phase: 'completed', startedAt: 1, updatedAt: 1, chatId: linked.id };
  document.body.innerHTML = '<div id="chatArea"><p>Keep this conversation</p></div><div id="dock"></div>';
  localStorage.setItem('minnow.chatView', 'compact');
  const code = document.querySelector('#chatArea p');
  const { mountIssueDock } = await import('../../src/home/flow-dock.ts');
  const dock = mountIssueDock(document.getElementById('dock')!, { issue, issues: [issue], workspace: '/repo', modelLabel: 'Default', start() {}, select() {}, addToChat() {} });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    dock.update();
    assert.equal(document.getElementById('home-tab-runs'), null);
    assert.equal(document.querySelector('.home-issue-brief'), null);
    assert.equal(document.getElementById('home-view-details')!.hidden, true);
    const work = document.querySelector<HTMLButtonElement>('.shared-chat-host__transcript .chat-work')!;
    assert.ok(work, 'shared work disclosure is rendered');
    assert.equal(work.getAttribute('aria-expanded'), 'false');
    assert.match(document.querySelector('.shared-chat-host__transcript .chat-turn-final')!.textContent!, /The fix is complete/);
    work.click();
    assert.equal(work.getAttribute('aria-expanded'), 'true');
    linked.history.push({ role: 'user', content: 'Thanks' }); dock.update();
    assert.equal(document.querySelector('.shared-chat-host__transcript .chat-work')!.getAttribute('aria-expanded'), 'true');
    assert.equal(sessionState!.activeId, linked.id);
    assert.equal(document.querySelector('#chatArea p'), code);
    const conversation = document.querySelector<HTMLElement>('.home-conversation')!;
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('.home-workspace-navigation > button')].some(button => /Hide conversation|Show conversation/.test(button.textContent!)), false);
    document.getElementById('home-tab-changes')!.click();
    assert.equal(conversation.hidden, true, 'Changes dedicates the workspace to the diff');
    document.getElementById('home-tab-details')!.click();
    assert.equal(conversation.hidden, true);
    const details = document.getElementById('home-view-details')!;
    assert.equal(details.hidden, false);
    assert.ok(details.querySelector('.issues-detail__doc'));
    assert.ok(details.querySelector('[aria-label="Issue properties"]'));
    assert.ok(details.querySelector('.issues-detail__talk'));
    assert.equal(details.querySelector('.issues-work-tabs'), null, 'Dashboard already supplies workspace tabs');
    const title = details.querySelector<HTMLTextAreaElement>('[aria-label="Issue title"]')!;
    assert.equal(title.value, issue.title);
    title.value = 'Updated from Dashboard'; title.dispatchEvent(new win.Event('change'));
    assert.equal(issue.title, 'Updated from Dashboard');
    details.querySelector<HTMLButtonElement>('.issues-detail__close')!.click();
    assert.equal(conversation.hidden, false);
    document.getElementById('home-tab-details')!.click();
    assert.ok(details.querySelector('.issues-detail'), 'Details can reopen after its close control');
    assert.equal(document.querySelector('.home-workspace--side-chat'), null);
    document.getElementById('home-tab-conversation')!.click();
    assert.equal(conversation.hidden, false);
    assert.match(conversation.textContent!, /The fix is complete/);
    const statusControl = document.querySelector<HTMLButtonElement>('.home-workspace-header .home-issue-status')!;
    statusControl.click();
    document.querySelector<HTMLButtonElement>('[role=menu] [data-id=done]')!.click();
    await Promise.resolve(); dock.update();
    assert.equal(issue.status, 'done');
    assert.match(statusControl.getAttribute('aria-label')!, /Done/);
    statusControl.click();
    document.querySelector<HTMLButtonElement>('[role=menu] [data-id=todo]')!.click();
    await Promise.resolve(); dock.update();
    assert.equal(issue.status, 'todo', 'completed issues can be reopened in the dock');
    assert.equal(issue.agent?.chatId, linked.id, 'status edits preserve the linked agent');
  } finally {
    closeContextMenu(); dock.dispose(); await new Promise(resolve => setTimeout(resolve, 30)); DOMPurify.sanitize = originalSanitize; setStorageModeForTests(null); setIssuesStateForTests(null); await teardownHappyDomAsync(win);
  }
});

const goals: string[] = [];
mock.module('../../src/home/plan-goal.ts', { namedExports: {
  planHomeGoal: async (goal: string) => {
    goals.push(goal);
    return [{ title: 'Build release view', description: 'Show releases for this project.', files: [] }];
  },
} });

test('Dashboard loads, offers an empty goal state, and keeps Code intact through issue capture and review', async () => {
  const win = new Window();
  const originalSanitize = DOMPurify.sanitize;
  DOMPurify.sanitize = DOMPurify(win as unknown as globalThis.Window).sanitize;
  const fetcher = async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/boards') ? [] : String(url).includes('/scheduler') ? { jobs: [] } : { ok: true, local: ['main'], jobs: [], boards: [] }), { headers: { 'Content-Type': 'application/json' } });
  installHappyDomGlobals(win, { fetch: fetcher as typeof fetch });
  const codeChat = seedMinimalSession('keep-active'); setStorageModeForTests('localStorage'); setLocalServerAvailableForTests(false);
  setWorkspaceFromServer({ path: '/repo', label: 'Project', userChosen: true } as Parameters<typeof setWorkspaceFromServer>[0]);
  document.body.innerHTML = '<div id="osAppsLayer"></div><div id="chatArea"><p>Keep this conversation</p></div>';
  setIssuesStateForTests(null);
  const transcript = document.querySelector('#chatArea p');
  const home = await import('../../src/ui/home-page.ts');
  try {
    launchInstance('home'); await home.openHome();
    assert.ok(document.querySelector('.home-flow-board'));
    assert.equal(document.querySelector('.home-empty-state'), null, 'loading is not an empty project');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(document.querySelectorAll('.home-flow-column').length, 0);
    assert.match(document.querySelector('.home-empty-state')!.textContent!, /What’s next for this project\?/);
    assert.ok(document.querySelector('.home-empty-state .home-goal-bar'));
    assert.equal(document.querySelectorAll('.home-goal-bar').length, 1);
    document.querySelector<HTMLButtonElement>('.home-empty-code')!.click();
    assert.equal(getForegroundAppId(), 'code');
    assert.equal(sessionState.activeId, codeChat.id);
    assert.equal(sessionState.chats.length, 1);
    assert.equal(sessionState.chats[0], codeChat);
    assert.equal(document.querySelector('#chatArea p'), transcript);
    launchInstance('home'); await home.openHome();
    await new Promise(resolve => setTimeout(resolve, 50));
    const input = document.querySelector<HTMLInputElement>('.home-goal-bar input')!;
    input.value = 'Fix the docking error'; input.dispatchEvent(new win.Event('input', { bubbles: true }));
    const capture = [...document.querySelectorAll<HTMLButtonElement>('.home-goal-bar button')].find(b => b.textContent === 'Add issue')!;
    capture.click(); await Promise.resolve();
    assert.equal(document.querySelector('.home-empty-state'), null);
    assert.equal(document.querySelector('.home-header .home-goal-bar input'), input, 'capture reuses the same form');
    assert.match(document.querySelector('[data-column=triage]')!.textContent!, /Fix the docking error/);
    const keyboard = addIssue({ title: 'Add keyboard navigation', type: 'bug', labels: ['accessibility', 'keyboard', 'desktop', 'polish'], workspacePath: '/repo', status: 'triage' });
    await Promise.resolve();
    assert.equal(document.querySelectorAll('.home-column-heading > .icon-svg').length, 5);
    const keyboardCard = () => document.querySelector<HTMLElement>(`[data-issue-id="${keyboard.id}"]`)!;
    assert.ok(keyboardCard().querySelector('.home-card-type.fi-sr-bug, .home-card-type .fi-sr-bug'));
    assert.equal(keyboardCard().querySelectorAll('.issues-label-chip').length, 3);
    const more = keyboardCard().querySelector<HTMLButtonElement>('[aria-label="1 more labels"]')!;
    assert.ok(more); more.click();
    assert.match(document.querySelector('[aria-label="More labels"]')!.textContent!, /polish/);
    assert.equal((document.querySelector('.home-selection-bar') as HTMLElement).hidden, true);
    setIssueLabelColor('keyboard', 'tide'); closeIssueLabelPopovers();
    await Promise.resolve(); await Promise.resolve();
    assert.equal([...keyboardCard().querySelectorAll<HTMLElement>('.issues-label-chip')].find(chip => chip.textContent === 'keyboard')?.dataset.swatch, 'tide');
    const statusControl = keyboardCard().querySelector<HTMLButtonElement>('.home-issue-status')!;
    statusControl.click();
    assert.equal((document.querySelector('.home-dock-content') as HTMLElement).hidden, true, 'editing status does not open the dock');
    setIssueLabelColor('keyboard', 'fig'); await Promise.resolve(); await Promise.resolve();
    assert.equal(keyboardCard().querySelector('.home-issue-status'), statusControl, 'updates preserve the open menu anchor');
    document.querySelector<HTMLButtonElement>('[role=menu] [data-id=todo]')!.click();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(keyboard.status, 'todo');
    assert.ok(keyboard.triagedAt, 'changing status also accepts a triage issue');
    assert.equal(keyboardCard().closest('[data-column]')?.getAttribute('data-column'), 'ready');
    keyboardCard().querySelector<HTMLButtonElement>('.home-issue-status')!.click();
    document.querySelector<HTMLButtonElement>('[role=menu] [data-id=triage]')!.click();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(keyboardCard().closest('[data-column]')?.getAttribute('data-column'), 'triage');
    const selectAll = document.querySelector<HTMLButtonElement>('[data-column=triage] .home-column-heading button')!;
    selectAll.click();
    assert.match(document.querySelector('.home-selection-bar')!.textContent!, /2 selected/);
    document.querySelector('.home-page')!.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal((document.querySelector('.home-selection-bar') as HTMLElement).hidden, true);
    document.querySelector<HTMLElement>('.home-flow-card')!.click();
    assert.equal(document.querySelector('.home-dock-content')!.getAttribute('aria-labelledby'), 'home-dock-title');
    assert.ok(document.querySelector('[aria-label="Instructions before starting"]'));
    const draft = document.querySelector<HTMLTextAreaElement>('[aria-label="Instructions before starting"]')!;
    draft.value = 'Keep keyboard activation working'; draft.dispatchEvent(new win.Event('input', { bubbles: true }));
    const conversationTab = document.getElementById('home-tab-conversation')!;
    document.getElementById('home-tab-changes')!.click(); conversationTab.click();
    assert.equal(document.querySelector('[aria-label="Instructions before starting"]'), draft);
    assert.equal(draft.value, 'Keep keyboard activation working');
    conversationTab.click();
    assert.equal((document.querySelector('.home-dock-content') as HTMLElement).hidden, false, 'active tabs do not collapse details');
    document.querySelector<HTMLButtonElement>('[aria-label="Collapse details"]')!.click();
    document.querySelector<HTMLButtonElement>('.home-dock-collapsed button')!.click();
    assert.equal(document.querySelector('[aria-label="Instructions before starting"]'), draft, 'collapse keeps the mounted conversation');
    assert.equal(draft.value, 'Keep keyboard activation working');
    assert.equal(document.querySelector('#chatArea p'), transcript);
    assert.equal(document.querySelectorAll('[role=tablist] > button:not([role=tab])').length, 0);
    addIssue({ title: 'Completed work', workspacePath: '/repo', status: 'done' }); await Promise.resolve();
    assert.match(document.querySelector('[data-column=done]')!.textContent!, /Done today · 1/);
    document.querySelector<HTMLButtonElement>('.home-done-toggle')!.click();
    assert.match(document.querySelector('[data-column=done]')!.textContent!, /Completed work/);
    deleteIssues(collectIssues({ workspacePath: '/repo', scope: 'current_workspace', hideDone: false }).map(issue => issue.id));
    await Promise.resolve();
    assert.ok(document.querySelector('.home-empty-state'));
    assert.equal(document.querySelector('.home-empty-state input'), input);
    input.value = 'Build a release view'; input.dispatchEvent(new win.Event('input', { bubbles: true }));
    [...document.querySelectorAll<HTMLButtonElement>('.home-goal-bar button')].find(b => b.textContent === 'Plan a goal')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(goals, ['Build a release view']);
    assert.match(document.querySelector('.home-empty-drafts')!.textContent!, /Build release view/);
    assert.equal(document.querySelectorAll('.home-flow-column').length, 0, 'drafts stay in the empty state until accepted');
    assert.equal(input.value, 'Build a release view');
    [...document.querySelectorAll<HTMLButtonElement>('.home-draft-actions button')].find(b => b.textContent === 'Add to Ready')!.click();
    await Promise.resolve();
    assert.equal(document.querySelector('.home-empty-state'), null);
    assert.match(document.querySelector('[data-column=ready]')!.textContent!, /Build release view/);
    assert.equal(sessionState.activeId, codeChat.id);
    assert.equal(sessionState.chats.length, 1);
  } finally {
    DOMPurify.sanitize = originalSanitize;
    launchInstance('code'); resetInstancesForTests(); setStorageModeForTests(null); setIssuesStateForTests(null);
    await teardownHappyDomAsync(win);
  }
});

test('Dashboard status menu uses custom taxonomy and edits only the chosen issue', async () => {
  const win = new Window(); installHappyDomGlobals(win);
  seedMinimalSession('status-test'); setStorageModeForTests('localStorage');
  const taxonomy = getIssuesTaxonomySync();
  setIssuesTaxonomyForTests({ ...taxonomy, statuses: taxonomy.statuses.map(status => ({ ...status, id: `custom_${status.id}`, label: `Custom ${status.label}` })) });
  setIssuesStateForTests({ version: 2, issues: [] } as Parameters<typeof setIssuesStateForTests>[0]);
  const first = addIssue({ title: 'First', status: 'custom_triage' });
  const second = addIssue({ title: 'Second', status: 'custom_triage' });
  const { createHomeIssueStatus } = await import('../../src/home/issue-status.ts');
  const control = createHomeIssueStatus(second); document.body.append(control);
  try {
    control.click();
    assert.ok(document.querySelector('[role=menu] [data-id=custom_done]'));
    document.querySelector<HTMLButtonElement>('[role=menu] [data-id=custom_todo]')!.click();
    await Promise.resolve();
    assert.equal(first.status, 'custom_triage');
    assert.equal(second.status, 'custom_todo');
    assert.match(control.textContent!, /Custom/);
  } finally {
    closeContextMenu(); setIssuesTaxonomyForTests(null); setIssuesStateForTests(null); setStorageModeForTests(null); await teardownHappyDomAsync(win);
  }
});
