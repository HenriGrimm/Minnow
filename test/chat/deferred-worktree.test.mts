import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { enableChatWorktreeOnSend, resolveChatToolWorkspaceRoot } from '../../src/state/chat-worktree.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { DEFAULT_TITLES_CONFIG, setTitlesConfigForTests } from '../../src/config/titles-meta.ts';
import { setRunTurnForTests, resetRunTurnForTests } from '../../src/chat/run-turn-chat.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { renderChatFromHistory } from '../../src/ui/messages.ts';
import { getChatAbort } from '../../src/app-state.ts';
import { syncComposerFromStreamingState } from '../../src/ui/composer-send.ts';
import { setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { isChatStreaming } from '../../src/chat/streaming-state.ts';
import { getPendingAttachments, pushAttachment, clearAttachments } from '../../src/attachments/store.ts';

let dom: Window;
const originalFetch = globalThis.fetch;
let complete: (response: Response) => void;
let requests: Record<string, any>[];
let turns = 0;

function setup() {
  dom = new Window();
  requests = [];
  turns = 0;
  installHappyDomGlobals(dom, { fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    requests.push(body);
    if (body.op === 'enable_chat') return new Promise<Response>(resolve => { complete = resolve; });
    return Response.json({ ok: true, current: 'main', models: [], serves: [] });
  }) as typeof fetch });
  setStorageModeForTests('localStorage');
  setIssuesStateForTests({ version: 2, nextId: 1, issues: [] } as never);
  setLocalServerAvailableForTests(true);
  setTitlesConfigForTests({ ...DEFAULT_TITLES_CONFIG, enabled: false });
  const chat = createEmptyChatObject('m1', '/repo');
  chat.providerId = 'vite-fallback';
  chat.gitBranch = 'main';
  chat.composerDraft = 'Fix the login page';
  enableChatWorktreeOnSend(chat);
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  document.body.innerHTML = '<div id="chatArea"></div><textarea id="msgInput"></textarea><button id="sendBtn"></button>';
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  input.value = chat.composerDraft;
  setRunTurnForTests(async () => {
    turns++;
    assert.equal(resolveChatToolWorkspaceRoot(chat), '/managed/login');
    return { outcome: 'no_report' };
  });
  return { chat, input };
}

async function waitForSetup() {
  for (let i = 0; i < 100 && !requests.some(body => body.op === 'enable_chat'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(requests.some(body => body.op === 'enable_chat'), 'send starts setup');
}

afterEach(async () => {
  clearAttachments();
  resetRunTurnForTests();
  setLocalServerAvailableForTests(false);
  await teardownHappyDomAsync(dom);
  setSessionStateForTests(null);
  setIssuesStateForTests(null);
  globalThis.fetch = originalFetch;
});

test('Send prepares the worktree, restores progress on remount, then runs the message there once', async () => {
  const { chat, input } = setup();
  const send = sendMessageWithTools();
  await waitForSetup();
  assert.equal(turns, 0);
  assert.equal(input.disabled, true);
  assert.equal(input.value, 'Fix the login page');
  assert.equal(chat.history.length, 0);
  assert.match(document.querySelector('.chat-worktree-setup')!.textContent!, /Setting up your worktree/);
  assert.equal(document.querySelector('.chat-worktree-setup')!.getAttribute('aria-busy'), 'true');
  await sendMessageWithTools();
  assert.equal(requests.filter(body => body.op === 'enable_chat').length, 1);

  const other = createEmptyChatObject('m1', '/other');
  other.history = [{ role: 'user', content: 'Other chat' }];
  setSessionStateForTests({ chats: [chat, other], activeId: other.id });
  renderChatFromHistory(other);
  assert.equal(document.querySelector('.chat-worktree-setup'), null);
  setSessionStateForTests({ chats: [chat, other], activeId: chat.id });
  renderChatFromHistory(chat);
  assert.match(document.querySelector('.chat-worktree-setup')!.textContent!, /Setting up your worktree/);
  complete(Response.json({ ok: true, path: '/managed/login', branch: 'minnow/login' }));
  await send;
  assert.equal(turns, 1);
  assert.equal(chat.worktreeRoot, '/managed/login');
  assert.equal(other.worktreeRoot, undefined);
  assert.equal(chat.history.filter(row => row.role === 'user').length, 1);
  assert.equal(input.value, '');
  assert.equal(input.disabled, false);
  assert.equal(document.querySelector('.chat-worktree-setup'), null);
});

test('failed setup retains text and attachments, never runs tools, and Send retries isolation', async () => {
  const { chat, input } = setup();
  pushAttachment({ id: 'note', name: 'note.txt', kind: 'text', text: 'Details', mimeType: 'text/plain', size: 7 });
  const send = sendMessageWithTools();
  await waitForSetup();
  complete(Response.json({ ok: false, error: 'Dependency installation failed' }));
  await send;
  assert.equal(turns, 0);
  assert.equal(chat.worktreeRoot, undefined);
  assert.equal(chat.worktreeSetupRequired, true);
  assert.equal(chat.worktreeEnabled, true);
  assert.equal(chat.history.length, 0);
  assert.equal(input.value, 'Fix the login page');
  assert.equal(chat.composerDraft, 'Fix the login page');
  assert.equal(input.disabled, false);
  assert.equal(getPendingAttachments().length, 1);
  renderChatFromHistory(chat);
  assert.match(document.querySelector('.chat-worktree-setup')!.textContent!, /Dependency installation failed/);
  assert.deepEqual([...document.querySelectorAll('.chat-worktree-setup button')].map(button => button.textContent), ['Retry setup', 'Back to Local']);

  requests = [];
  const retry = sendMessageWithTools();
  await waitForSetup();
  complete(Response.json({ ok: true, path: '/managed/login', branch: 'minnow/login' }));
  await retry;
  assert.equal(turns, 1);
  assert.equal(chat.worktreeSetupRequired, undefined);
  assert.equal(chat.worktreeEnabled, undefined);
});

test('stopping a setup prevents the agent turn after the checkout finishes', async () => {
  const { chat } = setup();
  const send = sendMessageWithTools();
  await waitForSetup();
  getChatAbort(chat.id)!.abort();
  complete(Response.json({ ok: true, path: '/managed/login', branch: 'minnow/login' }));
  await send;
  assert.equal(turns, 0);
  assert.equal(chat.history.length, 0);
  assert.equal(isChatStreaming(chat.id), false);
});


test('setup completion in another chat preserves that chat’s draft and attachments', async () => {
  const { chat, input } = setup();
  const send = sendMessageWithTools();
  await waitForSetup();
  const other = createEmptyChatObject('m1', '/other');
  other.composerDraft = 'Keep this draft';
  setSessionStateForTests({ chats: [chat, other], activeId: other.id });
  input.value = other.composerDraft;
  syncComposerFromStreamingState();
  pushAttachment({ id: 'other-note', name: 'other.txt', kind: 'text', text: 'Other details', mimeType: 'text/plain', size: 13 });
  renderChatFromHistory(other);
  complete(Response.json({ ok: true, path: '/managed/login', branch: 'minnow/login' }));
  await send;
  assert.equal(turns, 1);
  assert.equal(input.value, 'Keep this draft');
  assert.equal(other.composerDraft, 'Keep this draft');
  assert.equal(input.disabled, false);
  assert.equal(getPendingAttachments()[0]?.id, 'other-note');
  assert.equal(other.worktreeRoot, undefined);
  assert.equal(document.querySelector('.chat-worktree-setup'), null);
});


test('an empty send keeps Worktree enabled without setting up a checkout', async () => {
  const { chat, input } = setup();
  input.value = '';
  await sendMessageWithTools();
  assert.equal(requests.some(body => body.op === 'enable_chat'), false);
  assert.equal(chat.worktreeEnabled, true);
  assert.equal(chat.worktreeRoot, undefined);
  assert.equal(turns, 0);
});
