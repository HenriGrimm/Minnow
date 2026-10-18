import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { setIssuesStateForTests, addIssue, setIssueLabelColor } from '../../src/state/issues-store.ts';
import { closeIssueLabelPopovers } from '../../src/ui/issues-label-chip.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createEmptyChatObject, sessionState } from '../../src/state/sessions.ts';

test('Home issue dock uses the collapsed shared transcript without changing Code chat', async () => {
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
  const issue = addIssue({ title: 'Renderer regression' });
  issue.agent = { agentId: 'builder', phase: 'completed', startedAt: 1, updatedAt: 1, chatId: linked.id };
  document.body.innerHTML = '<div id="chatArea"><p>Keep this conversation</p></div><div id="dock"></div>';
  const code = document.querySelector('#chatArea p');
  const { mountIssueDock } = await import('../../src/home/flow-dock.ts');
  const dock = mountIssueDock(document.getElementById('dock')!, { issue, issues: [issue], workspace: '/repo', modelLabel: 'Default', start() {}, select() {}, addToChat() {} });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    dock.update();
    const work = document.querySelector<HTMLButtonElement>('.home-chat-transcript .chat-work')!;
    assert.ok(work, 'shared work disclosure is rendered');
    assert.equal(work.getAttribute('aria-expanded'), 'false');
    assert.match(document.querySelector('.home-chat-transcript .chat-turn-final')!.textContent!, /The fix is complete/);
    work.click();
    assert.equal(work.getAttribute('aria-expanded'), 'true');
    linked.history.push({ role: 'user', content: 'Thanks' }); dock.update();
    assert.equal(document.querySelector('.home-chat-transcript .chat-work')!.getAttribute('aria-expanded'), 'true');
    assert.equal(sessionState!.activeId, 'keep-active');
    assert.equal(document.querySelector('#chatArea p'), code);
  } finally {
    dock.dispose(); DOMPurify.sanitize = originalSanitize; setStorageModeForTests(null); setIssuesStateForTests(null); await teardownHappyDomAsync(win);
  }
});

test('Home mounts before issues load, captures real issues, selects a column and clears with Escape', async () => {
  const win = new Window();
  const fetcher = async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/boards') ? [] : String(url).includes('/scheduler') ? { jobs: [] } : { ok: true, local: ['main'], jobs: [], boards: [] }), { headers: { 'Content-Type': 'application/json' } });
  installHappyDomGlobals(win, { fetch: fetcher as typeof fetch });
  seedMinimalSession('keep-active'); setStorageModeForTests('localStorage'); setLocalServerAvailableForTests(false);
  setWorkspaceFromServer({ path: '/repo', label: 'Project', userChosen: true } as Parameters<typeof setWorkspaceFromServer>[0]);
  document.body.innerHTML = '<div id="osAppsLayer"></div><div id="chatArea"><p>Keep this conversation</p></div>';
  setIssuesStateForTests(null);
  const transcript = document.querySelector('#chatArea p');
  const home = await import('../../src/ui/home-page.ts');
  try {
    launchInstance('home'); await home.openHome();
    assert.ok(document.querySelector('.home-flow-board'));
    await new Promise(resolve => setTimeout(resolve, 50));
    const input = document.querySelector<HTMLInputElement>('.home-goal-bar input')!;
    input.value = 'Fix the docking error'; input.dispatchEvent(new win.Event('input', { bubbles: true }));
    const capture = [...document.querySelectorAll<HTMLButtonElement>('.home-goal-bar button')].find(b => b.textContent === 'Capture')!;
    capture.click(); await Promise.resolve();
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
  } finally {
    launchInstance('code'); resetInstancesForTests(); setStorageModeForTests(null); setIssuesStateForTests(null);
    await teardownHappyDomAsync(win);
  }
});
