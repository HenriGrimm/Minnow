/**
 * Sidebar chat groups store.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  assignChatToGroup,
  buildSortedWorkspaceSidebarEntries,
  createGroup,
  deleteGroup,
  getGroupActivityAt,
  getGroupsForWorkspace,
  isChatPinned,
  renameGroup,
  setChatPinned,
  splitPinnedChats,
  toggleGroupCollapsed,
} from '../../src/state/chat-groups.ts';
import {
  createEmptyChatObject,
  ensureChatShape,
  flushScheduledSessionSaveForTests,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import type { ChatGroup, OrchestrateBoardState } from '../../src/types.ts';

const WS = 'C:\\workspace\\demo';
const PLANNER_ID = '11111111-1111-1111-1111-111111111111';
const PLAN_PATH = 'documentation/plans/demo-plan.md';

/**
 * Attach leftover V1 hydrate so folder helpers still see a board blob.
 * Live V2 boards are journals — this is session-only, not the engine.
 */
function attachLeftoverBoard(
  group: ChatGroup,
  tasks: OrchestrateBoardState['tasks'],
): void {
  group.orchestrateBoard = {
    planPath: PLAN_PATH,
    startedAt: 1,
    lastUpdatedAt: 1,
    waves: [{ id: 'W1' }],
    tasks,
  };
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
});

describe('chat groups', () => {
  test('create rename delete keeps chats', () => {
    const chat = createEmptyChatObject('', WS);
    chat.id = PLANNER_ID;
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [chat],
    });
    const g = createGroup('Sprint 1', WS);
    assignChatToGroup(chat.id, g.id);
    assert.equal(chat.groupId, g.id);
    renameGroup(g.id, 'Sprint A');
    assert.equal(getGroupsForWorkspace(WS)[0]?.name, 'Sprint A');
    toggleGroupCollapsed(g.id);
    assert.equal(getGroupsForWorkspace(WS)[0]?.collapsed, true);
    deleteGroup(g.id);
    assert.equal(chat.groupId, undefined);
    assert.equal(getGroupsForWorkspace(WS).length, 0);
  });

  test('deleting a legacy board folder keeps its chats and the active conversation', () => {
    const chat = createEmptyChatObject('', WS);
    setSessionStateForTests({ version: 5, activeId: chat.id, sidebarCollapsed: false, groups: [], chats: [chat] });
    const group = createGroup('Imported plan', WS);
    attachLeftoverBoard(group, []);
    chat.boardGroupId = chat.groupId = group.id;
    deleteGroup(group.id);
    assert.equal(sessionState?.activeId, chat.id);
    assert.deepEqual(sessionState?.chats.map(member => member.id), [chat.id]);
    assert.equal(chat.groupId, undefined);
    assert.equal(chat.boardGroupId, undefined);
  });

  test('getGroupActivityAt uses newest member message time', () => {
    const oldGroup = {
      id: 'grp_old',
      name: 'Old board',
      workspacePath: WS,
      collapsed: false,
      order: 0,
      createdAt: 1000,
    };
    const staleMember = createEmptyChatObject('', WS);
    staleMember.groupId = oldGroup.id;
    staleMember.lastMessageAt = 2000;
    staleMember.updatedAt = 2000;

    assert.equal(getGroupActivityAt(oldGroup, [staleMember]), 2000);
    assert.equal(getGroupActivityAt(oldGroup, []), 1000);
  });

  test('buildSortedWorkspaceSidebarEntries interleaves by activity', () => {
    const staleGroup = {
      id: 'grp_stale',
      name: 'Stale board',
      workspacePath: WS,
      collapsed: false,
      order: 0,
      createdAt: 1000,
    };
    const midGroup = {
      id: 'grp_mid',
      name: 'Mid board',
      workspacePath: WS,
      collapsed: false,
      order: 1,
      createdAt: 3000,
    };
    const staleMember = createEmptyChatObject('', WS);
    staleMember.groupId = staleGroup.id;
    staleMember.lastMessageAt = 2000;
    staleMember.updatedAt = 2000;
    const midMember = createEmptyChatObject('', WS);
    midMember.groupId = midGroup.id;
    midMember.lastMessageAt = 5000;
    midMember.updatedAt = 5000;
    const freshChat = createEmptyChatObject('', WS);
    freshChat.lastMessageAt = 9000;
    freshChat.updatedAt = 9000;

    const ordered = buildSortedWorkspaceSidebarEntries(
      [staleGroup, midGroup],
      [freshChat, midMember, staleMember],
    );
    assert.deepEqual(
      ordered.map((entry) => (entry.kind === 'group' ? entry.group.id : entry.chat.id)),
      [freshChat.id, midGroup.id, staleGroup.id],
    );
  });

  test('setChatPinned stamps pinnedAt without touching activity, and unpin clears it', () => {
    const chat = createEmptyChatObject('', WS);
    chat.updatedAt = 1234;
    chat.lastMessageAt = 1234;
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [chat],
    });
    setChatPinned(chat, true);
    assert.ok(isChatPinned(chat));
    assert.ok((chat.pinnedAt ?? 0) > 0);
    assert.equal(chat.updatedAt, 1234);
    assert.equal(chat.lastMessageAt, 1234);
    setChatPinned(chat, false);
    assert.equal(isChatPinned(chat), false);
    assert.equal('pinnedAt' in chat, false);
  });

  test('splitPinnedChats lists newest pin first and keeps the rest in order', () => {
    const a = createEmptyChatObject('', WS);
    const b = createEmptyChatObject('', WS);
    const c = createEmptyChatObject('', WS);
    const d = createEmptyChatObject('', WS);
    b.pinnedAt = 100;
    d.pinnedAt = 200;
    const { pinned, rest } = splitPinnedChats([a, b, c, d]);
    assert.deepEqual(pinned.map((x) => x.id), [d.id, b.id]);
    assert.deepEqual(rest.map((x) => x.id), [a.id, c.id]);
  });

  test('pinnedAt survives the shared chat schema and junk values are dropped', () => {
    const base = {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Pinned',
      workspacePath: WS,
      modelId: '',
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: 1,
    };
    assert.equal(ensureChatShape({ ...base, pinnedAt: 5000 } as Chat).pinnedAt, 5000);
    assert.equal(ensureChatShape({ ...base, pinnedAt: 'yes' } as unknown as Chat).pinnedAt, undefined);
    assert.equal(ensureChatShape({ ...base, pinnedAt: 0 } as Chat).pinnedAt, undefined);
  });
});
