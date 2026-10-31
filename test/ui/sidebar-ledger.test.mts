/**
 * Ledger sidebar: git state on rows, Today / Older sections with "Archive N
 * finished", the Undo toast, archive search and bulk restore, and answering
 * agent requests from "Needs you".
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { renderSidebar, resetSidebarAgentNavigationForTests } from '../../src/ui/sidebar.ts';
import { chatGitState, describeChatGitState, resetSidebarGitStateForTests, syncChatGitState } from '../../src/ui/sidebar-git-state.ts';
import { resetSidebarNeedsYouForTests } from '../../src/ui/sidebar-needs-you.ts';
import { isChatArchived } from '../../src/state/chat-archive.ts';
import type { GitBranchTreeEntry } from '../../src/state/git-api.ts';
import type { PullRequestSummary } from '../../src/state/forge-api.ts';
import type { Chat } from '../../src/types.ts';

const WS = '/work/ledger';
let win: Window | undefined;
const originalFetch = globalThis.fetch;

function chat(id: string, lastMessageAt = 10, extra: Partial<Chat> = {}): Chat {
  const value = createEmptyChatObject('model', WS);
  Object.assign(value, { id, name: id, historyLoaded: false, messageCount: 1, lastMessageAt, updatedAt: lastMessageAt }, extra);
  return value;
}

function branch(name: string, extra: Partial<GitBranchTreeEntry> = {}): GitBranchTreeEntry {
  return { name, sha: 'abc', subject: '', date: '', parent: 'main', ahead: 0, behind: 0, merged: false, upstream: null,
    upstreamAhead: 0, upstreamBehind: 0, upstreamGone: false, worktree: false, ...extra };
}

function pr(headRef: string, state: string, extra: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return { number: 7, title: headRef, state, draft: false, author: 'me', headRef, baseRef: 'main', createdAt: '', updatedAt: '',
    additions: 0, deletions: 0, changedFiles: 0, url: '', reviewDecision: '', mergeable: '', labels: [], checks: 'none', checkCount: 0, ...extra };
}

function setup(chats: Chat[], fetchImpl: typeof fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch): HTMLElement {
  win = new Window({ url: 'http://localhost:9473/#/app/code/chat' });
  installHappyDomGlobals(win, { fetch: fetchImpl });
  document.body.innerHTML = '<div id="chatList"></div>';
  setWorkspaceFromServer({ path: WS, label: 'Ledger', isDefault: false });
  setSessionStateForTests({ ...defaultSessionState(), chats, activeId: chats[0]!.id });
  return document.getElementById('chatList')!;
}

const rowIds = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('.chat-item-row[data-chat-id]')].map(row => row.dataset.chatId);
const sections = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('.chat-list-section-head')].map(head => head.dataset.section);

afterEach(() => {
  resetSidebarAgentNavigationForTests(); resetSidebarGitStateForTests(); resetSidebarNeedsYouForTests();
  resetSessionPersistenceForTests(); setSessionStateForTests(null); resetWorkspaceStateForTests();
  globalThis.fetch = originalFetch; win?.close(); win = undefined;
});

test('git state: a PR outranks edits, unshipped edits outrank commits, and a fresh branch never reads as merged', () => {
  resetSidebarGitStateForTests({ cwd: WS, branches: [branch('feat/a', { ahead: 3, upstream: 'origin/feat/a', upstreamAhead: 2 }), branch('fresh', { merged: true })],
    prs: [pr('feat/pr', 'open', { checks: 'failure' }), pr('feat/done', 'merged')] });
  assert.equal(chatGitState(chat('a', 1, { codeChangeTotals: { additions: 5, deletions: 1 } }), WS).stage, 'uncommitted');
  const committed = chatGitState(chat('b', 1, { gitBranch: 'feat/a', codeChangeShipHandled: true, codeChangeTotals: { additions: 5, deletions: 0 } }), WS);
  assert.deepEqual([committed.stage, committed.unpushed], ['committed', 2]);
  const open = chatGitState(chat('c', 1, { gitBranch: 'feat/pr', worktreeRoot: '/trees/pr', codeChangeTotals: { additions: 9, deletions: 0 } }), WS);
  assert.deepEqual([open.stage, open.checks, open.worktree], ['pr-open', 'failure', true]);
  assert.equal(describeChatGitState(open), 'worktree, pull request open #7, checks failed');
  assert.equal(chatGitState(chat('d', 1, { gitBranch: 'feat/done' }), WS).stage, 'merged');
  assert.equal(chatGitState(chat('e', 1, { gitBranch: 'fresh' }), WS).stage, null);

  setup([chat('host')]);
  const host = document.createElement('span');
  syncChatGitState(host, open);
  assert.equal(host.children.length, 2, 'checks take the worktree slot: two marks at most');
  assert.equal(host.getAttribute('aria-label'), 'worktree, pull request open #7, checks failed');
});

test('Today and Older sections; finished work archives in one go and Undo brings it back', () => {
  const today = chat('today', Date.now());
  const merged = chat('merged', 10, { gitBranch: 'feat/done' });
  const closed = chat('closed', 9, { gitBranch: 'feat/closed' });
  const open = chat('open', 8, { gitBranch: 'feat/open' });
  const list = setup([today, merged, closed, open]);
  resetSidebarGitStateForTests({ cwd: WS, prs: [pr('feat/done', 'merged'), pr('feat/closed', 'closed'), pr('feat/open', 'open')] });
  renderSidebar();
  assert.deepEqual(sections(list), ['today', 'older']);
  assert.deepEqual(rowIds(list), ['today', 'merged', 'closed', 'open']);
  const action = list.querySelector<HTMLButtonElement>('[data-section="older"] .chat-list-section-action')!;
  assert.equal(action.textContent, 'Archive 2 finished');
  assert.equal(list.querySelector('[data-section="today"] .chat-list-section-action'), null);

  action.click();
  assert.equal(isChatArchived(merged), true); assert.equal(isChatArchived(closed), true);
  assert.deepEqual(rowIds(list), ['today', 'open']);
  const toast = document.getElementById('chatListToast')!;
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent!, /Archived 2 finished chats/);
  toast.querySelector<HTMLButtonElement>('.chat-list-toast__undo')!.click();
  assert.equal(isChatArchived(merged), false);
  assert.deepEqual(rowIds(list), ['today', 'merged', 'closed', 'open']);
  assert.equal(toast.hidden, true);
});

test('row archive button archives with Undo; the Archive view searches, groups and bulk-restores', () => {
  const recent = chat('recent', 10);
  const old = chat('old', 9, { archivedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 });
  const other = chat('other', 8, { archivedAt: Date.now() - 1000, name: 'Spike voice composer' });
  const list = setup([recent, old, other]);
  renderSidebar();
  list.querySelector<HTMLButtonElement>('[data-chat-id="recent"] .chat-item-archive')!.click();
  assert.equal(isChatArchived(recent), true);
  assert.match(document.getElementById('chatListToast')!.textContent!, /Archived “recent”/);

  document.querySelector<HTMLButtonElement>('#chatListViews [data-chat-view="archive"]')!.click();
  assert.deepEqual(sections(list), ['this week', 'earlier']);
  assert.deepEqual(rowIds(list), ['recent', 'other', 'old']);
  assert.equal(list.querySelector<HTMLElement>('[data-chat-id="old"] .chat-item-archive')!.textContent, 'Restore');

  const search = list.querySelector<HTMLInputElement>('#chatArchiveSearch')!;
  assert.equal(search.placeholder, 'Search 3 archived chats');
  search.value = 'voice'; search.dispatchEvent(new win!.Event('input'));
  assert.deepEqual(rowIds(list), ['other']);
  assert.equal(list.querySelector('#chatArchiveSearch'), search, 'the search box survives repaint');
  search.value = ''; search.dispatchEvent(new win!.Event('input'));

  const bar = list.querySelector<HTMLElement>('.chat-archive-bulk')!;
  assert.equal(bar.hidden, true);
  list.querySelector<HTMLButtonElement>('[data-chat-id="old"] .chat-item-select')!.click();
  list.querySelector<HTMLButtonElement>('[data-chat-id="other"] .chat-item-select')!.click();
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('.chat-archive-bulk__count')!.textContent, '2 selected');
  assert.ok(list.classList.contains('chat-list--selecting'));
  bar.querySelector<HTMLButtonElement>('.chat-archive-bulk__restore')!.click();
  assert.equal(isChatArchived(old), false); assert.equal(isChatArchived(other), false);
  assert.deepEqual(rowIds(list), ['recent']);
  assert.match(document.getElementById('chatListToast')!.textContent!, /Restored 2 chats to Working/);
});

test('Needs you answers a single-choice question from the sidebar and leaves a resuming receipt', async () => {
  const asking = chat('asking', 10, { chatCommandVersion: 1, agentRequestSummary: [{ requestId: 'q1', kind: 'question' }] });
  const request = { version: 1, requestId: 'q1', chatId: 'asking', executionId: 'e1', toolCallId: 'call', kind: 'question', state: 'pending',
    createdAt: Date.now() - 120_000, title: 'Cookie', presentation: { question: { questions: [{ id: 'keep', prompt: 'Keep the legacy cookie?',
      options: [{ id: 'yes', label: 'Keep for one release' }, { id: 'no', label: 'Remove it now' }] }] } } };
  let answered: unknown;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/requests/q1/respond')) {
      answered = JSON.parse(String(init!.body)).answer;
      return Response.json({ request: { ...request, state: 'answered', settledAt: Date.now(), answerCommandId: 'cmd' } });
    }
    if (url.includes('/api/chats/asking/requests')) return Response.json({ requests: [request], pendingCount: 1, nextCursor: null, truncated: false });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const list = setup([asking], fetchImpl);
  renderSidebar();
  const section = list.querySelector<HTMLElement>('#sidebarNeedsYou')!;
  assert.equal(section.hidden, false);
  assert.match(section.textContent!, /Loading/);
  await new Promise(resolve => setTimeout(resolve, 20));
  renderSidebar();
  const card = section.querySelector<HTMLElement>('.needs-you-card[data-request-id="q1"]')!;
  assert.match(card.textContent!, /Keep the legacy cookie\?/);
  assert.equal(card.querySelector('.needs-you-card__age')!.textContent, '2m');
  assert.equal(section.querySelector('.needs-you__count')!.textContent, '1');
  const input = card.querySelector<HTMLInputElement>('.needs-you-card__input')!;
  input.value = 'half-typed';
  renderSidebar();
  assert.equal(section.querySelector('.needs-you-card__input'), input, 'a reply being typed survives repaint');

  [...card.querySelectorAll<HTMLButtonElement>('.needs-you-card__option')].find(button => button.textContent === 'Remove it now')!.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  renderSidebar();
  assert.deepEqual(answered, { status: 'answered', answers: [{ questionId: 'keep', selectedIds: ['no'], otherText: null }] });
  assert.deepEqual(asking.agentRequestSummary, []);
  assert.equal(section.querySelector('.needs-you-card'), null);
  assert.match(section.querySelector('.needs-you-done')!.textContent!, /Answered: Remove it now.*resuming/);
});

test('header: the checked-out branch with push / pull counts and changed files', () => {
  const list = setup([chat('one')]);
  document.body.insertAdjacentHTML('afterbegin', '<button id="sidebarBranch" hidden><span class="chat-sidebar-branch__name"></span><span class="chat-sidebar-branch__sync"></span><span class="chat-sidebar-branch__changed"></span></button>');
  renderSidebar();
  const branch = document.getElementById('sidebarBranch')!;
  assert.equal(branch.hidden, true, 'hidden until git facts land');

  resetSidebarGitStateForTests({ cwd: WS, current: 'codex/persistent-agent-chats', ahead: 2, behind: 0, changed: 3 });
  renderSidebar();
  assert.equal(branch.hidden, false);
  assert.equal(branch.querySelector('.chat-sidebar-branch__name')!.textContent, 'codex/persistent-agent-chats');
  assert.equal(branch.querySelector('.chat-sidebar-branch__sync')!.textContent, '↑2');
  assert.equal(branch.querySelector('.chat-sidebar-branch__changed')!.textContent, '3 changed');
  assert.equal(branch.getAttribute('aria-label'), 'Branch codex/persistent-agent-chats, 2 commits to push, 3 changed files. Switch branch or worktree');

  resetSidebarGitStateForTests({ cwd: WS, current: 'main', ahead: 0, behind: 0, changed: 0 });
  renderSidebar();
  assert.equal(branch.querySelector('.chat-sidebar-branch__sync')!.textContent, '');
  assert.match(branch.getAttribute('aria-label')!, /Branch main, up to date\./);
  assert.ok(list);
});

test('header outside git: the Chats title holds the slot; inside git the branch replaces it', () => {
  setup([chat('one')]);
  document.body.insertAdjacentHTML('afterbegin', '<span id="sidebarTitle">Chats</span><button id="sidebarBranch" hidden><span class="chat-sidebar-branch__name"></span><span class="chat-sidebar-branch__sync"></span><span class="chat-sidebar-branch__changed"></span></button>');
  resetSidebarGitStateForTests({ cwd: WS });
  renderSidebar();
  assert.equal(document.getElementById('sidebarBranch')!.hidden, true);
  assert.equal(document.getElementById('sidebarTitle')!.hidden, false);
  resetSidebarGitStateForTests({ cwd: WS, current: 'main' });
  renderSidebar();
  assert.equal(document.getElementById('sidebarBranch')!.hidden, false);
  assert.equal(document.getElementById('sidebarTitle')!.hidden, true);
});
