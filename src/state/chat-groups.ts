/** Sidebar chat groups, membership and pins. */

import { sendRemoteChatCommand, shouldRelayChat } from '../chat/remote-chat-client';
import { setStatus } from '../ui/status';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Chat, ChatGroup } from '../types';
import { getChatLastMessageAt } from './session-workspace-scope';
import {
  markGroupDeleted,
  findChatById,
  markChatDirty,
  markGroupDirty,
  markSessionScalarsDirty,
  newChatId,
  scheduleSaveSessions,
  sessionState,
  touchChat,
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

// ── Sidebar ──────────────────────────────────────────────────────────────────

const pendingPins = new Map<string, { pinnedAt: number; work: Promise<void> }>();

function chatPinTime(chat: Chat): number {
  return pendingPins.get(chat.id)?.pinnedAt ?? chat.pinnedAt ?? 0;
}

export function isChatPinned(chat: Chat): boolean {
  return !chat.agentConversation && chatPinTime(chat) > 0;
}

/**
 * Pin or unpin a chat. Does not restamp `updatedAt`: pinning is list placement,
 * not activity, so the chat keeps its slot when it is unpinned again.
 */
export function setChatPinned(chat: Chat, pinned: boolean): void {
  if (chat.agentConversation) return;
  if (pinned === isChatPinned(chat)) return;
  if (shouldRelayChat(chat.id)) {
    const pinnedAt = pinned ? Date.now() : 0;
    // Placement is immediate, but only acknowledged metadata may be saved.
    // Serialize rapid toggles so an earlier response cannot undo a later click.
    const work = (pendingPins.get(chat.id)?.work ?? Promise.resolve()).then(async () => {
      try {
        await sendRemoteChatCommand(chat.id, 'configure', { patch: { pinned } });
        const current = findChatById(chat.id) ?? chat;
        if (pinned) current.pinnedAt ||= pinnedAt;
        else delete current.pinnedAt;
      } catch (error) {
        setStatus('err', String((error as Error)?.message || error));
      }
    }).finally(() => {
      if (pendingPins.get(chat.id)?.work !== work) return;
      pendingPins.delete(chat.id);
      void import('../ui/sidebar').then(({ scheduleRenderSidebar }) => scheduleRenderSidebar());
    });
    pendingPins.set(chat.id, { pinnedAt, work });
    return;
  }
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
  pinned.sort((a, b) => chatPinTime(b) - chatPinTime(a));
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
    const members = workspaceChats.filter((chat) => chat.groupId === group.id);
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

/** Ungroup member chats, including members of a legacy board folder. */
export function deleteGroup(id: string): void {
  const state = requireSession();
  const groups = ensureGroupsArray();
  const idx = groups.findIndex((group) => group.id === id);
  if (idx < 0) return;
  groups.splice(idx, 1);
  if (state.lastBoardGroupId === id) {
    delete state.lastBoardGroupId;
    markSessionScalarsDirty();
  }
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
}

export function assignChatToGroup(chatId: string, groupId: string | null): void {
  const state = requireSession();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || chat.agentConversation) return;
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
