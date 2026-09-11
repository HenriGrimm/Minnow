/**
 * Pure workspace-scoped session helpers (no sessions.ts / UI imports).
 * Used by sessions.ts and unit tests.
 */

import { AUTO_TITLE_MAX_LEN, PLACEHOLDER_CHAT_NAME } from '../constants';
import { DEFAULT_MODE_ID, normalizeModeId } from '../chat/modes/types';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Chat, SessionState } from '../types';

// ── Visibility ───────────────────────────────────────────────────────────────

/** Legacy Expert Lab sessions stay out of the main sidebar; expert threads are listed normally. */
export function isSidebarVisibleChat(chat: Chat): boolean {
  return chat.kind !== 'expert-lab';
}

/** True when the chat has unsent composer text persisted on the session row. */
export function hasComposerDraft(chat: Chat): boolean {
  return Boolean(chat.composerDraft?.trim());
}

/**
 * Whether a chat belongs in session rails (desktop / Code / Chat app).
 * Lazy-boot chats keep `history: []` until hydrate — use denormalized `messageCount`
 * so rails are not empty after restart.
 */
export function chatHasListableContent(chat: Chat): boolean {
  if (hasComposerDraft(chat)) return true;
  // A Super Plan chat is the home of a server-side run and never has a
  // transcript of its own; it belongs in the sidebar from the run's start.
  if (chat.superPlanView || chat.superPlanRunId?.trim()) return true;
  if (chat.historyLoaded === false) {
    if (chat.messageCount === undefined) return true;
    return chat.messageCount > 0;
  }
  if (Array.isArray(chat.history) && chat.history.length > 0) return true;
  return false;
}

/** Empty chat with no committed history and no unsent draft (hidden from sidebar lists). */
export function isEphemeralEmptyChat(chat: Chat): boolean {
  return !chatHasListableContent(chat);
}

/**
 * Chats that belong in sidebar session rails: committed turns and/or an unsent draft.
 * Ephemeral empty chats stay out until the user types or sends.
 */
export function isSidebarListedChat(chat: Chat): boolean {
  return isSidebarVisibleChat(chat) && chatHasListableContent(chat);
}

/** Sidebar label for draft-only chats (first line of unsent text, capped). */
export function formatDraftChatSidebarName(chat: Chat): string {
  const draft = chat.composerDraft?.trim() ?? '';
  if (!draft) return 'Draft';
  const firstLine = draft.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const label = firstLine || 'Draft';
  if (label.length <= AUTO_TITLE_MAX_LEN) return label;
  return `${label.slice(0, AUTO_TITLE_MAX_LEN - 1)}…`;
}

/** Board planners and folder-linked chats stay even when still empty. */
function isProtectedFromEphemeralPrune(chat: Chat, state: SessionState): boolean {
  /*
   * A background chat is empty from the moment it is created until its agent
   * reports back (MIN-637). Pruning it in that window would delete the only
   * home the run has — the very thing the dedicated chat exists to prevent.
   */
  if (chat.background === true) return true;
  // A Super Plan chat has no history of its own; pruning it would orphan its run.
  if (chat.superPlanView || chat.superPlanRunId?.trim()) return true;
  if (chat.boardGroupId?.trim() || chat.boardTaskId?.trim()) return true;
  for (const group of state.groups ?? []) {
    if (group.plannerChatId?.trim() === chat.id) return true;
  }
  return false;
}

/** Drop unused ephemeral rows while keeping the active chat and sidebar-listed chats. */
export function pruneEphemeralEmptyChats(state: SessionState, keepChatId: string): void {
  state.chats = state.chats.filter(
    (chat) =>
      chat.id === keepChatId ||
      isProtectedFromEphemeralPrune(chat, state) ||
      !isEphemeralEmptyChat(chat),
  );
}

/** Sidebar / prune ordering: last committed message, else legacy `updatedAt`. */
export function getChatLastMessageAt(chat: Chat): number {
  const last = chat.lastMessageAt;
  if (typeof last === 'number' && Number.isFinite(last) && last > 0) return last;
  const updated = chat.updatedAt;
  return typeof updated === 'number' && Number.isFinite(updated) ? updated : 0;
}

// ── App ids ──────────────────────────────────────────────────────────────────

/** Minnow Code app id stored in `lastActiveChatIdByApp`. */
export const CODE_APP_ID = 'code';

/** Legacy Chat app id — migrated to {@link CODE_APP_ID} on session load. */
export const CHAT_APP_ID = 'chat';

/** Persisted `lastActiveChatIdByApp.desktop` key from the removed desktop chat surface. */
export const DESKTOP_APP_ID = 'desktop';

/** Raw session JSON from disk or API (may be schema v1 or v2). */
export type RawSessionJson = {
  version?: number;
  activeId?: string | null;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  chats?: unknown[];
  lastActiveChatIdByWorkspace?: Record<string, string>;
  lastActiveChatIdByApp?: Record<string, string>;
};

function ensureLastActiveMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === 'string' && typeof value === 'string' && value.trim()) {
      out[normalizeWorkspacePath(key)] = value.trim();
    }
  }
  return out;
}

function ensureLastActiveAppMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    // Removed Calendar / Email apps — drop stored last-active ids for those surfaces.
    if (key.trim() === 'calendar' || key.trim() === 'email') continue;
    out[key.trim()] = value.trim();
  }
  return out;
}

/** Upgrade v1/v2 session JSON to canonical schema v3 in memory. */
export function migrateSessionStateV1ToV2(
  parsed: RawSessionJson,
  coerceChat: (raw: unknown) => Chat,
  seedEmptyChat: () => Chat,
): SessionState {
  const chats = Array.isArray(parsed.chats)
    ? parsed.chats.map((c) => coerceChat(c)).filter(Boolean)
    : [];
  const state: SessionState = {
    version: 6,
    activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
    sidebarCollapsed: !!parsed.sidebarCollapsed,
    lastActiveChatIdByWorkspace: ensureLastActiveMap(parsed.lastActiveChatIdByWorkspace),
    lastActiveChatIdByApp: ensureLastActiveAppMap(parsed.lastActiveChatIdByApp),
    chats: chats.length ? chats : [seedEmptyChat()],
  };
  if (!state.chats.some((c) => c.id === state.activeId)) {
    state.activeId = state.chats[0].id;
  }
  return state;
}

// ── Workspace chats ──────────────────────────────────────────────────────────

/** Chats for the given workspace (newest first); empty workspace key returns none. */
export function getChatsForWorkspace(workspacePath: string, state: SessionState): Chat[] {
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return [];
  return [...state.chats]
    .filter(
      (c) =>
        isSidebarVisibleChat(c) &&
        normalizeWorkspacePath(c.workspacePath ?? '') === key,
    )
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
}

/** Sidebar session rows for a workspace (excludes ephemeral empty chats). */
export function getSidebarListedChatsForWorkspace(
  workspacePath: string,
  state: SessionState,
): Chat[] {
  return getChatsForWorkspace(workspacePath, state).filter(isSidebarListedChat);
}

/** True when the chat belongs to the Minnow Chat app (chats workspace sandbox). */
export function isAssistantChat(chat: Chat, chatsWorkspacePath: string): boolean {
  const key = normalizeWorkspacePath(chatsWorkspacePath);
  if (!key) return false;
  return normalizeWorkspacePath(chat.workspacePath ?? '') === key;
}

/** Chats bound to the chats workspace (newest first). */
export function getChatsForChatsWorkspace(
  state: SessionState,
  chatsWorkspacePath: string,
): Chat[] {
  const key = normalizeWorkspacePath(chatsWorkspacePath);
  if (!key) return [];
  return [...state.chats]
    .filter(
      (c) => normalizeWorkspacePath(c.workspacePath ?? '') === key,
    )
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
}

/** Sidebar session rows for the chats workspace (excludes ephemeral empty chats). */
export function getSidebarListedAssistantChats(
  state: SessionState,
  chatsWorkspacePath: string,
): Chat[] {
  return getChatsForChatsWorkspace(state, chatsWorkspacePath).filter(isSidebarListedChat);
}

/** Sidebar-visible assistant chats for the chats workspace (newest first). */
export function getAssistantChats(state: SessionState, chatsWorkspacePath: string): Chat[] {
  return getSidebarListedAssistantChats(state, chatsWorkspacePath);
}

/** Remember the last active chat for a Minnow app (e.g. Chat). */
export function rememberActiveChatForApp(
  state: SessionState,
  appId: string,
  chatId: string,
): void {
  const id = appId.trim();
  const chat = chatId.trim();
  if (!id || !chat) return;
  if (!state.lastActiveChatIdByApp) {
    state.lastActiveChatIdByApp = {};
  }
  state.lastActiveChatIdByApp[id] = chat;
}

/** Read the remembered active chat id for a Minnow app. */
export function getLastActiveChatIdForApp(state: SessionState, appId: string): string | undefined {
  const id = appId.trim();
  if (!id) return undefined;
  return state.lastActiveChatIdByApp?.[id];
}

// ── Assistant chats ──────────────────────────────────────────────────────────

/** New assistant chat defaults for the Chat app (general mode, chats workspace). */
export function createAssistantChat(
  chatsWorkspacePath: string,
  chatId: string,
  modelId = '',
): Chat {
  const now = Date.now();
  return {
    id: chatId,
    name: PLACEHOLDER_CHAT_NAME,
    workspacePath: normalizeWorkspacePath(chatsWorkspacePath),
    modelId: modelId || '',
    modeId: 'general',
    workAgentAuto: true,
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: now,
    lastMessageAt: now,
  };
}

/**
 * Pick the active assistant chat: remembered app id, else newest assistant chat,
 * else create a new assistant chat bound to the chats workspace.
 */
export function resolveActiveAssistantChatId(
  chatsWorkspacePath: string,
  state: SessionState,
  createScopedAssistantChat: (chatsWorkspacePath: string) => Chat,
  appId: string = CHAT_APP_ID,
): string {
  const key = normalizeWorkspacePath(chatsWorkspacePath);
  if (!key) {
    const fresh = createScopedAssistantChat('');
    state.chats.unshift(fresh);
    const now = Date.now();
    fresh.updatedAt = now;
    fresh.lastMessageAt = now;
    return fresh.id;
  }

  const remembered = getLastActiveChatIdForApp(state, appId);
  if (remembered) {
    const chat = state.chats.find(
      (c) => c.id === remembered && isAssistantChat(c, key),
    );
    if (chat) return chat.id;
  }

  const scoped = getAssistantChats(state, key);
  if (scoped.length) return scoped[0].id;

  const fresh = createScopedAssistantChat(key);
  state.chats.unshift(fresh);
  const now = Date.now();
  fresh.updatedAt = now;
  fresh.lastMessageAt = now;
  return fresh.id;
}

/** Legacy or unscoped chats (`workspacePath === ''`), newest first. */
export function getUnassignedChats(state: SessionState): Chat[] {
  return [...state.chats]
    .filter(
      (c) =>
        isSidebarListedChat(c) &&
        normalizeWorkspacePath(c.workspacePath ?? '') === '',
    )
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
}

/**
 * Start a new empty chat when the user opens or switches into a project workspace.
 * Avoids restoring the last Orchestrate planner or board-linked session.
 */
export function createFreshChatIdForWorkspaceEntry(
  workspacePath: string,
  state: SessionState,
  fallbackModelId: string,
  createScopedEmptyChat: (modelId: string, workspaceKey: string) => Chat,
): string {
  const key = normalizeWorkspacePath(workspacePath);
  const fresh = createScopedEmptyChat(fallbackModelId, key);
  state.chats.unshift(fresh);
  const now = Date.now();
  fresh.updatedAt = now;
  fresh.lastMessageAt = now;
  return fresh.id;
}

// ── Resolve active ───────────────────────────────────────────────────────────

/**
 * Pick the active chat id for a workspace: remembered id, else newest scoped chat,
 * else create a new empty chat bound to that workspace.
 */
export function resolveActiveChatIdForWorkspace(
  workspacePath: string,
  state: SessionState,
  fallbackModelId: string,
  createScopedEmptyChat: (modelId: string, workspaceKey: string) => Chat,
): string {
  const key = normalizeWorkspacePath(workspacePath);
  const map = state.lastActiveChatIdByWorkspace ?? {};
  const remembered = map[key];
  if (remembered) {
    const chat = state.chats.find(
      (c) =>
        c.id === remembered &&
        isSidebarVisibleChat(c) &&
        normalizeWorkspacePath(c.workspacePath ?? '') === key,
    );
    if (chat) return chat.id;
  }

  const scoped = getSidebarListedChatsForWorkspace(key, state);
  if (scoped.length) return scoped[0]!.id;

  const fresh = createScopedEmptyChat(fallbackModelId, key);
  state.chats.unshift(fresh);
  const now = Date.now();
  fresh.updatedAt = now;
  fresh.lastMessageAt = now;
  return fresh.id;
}

/** Minimal chat coerce for migration unit tests (workspacePath only). */
export function coerceChatWorkspaceFields(raw: unknown): Chat {
  if (!raw || typeof raw !== 'object') {
    return {
      id: 'test-id',
      name: PLACEHOLDER_CHAT_NAME,
      workspacePath: '',
      modelId: '',
      modeId: DEFAULT_MODE_ID,
      history: [],
      lastStats: null,
      modelInfo: {},
      updatedAt: Date.now(),
    };
  }
  const row = raw as Partial<Chat>;
  return {
    id: typeof row.id === 'string' && row.id ? row.id : 'test-id',
    name:
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : PLACEHOLDER_CHAT_NAME,
    workspacePath:
      typeof row.workspacePath === 'string'
        ? normalizeWorkspacePath(row.workspacePath)
        : '',
    modelId: typeof row.modelId === 'string' ? row.modelId : '',
    modeId: normalizeModeId(row.modeId),
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
    lastMessageAt:
      typeof row.lastMessageAt === 'number'
        ? row.lastMessageAt
        : typeof row.updatedAt === 'number'
          ? row.updatedAt
          : Date.now(),
  };
}
