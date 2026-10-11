/**
 * Sidebar chat groups: create, rename, collapse, assign chats.
 * Orchestrate board folders delete member chats on group delete; plain groups only ungroup.
 * Boards are owned by folders ({@link ChatGroup.orchestrateBoard}).
 */

import { getChatAbort, setChatStopReason } from '../app-state.ts';
import { reportBackgroundError } from '../boot/report-background-error.ts';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path.ts';
import { syncOrchestratorPlannerChatTitle } from '../chat/plans/planner-chat-title.ts';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Chat, ChatGroup } from '../types';
import { getChatLastMessageAt } from './session-workspace-scope';
import {
  markGroupDeleted,
  markChatDirty,
  markGroupDirty,
  markSessionScalarsDirty,
  newChatId,
  removeChatById,
  scheduleSaveSessions,
  sessionState,
  touchChat,
  type RemoveChatResult,
} from './sessions';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Persist a group mutation (marks dirtyGroupIds for B.2 PATCH upsert). */
function persistGroupChange(groupId: string): void {
  markGroupDirty(groupId);
  scheduleSaveSessions();
}

function newGroupId(): string {
  return `grp_${newChatId().slice(5)}`;
}

function requireSession(): NonNullable<typeof sessionState> {
  if (!sessionState) throw new Error('Session not loaded');
  return sessionState;
}

function ensureGroupsArray(): ChatGroup[] {
  const state = requireSession();
  if (!state.groups) {
    state.groups = [];
  }
  return state.groups;
}

/** Newest member activity for sidebar ordering; empty groups use `createdAt`. */
export function getGroupActivityAt(group: ChatGroup, chats: Chat[]): number {
  let newest = 0;
  for (const chat of chats) {
    if (chat.groupId !== group.id) continue;
    newest = Math.max(newest, getChatLastMessageAt(chat));
  }
  if (newest > 0) return newest;
  return typeof group.createdAt === 'number' && Number.isFinite(group.createdAt)
    ? group.createdAt
    : 0;
}

export type WorkspaceSidebarEntry =
  | { kind: 'group'; group: ChatGroup; members: Chat[] }
  | { kind: 'chat'; chat: Chat };

/**
 * True when a chat belongs to an Orchestrate board (planner, task, tester or fixer).
 *
 * Every board chat is stamped with `boardGroupId` when it is created
 * (stamped when the leftover planner/task chat is created), so this
 * stays a plain field read: no group lookup, no import cycle with sessions.ts.
 *
 * Board chats live in the Orchestrate screen, not the chats panel. Callers that
 * paint a chat list use this to leave them out.
 */
export function isBoardOwnedChat(chat: Chat): boolean {
  return Boolean(chat.boardGroupId?.trim());
}

/** True when a chat is an Orchestrate board task worker (builder / tester / fixer). */
export function isBoardTaskChat(chat: Chat): boolean {
  return Boolean(chat.boardTaskId?.trim());
}

/** True when a folder is a leftover V1 board and so is Orchestrate's, not the sidebar's. */
export function isBoardOwnedGroup(group: ChatGroup): boolean {
  return Boolean(group.orchestrateBoard);
}

/**
 * Leftover V1 session blob looks in-flight. V2 boards do not write this;
 * used only so dead folders are not treated as live.
 */
export function isLeftoverBoardRunning(group: ChatGroup): boolean {
  return group.orchestrateBoard?.status === 'running';
}

/** Leftover V1 task progress (complete+quarantined / total). */
export function leftoverBoardProgressPercent(group: ChatGroup): number {
  const tasks = group.orchestrateBoard?.tasks ?? [];
  if (!tasks.length) return 0;
  const done = tasks.filter(
    (t) => t.status === 'complete' || t.status === 'quarantined',
  ).length;
  return Math.round((done / tasks.length) * 100);
}

/** Board folders pin the planner chat first; other members stay activity-sorted. */
function sortBoardGroupMembers(group: ChatGroup, members: Chat[]): Chat[] {
  const plannerId = group.plannerChatId?.trim();
  if (!plannerId) return members;
  const planner = members.find((c) => c.id === plannerId);
  const rest = members
    .filter((c) => c.id !== plannerId)
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
  return planner ? [planner, ...rest] : rest;
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

export function isChatPinned(chat: Chat): boolean {
  return typeof chat.pinnedAt === 'number' && chat.pinnedAt > 0;
}

/**
 * Pin or unpin a chat. Does not restamp `updatedAt`: pinning is list placement,
 * not activity, so the chat keeps its slot when it is unpinned again.
 */
export function setChatPinned(chat: Chat, pinned: boolean): void {
  if (pinned === isChatPinned(chat)) return;
  if (pinned) chat.pinnedAt = Date.now();
  else delete chat.pinnedAt;
  markChatDirty(chat);
  scheduleSaveSessions();
}

/** Split pinned chats (newest pin first) from the rest, which keep their order. */
export function splitPinnedChats(chats: Chat[]): { pinned: Chat[]; rest: Chat[] } {
  const pinned: Chat[] = [];
  const rest: Chat[] = [];
  for (const chat of chats) (isChatPinned(chat) ? pinned : rest).push(chat);
  pinned.sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  return { pinned, rest };
}

/** Merge groups and ungrouped chats by newest activity (sidebar main list). */
export function buildSortedWorkspaceSidebarEntries(
  groups: ChatGroup[],
  workspaceChats: Chat[],
): WorkspaceSidebarEntry[] {
  const groupedIds = new Set<string>();
  const entries: WorkspaceSidebarEntry[] = [];

  for (const group of groups) {
    const members = sortBoardGroupMembers(
      group,
      workspaceChats.filter((c) => c.groupId === group.id),
    );
    members.forEach((c) => groupedIds.add(c.id));
    entries.push({ kind: 'group', group, members });
  }

  for (const chat of workspaceChats) {
    if (!groupedIds.has(chat.id)) {
      entries.push({ kind: 'chat', chat });
    }
  }

  entries.sort((a, b) => {
    const aActivity =
      a.kind === 'group' ? getGroupActivityAt(a.group, a.members) : getChatLastMessageAt(a.chat);
    const bActivity =
      b.kind === 'group' ? getGroupActivityAt(b.group, b.members) : getChatLastMessageAt(b.chat);
    return bActivity - aActivity;
  });

  return entries;
}

/** Groups for a workspace sorted by order then createdAt. */
export function getGroupsForWorkspace(workspacePath: string): ChatGroup[] {
  const ws = normalizeWorkspacePath(workspacePath);
  const groups = requireSession().groups ?? [];
  return [...groups]
    .filter((g) => normalizeWorkspacePath(g.workspacePath) === ws)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

// ── Group CRUD ───────────────────────────────────────────────────────────────

/** Create a group at the end of the workspace list. */
export function createGroup(name: string, workspacePath: string): ChatGroup {
  const state = requireSession();
  const groups = ensureGroupsArray();
  const ws = normalizeWorkspacePath(workspacePath);
  const siblings = getGroupsForWorkspace(ws);
  const group: ChatGroup = {
    id: newGroupId(),
    name: name.trim() || 'New group',
    workspacePath: ws,
    collapsed: false,
    order: siblings.length,
    createdAt: Date.now(),
  };
  groups.push(group);
  persistGroupChange(group.id);
  return group;
}

export function renameGroup(id: string, name: string): void {
  const groups = ensureGroupsArray();
  const g = groups.find((x) => x.id === id);
  if (!g) return;
  const trimmed = name.trim();
  if (trimmed) g.name = trimmed;
  persistGroupChange(id);
}

export interface DeleteGroupResult {
  ok: boolean;
  /** True when deleting a board folder removed the active chat. */
  activeChanged: boolean;
  /** Last chat removal result when a board folder and its chats were deleted. */
  chatRemoval?: RemoveChatResult;
}

/** Chat ids belonging to a board folder (membership + task-linked chats). */
export function listBoardGroupChatIds(group: ChatGroup, chats: readonly Chat[]): string[] {
  const ids = new Set<string>();
  const groupId = group.id;
  for (const chat of chats) {
    if (chat.groupId === groupId || chat.boardGroupId === groupId) {
      ids.add(chat.id);
    }
  }
  const board = group.orchestrateBoard;
  if (board) {
    const plannerId = group.plannerChatId?.trim();
    if (plannerId) ids.add(plannerId);
    for (const task of board.tasks) {
      if (task.chatId?.trim()) ids.add(task.chatId.trim());
      if (task.testChatId?.trim()) ids.add(task.testChatId.trim());
      if (task.fixerChatId?.trim()) ids.add(task.fixerChatId.trim());
    }
    if (board.finalTest?.chatId?.trim()) ids.add(board.finalTest.chatId.trim());
  }
  return [...ids];
}

function teardownBoardGroup(group: ChatGroup, chatIds: readonly string[]): void {
  for (const chatId of chatIds) {
    setChatStopReason(chatId, 'system');
    getChatAbort(chatId)?.abort();
  }
}

/** Remove a plain group (ungroup chats) or a board folder (delete all member chats). */
export function deleteGroup(
  id: string,
  options: { fallbackModelId?: string } = {},
): DeleteGroupResult {
  const state = requireSession();
  const groups = ensureGroupsArray();
  const idx = groups.findIndex((g) => g.id === id);
  if (idx < 0) return { ok: false, activeChanged: false };

  const group = groups[idx]!;
  const fallbackModelId = options.fallbackModelId ?? '';

  if (group.orchestrateBoard) {
    if (state.activeBoardGroupId === id) {
      dismissActiveBoardView();
    }
    const chatIds = listBoardGroupChatIds(group, state.chats);
    teardownBoardGroup(group, chatIds);
    groups.splice(idx, 1);
    if (state.lastBoardGroupId === id) {
      delete state.lastBoardGroupId;
      markSessionScalarsDirty();
    }

    let lastRemoval: RemoveChatResult | undefined;
    let activeChanged = false;
    for (const chatId of chatIds) {
      const result = removeChatById(chatId, fallbackModelId);
      if (result.ok) {
        lastRemoval = result;
        if (result.activeChanged) activeChanged = true;
      }
    }
    markGroupDeleted(id);
    scheduleSaveSessions();
    return { ok: true, activeChanged, chatRemoval: lastRemoval };
  }

  groups.splice(idx, 1);
  if (state.activeBoardGroupId === id) {
    delete state.activeBoardGroupId;
    markSessionScalarsDirty();
  }
  for (const chat of state.chats) {
    if (chat.groupId === id) {
      delete chat.groupId;
      touchChat(chat);
    }
    if (chat.boardGroupId === id) {
      delete chat.boardGroupId;
      touchChat(chat);
    }
  }
  markGroupDeleted(id);
  scheduleSaveSessions();
  return { ok: true, activeChanged: false };
}

export function assignChatToGroup(chatId: string, groupId: string | null): void {
  const state = requireSession();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return;
  if (groupId) {
    const group = (state.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    chat.groupId = groupId;
    touchChat(chat);
    persistGroupChange(groupId);
    return;
  }
  delete chat.groupId;
  touchChat(chat);
  scheduleSaveSessions();
}

export function toggleGroupCollapsed(id: string): void {
  const groups = ensureGroupsArray();
  const g = groups.find((x) => x.id === id);
  if (!g) return;
  g.collapsed = !g.collapsed;
  persistGroupChange(id);
}

export function findGroupById(id: string): ChatGroup | undefined {
  return (requireSession().groups ?? []).find((g) => g.id === id);
}

// ── Board folders ────────────────────────────────────────────────────────────

/** Folder currently driving board view in #chatArea. */
export function getActiveBoardGroup(): ChatGroup | undefined {
  const state = sessionState;
  if (!state?.activeBoardGroupId) return undefined;
  return findGroupById(state.activeBoardGroupId);
}

/**
 * Board folder the user was last inside — still set after they navigate away,
 * which is what {@link getActiveBoardGroup} deliberately is not.
 */
export function getLastBoardGroup(): ChatGroup | undefined {
  const state = sessionState;
  const id = state?.lastBoardGroupId?.trim();
  if (!id) return undefined;
  const group = findGroupById(id);
  return group?.orchestrateBoard ? group : undefined;
}

/** Clear board main-column focus (same as leaving board via switchChat). */
export function dismissActiveBoardView(): boolean {
  const state = sessionState;
  if (!state) return false;
  let openGroup = getActiveBoardGroup();
  if (!openGroup) {
    const active = state.chats.find((c) => c.id === state.activeId);
    if (active) openGroup = getBoardGroupForChat(active);
  }
  if (!openGroup) return false;
  openGroup.viewMode = 'chat';
  markGroupDirty(openGroup.id);
  if (state.activeBoardGroupId === openGroup.id) {
    delete state.activeBoardGroupId;
  }
  markSessionScalarsDirty();
  scheduleSaveSessions();
  return true;
}

/**
 * When leaving a board task chat for the planner row, reopen the kanban instead of chat view.
 * External chats and non-task folder members are unchanged.
 */
export function resolveBoardRestoreGroupOnSwitch(targetChatId: string): ChatGroup | undefined {
  const state = sessionState;
  if (!state) return undefined;
  const group = findBoardGroupForPlanner(targetChatId);
  if (!group?.orchestrateBoard) return undefined;
  const leaving = state.chats.find((c) => c.id === state.activeId);
  if (!leaving?.boardTaskId?.trim()) return undefined;
  const folderId = group.id;
  if (leaving.boardGroupId !== folderId && leaving.groupId !== folderId) return undefined;
  return group;
}

/** Board folder linked from a planner or task chat. */
export function getBoardGroupForChat(chat: Chat): ChatGroup | undefined {
  const boardGroupId = chat.boardGroupId?.trim();
  if (boardGroupId) {
    const byLink = findGroupById(boardGroupId);
    if (byLink) return byLink;
  }
  const memberGroupId = chat.groupId?.trim();
  if (memberGroupId) {
    const memberGroup = findGroupById(memberGroupId);
    if (memberGroup?.orchestrateBoard) return memberGroup;
  }
  return undefined;
}

/** Board folder for a normalized plan path in a workspace (avoids duplicate launches). */
export function findBoardGroupForPlanPath(
  workspacePath: string,
  planPath: string,
): ChatGroup | undefined {
  const normalized = normalizeOrchestratePlanPath(planPath.trim());
  if (!normalized) return undefined;
  const workspace = normalizeWorkspacePath(workspacePath);
  for (const group of requireSession().groups ?? []) {
    const groupPlan = group.orchestratePlanPath?.trim();
    if (!groupPlan) continue;
    if (normalizeOrchestratePlanPath(groupPlan) !== normalized) continue;
    if (normalizeWorkspacePath(group.workspacePath ?? '') !== workspace) continue;
    if (!group.plannerChatId?.trim()) continue;
    return group;
  }
  return undefined;
}

/** Find a folder whose planner chat matches the given chat id. */
export function findBoardGroupForPlanner(plannerChatId: string): ChatGroup | undefined {
  const id = plannerChatId.trim();
  if (!id) return undefined;
  return (requireSession().groups ?? []).find((g) => g.plannerChatId === id);
}

/** Sidebar folder membership + board link for the orchestrate planner (parse) chat. */
export function linkPlannerChatToBoardFolder(plannerChat: Chat, group: ChatGroup): void {
  group.plannerChatId = plannerChat.id;
  plannerChat.boardGroupId = group.id;
  plannerChat.groupId = group.id;
  if (plannerChat.orchestratePlanPath && !group.orchestratePlanPath) {
    group.orchestratePlanPath = plannerChat.orchestratePlanPath;
  }
  syncOrchestratorPlannerChatTitle(plannerChat);
  touchChat(plannerChat);
  persistGroupChange(group.id);
}

/** Create or return the board folder for an Orchestrate planner chat. */
export function getOrCreateBoardGroup(plannerChat: Chat): ChatGroup {
  const existing = plannerChat.boardGroupId
    ? findGroupById(plannerChat.boardGroupId)
    : findBoardGroupForPlanner(plannerChat.id);
  if (existing) {
    linkPlannerChatToBoardFolder(plannerChat, existing);
    return existing;
  }

  const planLabel =
    plannerChat.orchestratePlanPath?.split('/').pop()?.replace(/\.md$/i, '') ||
    'Orchestrate';
  const group = createGroup(planLabel, plannerChat.workspacePath);
  linkPlannerChatToBoardFolder(plannerChat, group);
  return group;
}

/** Planner chat for a board folder (required for board tools / timer). */
export function getPlannerChatForGroup(group: ChatGroup): Chat | undefined {
  const id = group.plannerChatId?.trim();
  if (!id) return undefined;
  return requireSession().chats.find((c) => c.id === id);
}

/** Mount board view for a folder after session fields are set. */
function activateBoardGroupView(groupId: string, group: ChatGroup): void {
  const state = requireSession();
  state.activeBoardGroupId = groupId;
  state.lastBoardGroupId = groupId;
  markSessionScalarsDirty();
  group.viewMode = 'board';
  persistGroupChange(groupId);
  void import('../ui/view-mode-toggle')
    .then((m) => m.syncBoardViewChrome())
    .catch((err) => reportBackgroundError('board-view-chrome-sync', err));

  /*
   * Board state is committed above, so the file tree can resolve this board's
   * integration worktree now (MIN-619). Deliberately its own chain rather than
   * the tail of the render chain below: a rejection anywhere in that chain used
   * to swallow this sync, leaving the tree on the previous root until the user
   * opened Source Control.
   */
  void import('../ui/git-panel')
    .then((m) => m.syncPanelFromActiveChat({ forceFileTree: true }))
    .catch((err) => reportBackgroundError('board-view-panel-sync', err));

  void import('../ui/code-overview')
    .then(({ dismissCodeOverviewForNavigation }) => {
      dismissCodeOverviewForNavigation();
      void import('../ui/sidebar').then((m) => m.renderSidebar());
      void import('../os/router').then((m) => m.navigateToCodeBoards());
    })
    .catch((err) => reportBackgroundError('board-view-activate', err));
}

/** Open folder board view in the main column (focuses planner chat when a task chat was active). */
export function openBoardGroup(groupId: string): void {
  const state = requireSession();
  const group = findGroupById(groupId);
  if (!group) return;
  if (!group.orchestrateBoard) return;

  const plannerId = group.plannerChatId?.trim();
  const active = state.chats.find((c) => c.id === state.activeId);
  if (plannerId && active && active.id !== plannerId) {
    const inFolder =
      active.boardGroupId === groupId || active.groupId === groupId;
    if (!inFolder) {
      void import('../ui/sidebar').then((m) => {
        m.switchChat(plannerId);
        activateBoardGroupView(groupId, group);
      });
      return;
    }
    state.activeId = plannerId;
    const planner = state.chats.find((c) => c.id === plannerId);
    if (planner) {
      planner.unread = false;
      planner.turnError = false;
    }
  }

  activateBoardGroupView(groupId, group);
}

/** Return to planner chat view and clear board main-column focus. */
export function closeBoardGroupView(group: ChatGroup): void {
  const state = requireSession();
  group.viewMode = 'chat';
  if (state.activeBoardGroupId === group.id) {
    delete state.activeBoardGroupId;
    markSessionScalarsDirty();
  }
  persistGroupChange(group.id);
  const plannerId = group.plannerChatId?.trim();
  if (plannerId) {
    void import('../ui/sidebar').then(async (sidebar) => {
      if (plannerId !== state.activeId) {
        sidebar.switchChat(plannerId);
        return;
      }
      sidebar.renderSidebar();
      const { dismissCodeOverviewForNavigation } = await import('../ui/code-overview');
      dismissCodeOverviewForNavigation();
      const { renderChatFromHistory } = await import('../ui/messages');
      const planner = state.chats.find((c) => c.id === plannerId);
      if (planner) renderChatFromHistory(planner);
    });
    return;
  }
  void import('../ui/sidebar').then((m) => m.renderSidebar());
  void import('../ui/code-overview').then(({ dismissCodeOverviewForNavigation }) => {
    dismissCodeOverviewForNavigation();
    void import('../ui/messages').then((m) => {
      const chat = state.chats.find((c) => c.id === state.activeId);
      if (chat) m.renderChatFromHistory(chat);
    });
  });
}
