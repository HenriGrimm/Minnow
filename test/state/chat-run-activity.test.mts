import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, after, test } from 'node:test';
import { disposeChatRunActivity, getChatRunActivity, setChatRunActivity, subscribeChatRunActivity, tickChatRunActivity } from '../../src/state/chat-run-activity.ts';
import { createIssueChatActivity, paintLinkedChatActivity } from '../../src/ui/issues-chat-activity.ts';
import { setStreaming } from '../../src/app-state.ts';
import { notifyChatStreamEnded } from '../../src/chat/streaming-state.ts';
import { setSessionStateForTests, createEmptyChatObject, flushScheduledSessionSaveForTests } from '../../src/state/sessions.ts';
import { setLocalServerAvailableForTests, setToolConfigForTests } from '../../src/tools/config.ts';
import { defaultToolConfig } from '../../src/config/defaults.ts';
import { finalizeRun } from '../../src/state/runs-store.ts';
import type { Chat, IssueCard } from '../../src/types.ts';

const originalChannel = globalThis.BroadcastChannel;
let receiver: (event: { data: unknown }) => void;
let sent: any[];
let closed: boolean;
beforeEach(() => {
  disposeChatRunActivity();
  setLocalServerAvailableForTests(false);
  setToolConfigForTests(defaultToolConfig());
  window.localStorage.clear();
  document.body.replaceChildren();
  sent = [];
  closed = false;
  class FakeChannel {
    set onmessage(fn: typeof receiver) { receiver = fn; }
    postMessage(data: unknown) { sent.push(data); }
    close() { closed = true; }
  }
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
});
afterEach(() => {
  disposeChatRunActivity();
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  globalThis.BroadcastChannel = originalChannel;
});
after(() => window.close());
const snapshot = (revision: number, status: string, updatedAt = Date.now() + revision) => ({
  kind: 'snapshot', owner: 'code-window', revision,
  entries: [['chat-1', { version: 1, status, updatedAt }]],
});

test('new/unknown chats have no invented completion; newest persisted terminal run is used', () => {
  assert.equal(getChatRunActivity('new-chat'), null);
  const chat = { runs: [
    { status: 'failed', createdAt: 30, endedAt: 40 },
    { status: 'completed', createdAt: 10, endedAt: 20 },
    { status: 'superseded', createdAt: 50, endedAt: 60 },
  ] } as Chat;
  assert.equal(getChatRunActivity('chat-1', chat), 'failed');
  assert.equal(getChatRunActivity('unknown-running', { runs: [{ status: 'running', createdAt: 100 }] } as Chat), null);
});

test('live start overrides prior terminal; completed, failed and stopped survive observer reload', () => {
  for (const status of ['completed', 'failed', 'stopped'] as const) {
    setChatRunActivity('chat-1', status);
    setChatRunActivity('chat-1', 'running');
    assert.equal(getChatRunActivity('chat-1'), 'running');
    setChatRunActivity('chat-1', status);
    disposeChatRunActivity();
    assert.equal(getChatRunActivity('chat-1'), status);
  }
});

test('cross-window snapshots replay a midrun start and reject out-of-order terminal updates', () => {
  let notifications = 0;
  const unsubscribe = subscribeChatRunActivity(() => { notifications++; });
  assert.equal(sent[0].kind, 'request');
  const badge = createIssueChatActivity({ chatIds: ['chat-1'] } as IssueCard);
  document.body.append(badge);
  receiver({ data: snapshot(2, 'running') });
  assert.equal(badge.textContent, 'Chat running');
  assert.equal(getChatRunActivity('chat-1'), 'running');
  receiver({ data: snapshot(1, 'completed') });
  assert.equal(getChatRunActivity('chat-1'), 'running');
  receiver({ data: snapshot(3, 'failed') });
  assert.equal(getChatRunActivity('chat-1'), 'failed');
  assert.equal(badge.textContent, 'Chat failed');
  assert.equal(notifications, 2);
  unsubscribe();
});

test('pagehide interrupts only active owned chats and replays local state to a new window', () => {
  setChatRunActivity('active', 'running');
  setChatRunActivity('done', 'completed');
  receiver({ data: { kind: 'request', owner: 'issues-window' } });
  assert.equal(sent.at(-1).entries.find(([id]: string[]) => id === 'active')[1].status, 'running');
  window.dispatchEvent(new window.Event('pagehide'));
  assert.equal(closed, true);
  assert.equal(getChatRunActivity('active'), 'interrupted');
  assert.equal(getChatRunActivity('done'), 'completed');
});

test('terminal cache retains only the latest 100 chat records', () => {
  for (let index = 0; index < 105; index++) setChatRunActivity(`chat-${index}`, 'completed');
  assert.equal(window.localStorage.length, 100);
});

test('issue and linked chat badges patch in place through lifecycle without resolving the issue', () => {
  const issue = { id: 'MIN-523', chatIds: ['chat-1'], status: 'in_progress' } as IssueCard;
  const slot = createIssueChatActivity(issue);
  document.body.append(slot);
  assert.equal(slot.hidden, true);
  setChatRunActivity('chat-1', 'running');
  assert.equal(slot.textContent, 'Chat running');
  const linked = document.createElement('span');
  paintLinkedChatActivity(linked, 'chat-1');
  document.body.append(linked);
  setChatRunActivity('chat-1', 'completed');
  assert.equal(slot.textContent, 'Chat finished');
  assert.equal(linked.textContent, 'finished');
  assert.equal(issue.status, 'in_progress');
  assert.equal(document.body.firstElementChild, slot);
});

test('shared stream lifecycle publishes start and finalized run outcome', () => {
  const chat = createEmptyChatObject();
  chat.id = 'chat-1';
  chat.runs = [{ runId: 'turn-1', status: 'running', createdAt: 10 } as any];
  setSessionStateForTests({ chats: [chat], activeId: chat.id, groups: [] });
  setStreaming(true, chat.id);
  assert.equal(getChatRunActivity(chat.id), 'running');
  const badge = createIssueChatActivity({ chatIds: [chat.id] } as IssueCard);
  document.body.append(badge);
  assert.equal(badge.textContent, 'Chat running');
  finalizeRun(chat, 'turn-1', { status: 'failed' });
  setChatRunActivity(chat.id, 'failed');
  assert.equal(badge.textContent, 'Chat failed');
  setStreaming(false, chat.id);
  notifyChatStreamEnded(chat.id);
  assert.equal(getChatRunActivity(chat.id), 'failed');
});


test('early stream end cannot reuse a prior completed run', () => {
  const chat = createEmptyChatObject();
  chat.id = 'early';
  chat.runs = [{ status: 'completed', createdAt: 10, endedAt: 20 } as any];
  setSessionStateForTests({ chats: [chat], activeId: chat.id, groups: [] });
  setStreaming(true, chat.id);
  setStreaming(false, chat.id);
  notifyChatStreamEnded(chat.id);
  assert.equal(getChatRunActivity(chat.id, chat), 'interrupted');
});


test('a crashed owner expires while heartbeat snapshots retain active remote work', () => {
  getChatRunActivity('chat-1');
  const now = Date.now();
  receiver({ data: snapshot(1, 'running', now) });
  tickChatRunActivity(now + 29_000);
  assert.equal(getChatRunActivity('chat-1'), 'running');
  tickChatRunActivity(now + 31_000);
  assert.equal(getChatRunActivity('chat-1'), 'interrupted');
  receiver({ data: snapshot(2, 'running', now + 32_000) });
  assert.equal(getChatRunActivity('chat-1'), 'running');
  setChatRunActivity('local-active', 'running');
  const previousCount = sent.length;
  tickChatRunActivity();
  assert.equal(sent.length, previousCount + 1);
});
