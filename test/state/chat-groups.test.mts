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
  dismissActiveBoardView,
  findBoardGroupForPlanner,
  findBoardGroupForPlanPath,
  getBoardGroupForChat,
  getGroupActivityAt,
  getGroupsForWorkspace,
  getOrCreateBoardGroup,
  isChatPinned,
  listBoardGroupChatIds,
  renameGroup,
  resolveBoardRestoreGroupOnSwitch,
  setChatPinned,
  splitPinnedChats,
  toggleGroupCollapsed,
} from '../../src/state/chat-groups.ts';
import {
  createEmptyChatObject,
  ensureChatShape,
  flushScheduledSessionSaveForTests,
  removeChatById,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import type { Chat, ChatGroup, OrchestrateBoardState } from '../../src/types.ts';

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

/** Sidebar list helpers hide ephemeral empty chats; seed one turn for fixtures. */
function markSidebarListed(chat: Chat): void {
  if (chat.history.length === 0 && !chat.composerDraft?.trim()) {
    chat.history.push({ role: 'user', content: 'fixture' });
  }
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

  test('group holds board and planner link', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    planner.orchestratePlanPath = PLAN_PATH;
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    assert.equal(planner.name, 'Orchestrator - demo-plan');
    attachLeftoverBoard(group, [{ id: 'W1-A', title: 'A', wave: 'W1', category: 'build', status: 'planned' }]);
    assert.equal(planner.boardGroupId, group.id);
    assert.equal(planner.groupId, group.id);
    assert.equal(findBoardGroupForPlanner(planner.id)?.id, group.id);
    assert.equal(getBoardGroupForChat(planner)?.orchestrateBoard?.tasks.length, 1);
    group.viewMode = 'board';
    if (!sessionState) throw new Error('Session not loaded');
    sessionState.activeBoardGroupId = group.id;
    assert.equal(group.viewMode, 'board');
    assert.equal(sessionState.activeBoardGroupId, group.id);
  });

  test('findBoardGroupForPlanPath matches normalized plan in workspace', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    planner.orchestratePlanPath = PLAN_PATH;
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    group.orchestratePlanPath = PLAN_PATH;

    assert.equal(
      findBoardGroupForPlanPath(WS, 'documentation/plans/demo-plan.md')?.id,
      group.id,
    );
    assert.equal(findBoardGroupForPlanPath(WS, 'documentation/plans/other.md'), undefined);
    assert.equal(findBoardGroupForPlanPath('/other/workspace', PLAN_PATH), undefined);
  });

  test('resolveBoardRestoreGroupOnSwitch returns group when leaving task chat for planner', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    planner.orchestratePlanPath = PLAN_PATH;
    const taskChat = createEmptyChatObject('', WS);
    taskChat.id = '22222222-2222-2222-2222-222222222222';
    taskChat.boardTaskId = 'W1-A';
    setSessionStateForTests({
      version: 5,
      activeId: taskChat.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner, taskChat],
    });
    const group = getOrCreateBoardGroup(planner);
    attachLeftoverBoard(group, [
      { id: 'W1-A', title: 'A', wave: 'W1', category: 'build', status: 'planned', chatId: taskChat.id },
    ]);
    taskChat.groupId = group.id;
    taskChat.boardGroupId = group.id;

    assert.equal(resolveBoardRestoreGroupOnSwitch(planner.id)?.id, group.id);
    assert.equal(resolveBoardRestoreGroupOnSwitch(taskChat.id), undefined);
  });

  test('delete board group removes folder and all member chats', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    planner.orchestratePlanPath = PLAN_PATH;
    const taskChat = createEmptyChatObject('', WS);
    taskChat.id = '22222222-2222-2222-2222-222222222222';
    const other = createEmptyChatObject('', WS);
    other.id = '33333333-3333-3333-3333-333333333333';
    markSidebarListed(other);
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner, taskChat, other],
    });
    const group = getOrCreateBoardGroup(planner);
    attachLeftoverBoard(group, [
      { id: 'W1-A', title: 'A', wave: 'W1', category: 'build', status: 'planned', chatId: taskChat.id },
    ]);
    taskChat.groupId = group.id;
    taskChat.boardGroupId = group.id;
    taskChat.boardTaskId = 'W1-A';
    assert.equal(listBoardGroupChatIds(group, sessionState!.chats).length, 2);

    const result = deleteGroup(group.id, { fallbackModelId: '' });
    assert.equal(result.ok, true);
    assert.equal(result.activeChanged, true);
    assert.equal(result.chatRemoval?.activeChat?.id, other.id);
    assert.equal(getGroupsForWorkspace(WS).length, 0);
    assert.equal(sessionState!.chats.length, 1);
    assert.equal(sessionState!.chats[0]?.id, other.id);
    assert.equal(sessionState!.activeId, other.id);
  });

  test('removeChatById preserves board group when planner chat deleted', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    planner.orchestratePlanPath = PLAN_PATH;
    const other = createEmptyChatObject('', WS);
    other.id = '22222222-2222-2222-2222-222222222222';
    markSidebarListed(other);
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner, other],
    });
    const group = getOrCreateBoardGroup(planner);
    attachLeftoverBoard(group, [{ id: 'W1-A', title: 'A', wave: 'W1', category: 'build', status: 'planned' }]);
    const result = removeChatById(planner.id, '');
    assert.equal(result.ok, true);
    assert.equal(result.activeChanged, true);
    assert.equal(result.activeChat.id, other.id);
    assert.equal(group.plannerChatId, undefined);
    assert.equal(group.orchestratePlanPath, PLAN_PATH);
    assert.equal(group.orchestrateBoard?.tasks.length, 1);
    assert.equal(findBoardGroupForPlanner(planner.id), undefined);
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

  test('buildSortedWorkspaceSidebarEntries pins planner chat first in board folder', () => {
    const boardGroup = {
      id: 'grp_board',
      name: 'demo-plan',
      workspacePath: WS,
      collapsed: false,
      order: 0,
      createdAt: 1000,
      plannerChatId: PLANNER_ID,
      orchestrateBoard: {
        planPath: PLAN_PATH,
        tasks: [],
        waves: [],
        startedAt: 1,
        lastUpdatedAt: 1,
        timerAccumulatedMs: 0,
        maxConcurrentTasks: 3,
        maxConcurrentTasks: 1,
      },
    };
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.groupId = boardGroup.id;
    planner.lastMessageAt = 1000;
    planner.updatedAt = 1000;
    const taskChat = createEmptyChatObject('', WS);
    taskChat.id = '22222222-2222-2222-2222-222222222222';
    taskChat.groupId = boardGroup.id;
    taskChat.lastMessageAt = 9000;
    taskChat.updatedAt = 9000;

    const ordered = buildSortedWorkspaceSidebarEntries(
      [boardGroup],
      [taskChat, planner],
    );
    const groupEntry = ordered.find((e) => e.kind === 'group');
    assert.ok(groupEntry && groupEntry.kind === 'group');
    assert.deepEqual(
      groupEntry.members.map((c) => c.id),
      [PLANNER_ID, taskChat.id],
    );
  });

  test('dismissActiveBoardView clears focus and folder viewMode', () => {
    const planner = createEmptyChatObject('', WS);
    planner.id = PLANNER_ID;
    planner.modeId = 'orchestrate';
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = createGroup('Board folder', WS);
    group.viewMode = 'board';
    if (!sessionState) throw new Error('Session not loaded');
    sessionState.activeBoardGroupId = group.id;
    assert.equal(dismissActiveBoardView(), true);
    assert.equal(group.viewMode, 'chat');
    assert.ok(!sessionState.activeBoardGroupId);
    assert.equal(dismissActiveBoardView(), false);
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
