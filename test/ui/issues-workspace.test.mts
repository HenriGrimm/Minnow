import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { renderChatFromHistory } from '../../src/ui/messages.ts';
import { registerStreamDomRemount } from '../../src/tools/stream-chat-dom.ts';
import { setAssistantBubbleContent } from '../../src/markdown/renderer.ts';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { createEmptyChatObject, setSessionStateForTests, sessionState } from '../../src/state/sessions.ts';
import { findIssueById, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { disposeChatRunActivity, setChatRunActivity } from '../../src/state/chat-run-activity.ts';
import type { IssueCard } from '../../src/types.ts';
import type { IssueWorkSnapshot } from '../../src/state/git-api.ts';
import { APPEARANCE_STORAGE_KEYS } from '../../src/appearance/types.ts';
import { streamingChatIds } from '../../src/app-state.ts';
import { notifyChatStreamActivity, notifyChatStreamEnded, registerChatStreamText } from '../../src/chat/streaming-state.ts';

let calls: Array<{ action: string; input: any }> = [];
let inspect: IssueWorkSnapshot = {} as IssueWorkSnapshot;
let result: IssueWorkSnapshot = {} as IssueWorkSnapshot;
const originalFetch = globalThis.fetch;
const { mountIssueWorkspace } = await import('../../src/ui/issues-work-panel.ts');
let dom: Window;
let mounted: ReturnType<typeof mountIssueWorkspace> | undefined;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 60));
const click = (label: string) => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
  assert.equal(Boolean(button), true, `Missing button: ${label}`);
  button!.click();
};

beforeEach(() => {
  dom = new Window({ url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, NodeFilter: dom.NodeFilter });
  installHappyDomGlobals(dom);
  globalThis.cancelAnimationFrame = dom.cancelAnimationFrame.bind(dom);
  document.body.innerHTML = '<div id=mainColumn><div class=input-bar><textarea id=msgInput></textarea><button id=sendBtn></button></div></div>';
  localStorage.setItem(APPEARANCE_STORAGE_KEYS.chatView, 'compact');
  DOMPurify.sanitize = DOMPurify(dom as any).sanitize;
  setLocalServerAvailableForTests(true);
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body || '{}'));
    const action = String(input.op || '').replace('issueWork', '');
    calls.push({ action, input });
    return new Response(JSON.stringify(action === 'Inspect' ? inspect : result), { headers: { 'Content-Type': 'application/json' } });
  };
  const chat = createEmptyChatObject('model', 'C:/repo');
  chat.id = 'issue-chat'; chat.modeId = 'build'; chat.worktreeRoot = 'C:/worktree'; chat.chatWorktreeManaged = true;
  chat.history = [{ role: 'user', content: 'Fix it' }, { role: 'assistant', content: 'Fixed. The regression test passed.' }];
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  const issue: IssueCard = { id: 'MIN-1', title: 'Fix it', type: 'bug', status: 'review', priority: 'medium', labels: [], description: 'Keep the original description.', workspacePath: 'C:/repo', createdAt: 1, updatedAt: 1, chatIds: [chat.id] };
  setIssuesStateForTests({ version: 2, nextId: 2, issues: [issue], workspaces: {} });
  inspect = { ok: true, isolated: true, sourceBranch: 'issue/fix', targetBranch: 'main', sourceHead: 'a'.repeat(40), targetHead: 'b'.repeat(40), fingerprint: 'reviewed', dirty: true, ahead: 1, files: ['src/fix.ts'], patch: '+ reviewed change' };
  result = { ok: true, merged: true, sha: 'c'.repeat(40), targetBranch: 'main', sourceBranch: 'issue/fix', worktreeRemoved: true, branchRemoved: true };
  calls = [];
  const panel = document.createElement('div');
  const sticky = document.createElement('header');
  const body = document.createElement('div');
  const doc = document.createElement('div');
  const editor = document.createElement('textarea');
  editor.value = 'Unsubmitted editor contents'; doc.append(editor); body.append(doc); panel.append(sticky, body); document.body.append(panel);
  mounted = mountIssueWorkspace({ panel, sticky, document: doc, issueBody: body, issue, tab: 'Issue', onTab: () => {}, onStartChat: () => {} });
});
afterEach(() => { mounted?.dispose(); mounted = undefined; registerStreamDomRemount('issue-chat', null); streamingChatIds.clear(); notifyChatStreamEnded('issue-chat'); disposeChatRunActivity(); setIssuesStateForTests(null); setLocalServerAvailableForTests(false); globalThis.fetch = originalFetch; dom.happyDOM.abort(); });

function toolHistory() {
  return [
    { role: 'user' as const, content: 'Fix the header' },
    { role: 'assistant' as const, content: 'Checking the header.', thinking: ['Inspect the existing layout.'], tool_calls: [
      { id: 'read', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/header.ts"}' } },
    ] },
    { role: 'tool' as const, tool_call_id: 'read', content: 'Original header contents' },
    { role: 'assistant' as const, content: 'The header is **fixed**.' },
  ];
}

test('work inspection failures show recovery without the start-chat empty state', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unknown git op: issueWorkInspect' }, { status: 400 });
  click('Work'); await flush();
  const content = document.querySelector('.issues-work-content')!;
  assert.match(content.textContent!, /Restart Minnow \(including the tool server\)/);
  assert.doesNotMatch(content.textContent!, /Start a linked chat/);
  assert.equal(calls.length, 0);
});

test('linked chats use the main transcript appearance and active composer context', async () => {
  const linked = sessionState!.chats[0];
  linked.history = toolHistory();
  const active = createEmptyChatObject('model', 'C:/other');
  active.id = 'code-chat';
  sessionState!.chats.push(active);
  sessionState!.activeId = active.id;
  localStorage.setItem(APPEARANCE_STORAGE_KEYS.chatView, 'full');
  const main = document.createElement('div');
  main.id = 'chatArea'; main.textContent = 'Keep Code here';
  const empty = document.createElement('div'); empty.id = 'emptyState';
  const status = document.createElement('div'); status.id = 'composerRunStatus'; status.hidden = false;
  document.body.append(main, empty, status);
  click('Chat'); await flush();
  const transcript = document.querySelector<HTMLElement>('.shared-chat-host__transcript')!;
  assert.equal(transcript.dataset.chatView, 'full');
  assert.equal(transcript.querySelector('.chat-work')!.getAttribute('aria-expanded'), 'true');
  assert.equal(transcript.querySelector('.tool-call-msg')!.classList.contains('chat-work-hidden'), false);
  assert.equal(transcript.querySelector('.chat-turn-final strong')!.textContent, 'fixed');
  assert.match(transcript.querySelector('.tool-call-msg')!.textContent!, /Original header contents/);
  assert.equal(sessionState!.activeId, linked.id);
  assert.equal(main.textContent, 'Keep Code here');
  assert.equal(localStorage.getItem(APPEARANCE_STORAGE_KEYS.chatView), 'full');
});

test('work disclosures retain the reader choice across transcript updates and tab changes', async () => {
  sessionState!.chats[0].history = toolHistory();
  click('Chat'); await flush();
  document.querySelector<HTMLButtonElement>('.shared-chat-host__transcript .chat-work')!.click();
  setChatRunActivity('issue-chat', 'completed');
  assert.equal(document.querySelector('.shared-chat-host__transcript .chat-work')!.getAttribute('aria-expanded'), 'true');
  click('Issue'); click('Chat'); await flush();
  assert.equal(document.querySelector('.shared-chat-host__transcript .chat-work')!.getAttribute('aria-expanded'), 'true');
});

test('long issue chats backfill in order and cancel pending work when leaving Chat', async () => {
  const pending = new Map<number, IdleRequestCallback>();
  let handle = 0;
  dom.requestIdleCallback = (callback) => { pending.set(++handle, callback); return handle; };
  dom.cancelIdleCallback = (id) => { pending.delete(id); };
  sessionState!.chats[0].history = Array.from({ length: 80 }, (_, index) => ({ role: 'user', content: `Message ${index}` }));
  click('Chat'); await flush();
  const transcript = document.querySelector('.shared-chat-host__transcript')!;
  assert.equal(transcript.querySelectorAll('.msg.user').length, 30);
  while (pending.size) {
    const [id, callback] = pending.entries().next().value!;
    pending.delete(id);
    callback({ didTimeout: false, timeRemaining: () => 50 });
  }
  const messages = [...transcript.querySelectorAll('.msg-bubble')].map((node) => node.textContent);
  assert.equal(messages.length, 80);
  assert.equal(messages[0], 'Message 0');
  assert.equal(messages.at(-1), 'Message 79');
  click('Issue'); click('Chat'); await flush();
  assert.equal(pending.size, 1);
  click('Issue');
  assert.equal(pending.size, 0);
});

test('streaming prose stays inside the shared work disclosure and settles into a visible reply', async () => {
  const linked = sessionState!.chats[0];
  linked.history = toolHistory().slice(0, 3);
  streamingChatIds.add(linked.id);
  let delta = 'Checking **verification**.';
  registerChatStreamText(linked.id, () => ({ lastDelta: delta, lastThinking: '', toolCallCount: 1 }));
  let liveRow: HTMLElement | undefined;
  registerStreamDomRemount(linked.id, row => { liveRow = row.bubble; setAssistantBubbleContent(row.bubble, delta, { streaming: true }); });
  click('Chat'); await flush();
  const transcript = document.querySelector<HTMLElement>('.shared-chat-host__transcript')!;
  assert.equal(transcript.querySelector('.chat-work')!.getAttribute('aria-expanded'), 'true');
  const live = transcript.querySelector<HTMLElement>('.msg.assistant:last-child')!;
  assert.equal(live.classList.contains('chat-work-hidden'), false);
  assert.equal(live.querySelector('strong')!.textContent, 'verification');
  transcript.querySelector<HTMLButtonElement>('.chat-work')!.click();
  delta = 'Verification **passed**.';
  setAssistantBubbleContent(liveRow!, delta, { streaming: true });
  notifyChatStreamActivity(linked.id); await flush();
  assert.equal(live.querySelector('strong')!.textContent, 'passed');
  assert.equal(live.classList.contains('chat-work-hidden'), false);
  linked.history.push({ role: 'assistant', content: 'The header is **fixed**.' });
  streamingChatIds.delete(linked.id);
  notifyChatStreamEnded(linked.id); renderChatFromHistory(linked); await flush();
  assert.equal(transcript.querySelector('.chat-turn-final strong')!.textContent, 'fixed');
  assert.equal(transcript.querySelector('.chat-turn-final')!.classList.contains('chat-work-hidden'), false);
});

test('tabs preserve the existing issue editor and show the same linked chat', async () => {
  const editor = document.querySelector<HTMLTextAreaElement>('.issues-detail__document textarea') ?? [...document.querySelectorAll('textarea')].find(el => el.id !== 'msgInput')!;
  click('Work'); await flush();
  assert.equal(editor.value, 'Unsubmitted editor contents');
  click('Chat'); await flush();
  assert.match(document.querySelector('.issues-work-content')!.textContent!, /Fixed\. The regression test passed/);
  const composer = document.querySelector('.input-bar')!;
  assert.equal(composer.parentElement?.classList.contains('shared-chat-host'), true);
  click('Issue');
  assert.equal(composer.parentElement?.id, 'mainColumn');
  assert.equal(editor.isConnected, true);
  assert.equal(editor.value, 'Unsubmitted editor contents');
});

test('merge sends the reviewed snapshot and records delivery without deleting the chat', async () => {
  click('Work'); await flush();
  click('Commit & merge');
  click('Merge into main'); await flush();
  const merge = calls.find((entry) => entry.action === 'Merge')!;
  assert.equal(merge.input.sourceHead, 'a'.repeat(40));
  assert.equal(merge.input.targetHead, 'b'.repeat(40));
  assert.equal(merge.input.fingerprint, 'reviewed');
  assert.equal(merge.input.cleanup, true);
  assert.equal(findIssueById('MIN-1')!.status, 'done');
  assert.equal(findIssueById('MIN-1')!.chatIds?.[0], 'issue-chat');
  assert.equal(findIssueById('MIN-1')!.activity?.at(-1)?.kind, 'work-merged');
});

test('merge failure keeps the issue in Review and exposes retry information', async () => {
  result = { ok: false, conflict: true, error: 'Merge conflict. Worktree preserved.' };
  click('Work'); await flush(); click('Commit & merge'); click('Merge into main'); await flush();
  assert.equal(findIssueById('MIN-1')!.status, 'review');
  assert.match(document.body.textContent!, /Merge conflict\. Worktree preserved/);
  assert.equal(findIssueById('MIN-1')!.activity?.some((entry) => entry.kind === 'work-merged') ?? false, false);
});

test('delivery waits for another chat working in the same checkout', async () => {
  const other = createEmptyChatObject('model', 'C:/repo');
  other.id = 'other-chat'; other.worktreeRoot = 'C:/worktree';
  sessionState!.chats.push(other);
  setChatRunActivity(other.id, 'running');
  click('Work'); await flush();
  assert.match(document.body.textContent!, /A chat is working in this checkout/);
  assert.equal([...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Commit & merge'), false);
  assert.equal(calls.some((entry) => entry.action === 'Merge'), false);
});


test('Chat borrows the wired composer and returns the same controls on close', async () => {
  const bar = document.querySelector('.input-bar')!;
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  const send = document.getElementById('sendBtn')!;
  let clicks = 0;
  send.addEventListener('click', () => clicks++);
  click('Chat'); await flush();
  assert.equal(document.querySelector('.shared-chat-host .input-bar'), bar);
  assert.equal(document.querySelectorAll('#msgInput').length, 1);
  send.click(); assert.equal(clicks, 1);
  input.value = 'Unsent follow-up';
  click('Issue');
  assert.equal(bar.parentElement?.id, 'mainColumn');
  assert.equal(input.value, 'Unsent follow-up');
  click('Chat'); await flush();
  assert.equal(document.querySelector('.shared-chat-host #msgInput'), input);
  assert.equal(input.value, 'Unsent follow-up');
  send.click(); assert.equal(clicks, 2);
});
