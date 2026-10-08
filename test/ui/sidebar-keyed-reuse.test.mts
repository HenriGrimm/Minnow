/**
 * MIN-584 — keyed sidebar reuse so tool-batch rerenders do not restart CSS animations.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import { renderSidebar } from '../../src/ui/sidebar.ts';
import { setStreaming } from '../../src/app-state.ts';
import {
  maybeMarkChatUnreadAfterLeave,
  recordAssistantReplyOnChat,
  recordChatOpened,
  syncChatItemDotsInDom,
} from '../../src/ui/chat-item-dot.ts';
import { acknowledgeChatViewed } from '../../src/notifications/acknowledge.ts';
import type { Chat, SessionState } from '../../src/types.ts';

const WS = 'C:\\workspace\\min-584-sidebar';
let activeWindow: Window | undefined;

function setupList(): HTMLElement {
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
  const list = document.createElement('div');
  list.id = 'chatList';
  document.body.appendChild(list);
  return list;
}

function listedChat(name: string, id: string): Chat {
  const chat = createEmptyChatObject('m1', WS);
  chat.id = id;
  chat.name = name;
  chat.history = [{ role: 'user', content: 'hi' }];
  chat.historyLoaded = true;
  chat.lastMessageAt = 1;
  chat.updatedAt = 1;
  return chat;
}

afterEach(() => {
  setStreaming(false);
  document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
});

describe('sidebar keyed reuse (MIN-584)', () => {
  test('a completed chat replaces its spinner with an unread dot until opened', () => {
    const list = setupList();
    setWorkspaceFromServer({ path: WS, label: 'ws', isDefault: false });
    const active = listedChat('Active', 'active');
    const other = listedChat('Other', 'other');
    const state: SessionState = {
      ...defaultSessionState(), chats: [active, other], activeId: active.id,
    };
    setSessionStateForTests(state);
    setStreaming(true, other.id);
    renderSidebar();
    const row = list.querySelector<HTMLElement>(`[data-chat-id="${other.id}"]`)!;
    const dot = row.querySelector<HTMLElement>('.chat-item-dot')!;
    assert.equal(dot.dataset.dotState, 'working');
    assert.ok(dot.querySelector('.chat-item-dot__spinner'));

    recordAssistantReplyOnChat(other);
    syncChatItemDotsInDom();
    assert.equal(dot.dataset.dotState, 'working', 'keep the spinner until the turn ends');
    setStreaming(false, other.id);
    syncChatItemDotsInDom();
    assert.equal(dot.dataset.dotState, 'unread');
    assert.equal(dot.hidden, false);
    assert.equal(dot.querySelector('.chat-item-dot__spinner'), null);
    renderSidebar();
    assert.equal(list.querySelector(`[data-chat-id="${other.id}"]`), row);
    assert.equal(dot.dataset.dotState, 'unread');

    state.activeId = other.id;
    acknowledgeChatViewed(other.id);
    assert.equal(other.unread, false);
    assert.equal(dot.hidden, true);
    state.activeId = active.id;
    maybeMarkChatUnreadAfterLeave(other);
    syncChatItemDotsInDom();
    assert.equal(dot.hidden, true, 'returning to another chat must not restore the dot');
  });

  test('a reply seen in the active chat stays read after switching away', (t) => {
    setupList();
    const active = listedChat('Active', 'seen');
    const other = listedChat('Other', 'next');
    const state: SessionState = {
      ...defaultSessionState(), chats: [active, other], activeId: active.id,
    };
    setSessionStateForTests(state);
    t.mock.method(Date, 'now', () => 100);
    recordChatOpened(active.id);
    t.mock.method(Date, 'now', () => 200);
    recordAssistantReplyOnChat(active);
    state.activeId = other.id;
    maybeMarkChatUnreadAfterLeave(active);
    assert.notEqual(active.unread, true);
  });

  test('second renderSidebar keeps the same chat row element', () => {
    const list = setupList();
    setWorkspaceFromServer({ path: WS, label: 'ws', isDefault: false });
    const a = listedChat('Alpha', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const b = listedChat('Beta', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    const state: SessionState = {
      ...defaultSessionState(),
      chats: [a, b],
      activeId: a.id,
    };
    setSessionStateForTests(state);

    renderSidebar();
    const first = list.querySelector<HTMLElement>(`[data-chat-id="${a.id}"]`);
    assert.ok(first, 'expected a row for Alpha');

    a.name = 'Alpha renamed';
    renderSidebar();
    const second = list.querySelector<HTMLElement>(`[data-chat-id="${a.id}"]`);
    assert.equal(second, first, 'row element must be reused, not recreated');
    assert.equal(second?.querySelector('.chat-item-name')?.textContent, 'Alpha renamed');
    assert.equal(list.querySelectorAll('.chat-item-row').length, 2);
  });
});
