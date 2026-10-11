/**
 * Pinned chats list in their own section above every other sidebar entry.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setChatPinned } from '../../src/state/chat-groups.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  resetWorkspaceStateForTests,
  setWorkspaceFromServer,
} from '../../src/state/workspace.ts';
import { renderSidebar } from '../../src/ui/sidebar.ts';
import type { Chat, ChatGroup, SessionState } from '../../src/types.ts';

const WS = 'C:\\workspace\\pinned-chats';
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

function listedChat(name: string, lastMessageAt: number): Chat {
  const chat = createEmptyChatObject('m1', WS);
  chat.id = name.toLowerCase();
  chat.name = name;
  chat.history = [{ role: 'user', content: 'hi' }];
  chat.historyLoaded = true;
  chat.lastMessageAt = lastMessageAt;
  chat.updatedAt = lastMessageAt;
  return chat;
}

/** Section heads and chat rows in paint order, as `#section` / chat id. */
function paintOrder(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>(
    '.chat-list-section-head, .chat-item-row[data-chat-id], .chat-group-header',
  )].map((el) => {
    if (el.dataset.section) return `#${el.dataset.section}`;
    if (el.dataset.chatId) return el.dataset.chatId;
    return `group:${el.dataset.groupId}`;
  });
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
});

describe('sidebar pinned chats', () => {
  test('no Pinned section until a chat is pinned', () => {
    const list = setupList();
    setWorkspaceFromServer({ path: WS, label: 'ws', isDefault: false });
    const a = listedChat('A', 300);
    const b = listedChat('B', 200);
    setSessionStateForTests({ ...defaultSessionState(), chats: [a, b], activeId: a.id });
    renderSidebar();
    assert.deepEqual(paintOrder(list), ['a', 'b']);
  });

  test('pinned chats sit above newer activity and leave their group', () => {
    const list = setupList();
    setWorkspaceFromServer({ path: WS, label: 'ws', isDefault: false });
    const group: ChatGroup = {
      id: 'grp', name: 'Sprint', workspacePath: WS, collapsed: false, order: 0, createdAt: 1,
    };
    const fresh = listedChat('Fresh', 900);
    const old = listedChat('Old', 100);
    const grouped = listedChat('Grouped', 500);
    grouped.groupId = group.id;
    const state: SessionState = {
      ...defaultSessionState(), groups: [group], chats: [fresh, old, grouped], activeId: fresh.id,
    };
    setSessionStateForTests(state);

    setChatPinned(old, true);
    old.pinnedAt = 1;
    setChatPinned(grouped, true);
    grouped.pinnedAt = 2;
    renderSidebar();
    assert.deepEqual(paintOrder(list), [
      '#pinned', 'grouped', 'old', '#chats', 'fresh', 'group:grp',
    ]);
    assert.equal(grouped.groupId, group.id, 'pinning keeps group membership');

    setChatPinned(grouped, false);
    setChatPinned(old, false);
    renderSidebar();
    assert.deepEqual(paintOrder(list), ['fresh', 'group:grp', 'grouped', 'old']);
  });
});
