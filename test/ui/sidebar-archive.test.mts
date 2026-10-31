import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, setupMinimalComposerDom, teardownHappyDomAsync } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { setChatArchived } from '../../src/state/chat-archive.ts';
import {
  createEmptyChatObject, flushScheduledSessionSaveForTests, getSessionDirtyTrackingForTests,
  parseSessionStateFromJson, sessionState, setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { isEphemeralEmptyChat, pruneEphemeralEmptyChats } from '../../src/state/session-workspace-scope.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { createChatWithMode, renderSidebar } from '../../src/ui/sidebar.ts';
import type { Chat } from '../../src/types.ts';

const WS = 'C:/workspace/archive';
let win: Window;
const originalFetch = globalThis.fetch;

function setup(chats: Chat[]): HTMLElement {
  win = new Window();
  installHappyDomGlobals(win, { fetch: async () => Response.json({}) });
  setupMinimalComposerDom(document);
  const list = document.createElement('div');
  list.id = 'chatList';
  document.body.appendChild(list);
  setWorkspaceFromServer({ path: WS, label: 'Archive tests', isDefault: false });
  setSessionStateForTests({ ...defaultSessionState(), chats, activeId: chats[0]?.id });
  renderSidebar();
  return list;
}

function chat(id: string, workspace = WS): Chat {
  const value = createEmptyChatObject('model', workspace);
  value.id = id;
  value.name = id;
  value.history = [{ role: 'user', content: `Message in ${id}` }];
  value.updatedAt = 10;
  value.lastMessageAt = 5;
  return value;
}

function ids(list: HTMLElement): string[] {
  return [...list.querySelectorAll<HTMLElement>('[data-chat-id]')].map(row => row.dataset.chatId!);
}

function view(name: 'working' | 'archive'): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`#chatListViews [data-chat-view="${name}"]`)!;
}

function menuAction(id: string, label: string): void {
  const row = document.querySelector<HTMLElement>(`[data-chat-id="${id}"]`)!;
  row.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const action = [...document.querySelectorAll<HTMLButtonElement>('#chatItemContextMenu button')]
    .find(button => button.textContent === label);
  assert.ok(action, `Expected ${label}`);
  action.click();
}

afterEach(async () => {
  flushScheduledSessionSaveForTests();
  await teardownHappyDomAsync(win);
  setSessionStateForTests(null);
  resetWorkspaceStateForTests();
  globalThis.fetch = originalFetch;
});

test('bottom views count the current workspace and Unassigned, excluding boards and other folders', () => {
  const working = chat('working');
  const archived = chat('archived'); archived.archivedAt = 100;
  const unassigned = chat('legacy', ''); unassigned.archivedAt = 200;
  const elsewhere = chat('elsewhere', 'C:/different'); elsewhere.archivedAt = 300;
  const board = chat('board'); board.boardGroupId = 'board'; board.archivedAt = 400;
  const list = setup([working, archived, unassigned, elsewhere, board]);
  assert.deepEqual(ids(list), ['working']);
  assert.equal(view('working').getAttribute('aria-label'), 'Working (1)');
  assert.equal(view('archive').getAttribute('aria-label'), 'Archive (2)');
  assert.equal(list.nextElementSibling?.id, 'chatListViews');
  view('archive').click();
  assert.deepEqual(ids(list), ['legacy', 'archived']);
  assert.equal(view('archive').getAttribute('aria-pressed'), 'true');
  assert.equal(list.getAttribute('aria-label'), 'Archived chats');
  renderSidebar();
  assert.equal(document.querySelectorAll('#chatListViews').length, 1);
  assert.deepEqual(ids(list), ['legacy', 'archived']);
});

test('right-click archive and restore preserve transcript, active chat, pin, group and activity across reload', () => {
  const value = chat('pinned');
  value.pinnedAt = 30; value.groupId = 'sprint'; value.worktreeRoot = 'C:/trees/sprint';
  const list = setup([value]);
  sessionState!.groups = [{ id: 'sprint', name: 'Sprint', workspacePath: WS, order: 0, createdAt: 1, collapsed: false }];
  const transcript = value.history;
  menuAction(value.id, 'Archive chat');
  assert.ok(value.archivedAt! > 0);
  assert.equal(value.history, transcript);
  assert.equal(sessionState!.activeId, value.id);
  assert.equal(value.updatedAt, 10);
  assert.equal(value.lastMessageAt, 5);
  assert.equal(value.pinnedAt, 30);
  assert.equal(value.groupId, 'sprint');
  assert.equal(value.worktreeRoot, 'C:/trees/sprint');
  assert.ok(getSessionDirtyTrackingForTests().dirtyChatIds.includes(value.id));
  assert.deepEqual(ids(list), []);
  assert.equal(view('working').getAttribute('aria-label'), 'Working (0)');

  const restored = parseSessionStateFromJson(JSON.parse(JSON.stringify(sessionState)));
  setSessionStateForTests(restored);
  view('archive').click();
  assert.deepEqual(ids(list), [value.id]);
  assert.equal(restored.chats[0].archivedAt, value.archivedAt);
  menuAction(value.id, 'Restore chat');
  assert.deepEqual(ids(list), []);
  assert.match(list.textContent!, /No archived chats/);
  assert.equal(restored.chats[0].archivedAt, undefined);
  view('working').click();
  assert.deepEqual(ids(list), [value.id]);
  assert.ok(list.querySelector('[data-section="pinned"]'));
});

test('group members move out of Working and return to their group', () => {
  const value = chat('grouped'); value.groupId = 'sprint';
  const list = setup([value]);
  sessionState!.groups = [{ id: 'sprint', name: 'Sprint', workspacePath: WS, order: 0, createdAt: 1, collapsed: false }];
  renderSidebar();
  assert.ok(list.querySelector('.chat-group-members [data-chat-id="grouped"]'));
  menuAction(value.id, 'Archive chat');
  assert.deepEqual(ids(list), []);
  view('archive').click();
  assert.deepEqual(ids(list), ['grouped']);
  assert.equal(list.querySelector('.chat-group-header'), null);
  menuAction(value.id, 'Restore chat');
  view('working').click();
  assert.ok(list.querySelector('.chat-group-members [data-chat-id="grouped"]'));
});

test('multi-selection can archive and restore chats together', () => {
  const list = setup([chat('one'), chat('two')]);
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-id]')) {
    row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  }
  menuAction('one', 'Archive 2 chats');
  assert.deepEqual(ids(list), []);
  view('archive').click();
  for (const row of list.querySelectorAll<HTMLElement>('[data-chat-id]')) {
    row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  }
  menuAction('one', 'Restore 2 chats');
  assert.deepEqual(ids(list), []);
  view('working').click();
  assert.deepEqual(ids(list), ['one', 'two']);
});

test('keyboard context menu offers archiving and an empty archive survives ephemeral pruning', () => {
  const value = chat('keyboard');
  const list = setup([value]);
  list.querySelector<HTMLElement>('[data-chat-id]')!.dispatchEvent(
    new win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
  );
  const action = document.querySelector<HTMLButtonElement>('#chatItemContextMenu button')!;
  assert.equal(action.textContent, 'Archive chat');
  action.click();
  value.history = [];
  assert.equal(isEphemeralEmptyChat(value), false);
  pruneEphemeralEmptyChats(sessionState!, 'other');
  assert.equal(sessionState!.chats.length, 1);
  view('archive').click();
  assert.deepEqual(ids(list), [value.id]);
});

test('New chat returns to Working without reusing an archived empty chat', async () => {
  const value = chat('archived-empty'); value.history = []; value.archivedAt = 100;
  const list = setup([value]);
  view('archive').click();
  const result = await createChatWithMode({ modeId: 'general' });
  assert.equal(result.ok, true);
  assert.notEqual(result.chatId, value.id);
  assert.equal(list.dataset.chatView, 'working');
  assert.equal(view('working').getAttribute('aria-pressed'), 'true');
  assert.ok(sessionState!.chats.includes(value));
  assert.equal(value.archivedAt, 100);
});

test('archiving an unloaded chat needs no transcript hydration', () => {
  const value = chat('unloaded'); value.history = []; value.historyLoaded = false; value.messageCount = 10;
  const list = setup([value]);
  setChatArchived(value, true);
  renderSidebar();
  assert.equal(value.historyLoaded, false);
  assert.deepEqual(value.history, []);
  assert.deepEqual(ids(list), []);
  view('archive').click();
  assert.deepEqual(ids(list), ['unloaded']);
});


test('archiving a parent keeps its nested agent conversations out of Working and together in Archive', () => {
  const parent = chat('parent');
  const child = chat('child');
  child.agentConversation = { version: 1, childChatId: child.id, parentChatId: parent.id, rootChatId: parent.id,
    journalOwnerId: parent.id, initialRunId: 'child-task', origin: 'delegated', createdAt: 1,
    capabilities: { canSend: true, canStop: true, canChooseModel: true } };
  const list = setup([parent, child]);
  assert.equal(view('working').getAttribute('aria-label'), 'Working (2)');
  menuAction(parent.id, 'Archive chat');
  assert.deepEqual(ids(list), []);
  assert.equal(view('archive').getAttribute('aria-label'), 'Archive (2)');
  view('archive').click();
  assert.equal(list.querySelectorAll('[data-chat-id="parent"]').length, 1);
  assert.ok(list.querySelector('[data-chat-id="parent"] .chat-agent-toggle'));
  assert.equal(child.archivedAt, undefined, 'a parent archive does not rewrite child metadata');
  menuAction(parent.id, 'Restore chat');
  assert.deepEqual(ids(list), []);
  view('working').click();
  assert.ok(ids(list).includes('parent'));
  assert.equal(view('working').getAttribute('aria-label'), 'Working (2)');
});
