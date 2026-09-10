import { PLACEHOLDER_CHAT_NAME, SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS, STORAGE_KEY } from '../constants';
import { abortChatTitleGeneration } from '../chat/titles/inflight';
import { cleanupChatWorktreeOnDelete } from './chat-worktree';
import { isPlaceholderChatName } from '../chat/titles/placeholder';
import { setSaveTimer, saveTimer, streamingChatIds } from '../app-state';
import {
  flushSessionsOnShutdown,
  getChatHistory,
  getSessions,
  getSessionSummaries,
  patchSessions,
  putSessions,
  SessionsRevisionConflictError,
  type SessionsPatchDelta,
} from '../config/api-client';
import { defaultSessionState } from '../config/defaults';
import { randomUUID } from '../lib/random-id.ts';
import { isServerStorageMode } from '../config/storage-mode';
import { DEFAULT_MODE_ID, normalizeModeId } from '../chat/modes/types';
import { normalizeOrchestratePlanPath } from '../chat/plans/plan-path';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isMinnowSandboxWorkspacePath } from '../lib/workspace-sandbox';
import { paintChatHistoryPendingInForegroundShell } from '../ui/messages';
import { notifySessionCreated } from '../webhooks/client';
import { decodeModelSelectKey } from '../lib/model-select-key';
import {
  CHAT_APP_ID,
  CODE_APP_ID,
  createAssistantChat,
  getAssistantChats as filterAssistantChats,
  getChatsForChatsWorkspace as filterChatsForChatsWorkspace,
  getChatLastMessageAt,
  getChatsForWorkspace as filterChatsForWorkspace,
  getSidebarListedChatsForWorkspace as filterSidebarListedChatsForWorkspace,
  getLastActiveChatIdForApp,
  getUnassignedChats as filterUnassignedChats,
  isEphemeralEmptyChat,
  isSidebarListedChat,
  pruneEphemeralEmptyChats,
  formatDraftChatSidebarName,
  migrateSessionStateV1ToV2 as migrateSessionJsonToV2,
  rememberActiveChatForApp as rememberActiveChatForAppInState,
  resolveActiveAssistantChatId,
  resolveActiveChatIdForWorkspace as pickActiveChatIdForWorkspace,
  createFreshChatIdForWorkspaceEntry as pickFreshChatIdForWorkspaceEntry,
  type RawSessionJson,
} from './session-workspace-scope';
import { getForegroundAppId } from '../os/instances';
import { isChatAppForeground } from '../ui/chat-mount';
import { setStatus } from '../ui/status';
import { ensureTokenLedger } from '../usage/token-ledger';
import { getWorkspacePath } from './workspace';
import { getRouterConfigSync } from '../models/routers';
import { MAX_GOAL_CONDITION_CHARS } from '../chat/goal/parse-command';
import {
  INITIAL_LOOP_AUTO_DELAY_MS,
  MAX_LOOP_PROMPT_CHARS,
  MIN_LOOP_INTERVAL_MS,
} from '../chat/loop/parse-command';
import { resolveActiveWorkAgent } from '../agents/resolve-work-agent';
import { cleanupChatArchiveOnDelete } from '../chat/archive/cleanup';
import { resolveChatWorktreeRoot } from './chat-worktree';
import {
  ensureChatCodeChangeBackfillOnSwitch,
  runSessionCodeChangeBackfill,
} from '../usage/code-change-backfill';
import type { ExpertChatSeed } from '../chat/experts/runtime-profile';
import {
  normalizeChatRow,
  normalizeGroupRow,
} from './session-schema.mjs';
import type {
  ActiveGoalState,
  ActiveLoopState,
  Chat,
  ChatGroup,
  ChatSummary,
  ChatTodo,
  ExpertSelection,
  Message,
  SessionState,
  SessionSummariesState,
} from '../types';
import { SESSION_SCHEMA_VERSION } from '../types';

// ── Dirty tracking ───────────────────────────────────────────────────────────

const GENERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Normalize persisted backend generation id (invalid values are dropped). */
function ensureCurrentGenerationId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim();
  return GENERATION_ID_RE.test(id) ? id : undefined;
}

/**
 * Drop generation ids that cannot still be in-flight (finished assistant already saved).
 * Skips chats whose history is not loaded yet (lazy boot) — re-run after ensure.
 */
export function clearStaleGenerationIdsOnLoad(chats: Chat[]): void {
  for (const chat of chats) {
    const id = ensureCurrentGenerationId(chat.currentGenerationId);
    if (!id) {
      if (chat.currentGenerationId != null) {
        delete chat.currentGenerationId;
      }
      continue;
    }
    chat.currentGenerationId = id;
    if (chat.historyLoaded === false) continue;
    const last = chat.history[chat.history.length - 1];
    if (last?.role === 'assistant') {
      const text = typeof last.content === 'string' ? last.content.trim() : '';
      if (text.length > 0) {
        delete chat.currentGenerationId;
      }
    }
  }
}

const MAX_CHAT_TODO_ITEMS = 20;
const MAX_CHAT_TODO_TEXT_CHARS = 140;

function normalizeChatTodoStatus(raw: unknown): ChatTodo['status'] {
  if (raw === 'completed' || raw === 'in_progress' || raw === 'pending') return raw;
  return 'pending';
}

/** In-memory session blob mirrored to ~/.minnow or localStorage fallback. */
export let sessionState: SessionState | null = null;

/**
 * Set after a successful GET from ~/.minnow. Blocks PUT until hydration so a boot-time
 * localStorage fallback cannot clobber on-disk sessions (MIN-408).
 */
let sessionsHydratedFromServer = false;

/**
 * Store revision this client last read or wrote. Echoed on every write so a second
 * window (or a restart racing the old process) gets a 409 instead of overwriting.
 * `null` means unknown — writes then skip the check rather than block.
 */
let sessionRevision: number | null = null;

/** Dirty chat ids since last successful flush (B.2 PATCH payload). */
const dirtyChatIds = new Set<string>();
/**
 * Ids the whole-state PATCH fallback marked dirty purely to describe the session, not because
 * anything in them changed. Their `history` is omitted so a 60 MB "incremental" PATCH cannot
 * happen (MIN-794); the server reads a missing `history` as "preserve".
 */
const patchHistoryOmittedChatIds = new Set<string>();

/** Mark a chat id dirty for the next PATCH; any real edit cancels the history-omit shortcut. */
function addDirtyChatId(chatId: string): void {
  dirtyChatIds.add(chatId);
  patchHistoryOmittedChatIds.delete(chatId);
  // A real edit landed on a row the describe only meant to restate, so it is no
  // longer safe to drop on a conflict.
  describeOnlyChatIds.delete(chatId);
  // This chat no longer claims to be clean, so it is not the verifier's business.
  dirtyTrackingShadow.delete(chatId);
}
/** Explicit chat deletes since last successful flush. */
const deletedChatIds = new Set<string>();
/** Dirty sidebar/board group ids since last successful flush. */
const dirtyGroupIds = new Set<string>();
/** Explicit group deletes since last successful flush (PATCH deleteGroupIds). */
const deletedGroupIds = new Set<string>();
/**
 * Rows the last whole-state describe added purely to describe the session — no
 * local edit backs them, so they are exactly the rows another window may own.
 * See {@link markEveryChatDirty} and {@link dropWholeStateDescribe}.
 */
const describeOnlyChatIds = new Set<string>();
const describeOnlyGroupIds = new Set<string>();
/** Session scalars (activeId, sidebar, maps, …) changed since last successful flush. */
let sessionScalarsDirty = false;
/**
 * Bumped on every dirty-set mutation. A flush only clears dirty sets when the epoch
 * is unchanged — otherwise an overlapping older PUT/PATCH could drop a delete that
 * landed mid-flight and resurrect the chat on disk.
 */
let sessionDirtyEpoch = 0;
/** When true, run another {@link saveSessionsNow} after the in-flight flush settles. */
let sessionSaveQueued = false;
/** Wall clock when the current save debounce window opened (max-wait throttle). */
let saveFirstScheduledAt = 0;
/**
 * Per-chat hash after the last baseline pass — used by the B.1/B.2 DEV verifier to catch
 * mutations that bypassed {@link touchChat}. A hash rather than a retained 60 MB JSON blob,
 * and only a rolling window of chats per save: the old whole-list form cost ~1.2 s per chat
 * switch at 556 chats and grew with history forever (MIN-794).
 */
const dirtyTrackingShadow = new Map<string, string>();
/** Round-robin position in `state.chats` so successive saves sweep the whole list. */
let dirtyTrackingCursor = 0;
/**
 * Chats baselined (and therefore checked) per save. Production runs a small sample too: an
 * unmarked mutation there is silently never persisted, and the check repairs it (MIN-794).
 */
const DIRTY_TRACKING_SAMPLE_DEV = 64;
const DIRTY_TRACKING_SAMPLE_PROD = 8;
/** When true, flush runs the unmarked-mutation verifier (tests / Vite DEV). */
let dirtyTrackingVerifierForced = false;
/**
 * B.2 flag: when true (default), server-mode flush uses PATCH once dirty sets are trusted.
 * Full-PUT fallback when dirty sets are unavailable (first save after load, or verifier miss).
 */
let sessionsClientPatchEnabled = true;
/**
 * C.2 flag: when true, boot loads chat summaries and fetches history on demand.
 * Default ON — whole-blob GET only when explicitly flipped off in tests.
 */
let sessionsLazyHistoryEnabled = true;
/**
 * False after load / verifier miss — next successful full PUT establishes a trusted baseline
 * so subsequent flushes may PATCH.
 */
let sessionPatchDirtySetsReady = false;

/** In-flight `ensureChatHistoryLoaded` promises keyed by chat id (concurrent dedupe). */
const historyLoadInflight = new Map<string, Promise<void>>();
/** When true, install the unloaded-history DEV trap even outside Vite DEV (unit tests). */
let historyTrapForcedForTests = false;

function isViteDevBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
}

function shouldInstallHistoryTrap(): boolean {
  return sessionsLazyHistoryEnabled && (historyTrapForcedForTests || isViteDevBuild());
}

/** Dev sweeps the list fast enough to be a diagnostic; production only needs the repair. */
function dirtyTrackingSampleSize(): number {
  return dirtyTrackingVerifierForced || isViteDevBuild()
    ? DIRTY_TRACKING_SAMPLE_DEV
    : DIRTY_TRACKING_SAMPLE_PROD;
}

/** Copy chat fields for wire/shadow serialization without tripping lazy-history traps. */
function copyChatFieldsWithoutLazyHistory(chat: Chat, includeHistory: boolean): Record<string, unknown> {
  const omit = new Set(['historyLoaded', 'messageCount']);
  if (!includeHistory) omit.add('history');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(chat)) {
    if (omit.has(key)) continue;
    out[key] = (chat as unknown as Record<string, unknown>)[key];
  }
  return out;
}

/** Serialize chats for dirty-tracking without reading lazy-unloaded history bodies. */
function chatForDirtyTrackingShadow(chat: Chat): Record<string, unknown> {
  return copyChatFieldsWithoutLazyHistory(chat, chat.historyLoaded !== false);
}

/** FNV-1a over the serialized chat — comparable without keeping the string alive. */
function hashChatForDirtyTracking(chat: Chat): string {
  const json = JSON.stringify(chatForDirtyTrackingShadow(chat));
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${json.length}:${(h >>> 0).toString(36)}`;
}

/** Baseline the next window of chats so the following flush can check them. */
function captureDirtyTrackingShadow(state: SessionState | null): void {
  // Never every chat: that JSON.stringify'd every hydrated transcript on every flush (MIN-584).
  if (!state) {
    dirtyTrackingShadow.clear();
    dirtyTrackingCursor = 0;
    return;
  }
  const chats = state.chats;
  if (chats.length === 0) {
    dirtyTrackingShadow.clear();
    dirtyTrackingCursor = 0;
    return;
  }
  if (dirtyTrackingCursor >= chats.length) dirtyTrackingCursor = 0;
  const count = Math.min(dirtyTrackingSampleSize(), chats.length);
  for (let n = 0; n < count; n += 1) {
    const chat = chats[(dirtyTrackingCursor + n) % chats.length];
    if (!chat) continue;
    // A chat already marked dirty proves nothing about tracking; skip the serialization.
    if (dirtyChatIds.has(chat.id)) continue;
    dirtyTrackingShadow.set(chat.id, hashChatForDirtyTracking(chat));
  }
  dirtyTrackingCursor = (dirtyTrackingCursor + count) % chats.length;
}

function clearSessionDirtySets(): void {
  dirtyChatIds.clear();
  patchHistoryOmittedChatIds.clear();
  deletedChatIds.clear();
  dirtyGroupIds.clear();
  deletedGroupIds.clear();
  describeOnlyChatIds.clear();
  describeOnlyGroupIds.clear();
  sessionScalarsDirty = false;
}

/** Record that dirty sets changed so in-flight flushes must not clear newer work. */
function bumpSessionDirtyEpoch(): void {
  sessionDirtyEpoch += 1;
}

/** True when any dirty marker would produce a non-empty PATCH. */
function hasSessionDirtyWork(): boolean {
  return (
    dirtyChatIds.size > 0 ||
    deletedChatIds.size > 0 ||
    dirtyGroupIds.size > 0 ||
    deletedGroupIds.size > 0 ||
    sessionScalarsDirty
  );
}

/** Mark session-level scalars dirty for the next PATCH. */
export function markSessionScalarsDirty(): void {
  sessionScalarsDirty = true;
  bumpSessionDirtyEpoch();
}

/** Mark a sidebar/board group dirty for the next PATCH upsert. */
export function markGroupDirty(groupId: string): void {
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  if (!id) return;
  deletedGroupIds.delete(id);
  dirtyGroupIds.add(id);
  describeOnlyGroupIds.delete(id);
  bumpSessionDirtyEpoch();
}

/** Mark a group deleted for PATCH `deleteGroupIds` (not a dirty upsert). */
export function markGroupDeleted(groupId: string): void {
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  if (!id) return;
  dirtyGroupIds.delete(id);
  deletedGroupIds.add(id);
  bumpSessionDirtyEpoch();
}

/**
 * Dev/test verifier: warn when a chat stringified differently without touchChat.
 * @returns true when an unmarked mutation was detected (dirty sets untrusted → full PUT).
 */
function verifyDirtyChatTracking(state: SessionState): boolean {
  if (dirtyTrackingShadow.size === 0) return false;
  let missed = false;
  for (const chat of state.chats) {
    const prev = dirtyTrackingShadow.get(chat.id);
    if (prev === undefined) continue;
    // Marking it dirty already cleared the entry, so anything left here claims to be clean.
    dirtyTrackingShadow.delete(chat.id);
    if (dirtyChatIds.has(chat.id)) continue;
    if (prev !== hashChatForDirtyTracking(chat)) {
      missed = true;
      // Repair rather than only report: production trusts the dirty set, so an unmarked
      // mutation is otherwise never sent to the server at all — a silent lost edit.
      addDirtyChatId(chat.id);
      if (dirtyTrackingVerifierForced || isViteDevBuild()) {
        console.warn(
          `[sessions dirty-tracking] chat ${chat.id} changed without touchChat()`,
        );
      }
    }
  }
  return missed;
}

/**
 * Serialize one chat for PATCH/PUT when history may still be lazy-unloaded (C.2).
 * Omits `history` so the server preserves existing message rows instead of syncing [].
 */
export function chatForSessionsWire(chat: Chat): Chat {
  return copyChatFieldsWithoutLazyHistory(chat, chat.historyLoaded !== false) as unknown as Chat;
}

/** Clone session state for wire I/O, stripping unloaded chat histories. */
export function sessionStateForSessionsWire(state: SessionState): SessionState {
  return {
    ...state,
    chats: state.chats.map(chatForSessionsWire),
  };
}

/** Build a PATCH delta from the current dirty sets (full dirty chats/groups). */
export function buildSessionsPatchDelta(state: SessionState): SessionsPatchDelta {
  const delta: SessionsPatchDelta = {
    baseVersion: state.version ?? SESSION_SCHEMA_VERSION,
  };

  if (dirtyChatIds.size > 0) {
    const byId = new Map(state.chats.map((c) => [c.id, c]));
    const chats: Chat[] = [];
    for (const id of dirtyChatIds) {
      if (deletedChatIds.has(id)) continue;
      const chat = byId.get(id);
      if (!chat) continue;
      chats.push(
        patchHistoryOmittedChatIds.has(id)
          ? (copyChatFieldsWithoutLazyHistory(chat, false) as unknown as Chat)
          : chatForSessionsWire(chat),
      );
    }
    if (chats.length) delta.chats = chats;
  }

  if (deletedChatIds.size > 0) {
    delta.deleteChatIds = [...deletedChatIds];
  }

  if (dirtyGroupIds.size > 0) {
    const byId = new Map((state.groups ?? []).map((g) => [g.id, g]));
    const groups: ChatGroup[] = [];
    for (const id of dirtyGroupIds) {
      if (deletedGroupIds.has(id)) continue;
      const group = byId.get(id);
      if (group) groups.push(group);
    }
    if (groups.length) delta.groups = groups;
  }

  if (deletedGroupIds.size > 0) {
    delta.deleteGroupIds = [...deletedGroupIds];
  }

  if (sessionScalarsDirty) {
    const scalars: Record<string, unknown> = {
      version: state.version ?? SESSION_SCHEMA_VERSION,
      activeId: typeof state.activeId === 'string' ? state.activeId : '',
      sidebarCollapsed: !!state.sidebarCollapsed,
      lastActiveChatIdByWorkspace: state.lastActiveChatIdByWorkspace ?? {},
      lastActiveChatIdByApp: state.lastActiveChatIdByApp ?? {},
    };
    scalars.sidebarWidth = state.sidebarWidth ?? null;
    scalars.activeBoardGroupId = state.activeBoardGroupId ?? null;
    scalars.lastBoardGroupId = state.lastBoardGroupId ?? null;
    if (state.codeChangeTotalsByWorkspace) {
      scalars.codeChangeTotalsByWorkspace = state.codeChangeTotalsByWorkspace;
    }
    delta.scalars = scalars;
  }

  return delta;
}

/** Test helper: dirty set snapshot for B.2 PATCH. */
export function getSessionDirtyTrackingForTests(): {
  dirtyChatIds: string[];
  deletedChatIds: string[];
  dirtyGroupIds: string[];
  deletedGroupIds: string[];
  sessionScalarsDirty: boolean;
  sessionPatchDirtySetsReady: boolean;
  sessionsClientPatchEnabled: boolean;
} {
  return {
    dirtyChatIds: [...dirtyChatIds].sort(),
    deletedChatIds: [...deletedChatIds].sort(),
    dirtyGroupIds: [...dirtyGroupIds].sort(),
    deletedGroupIds: [...deletedGroupIds].sort(),
    sessionScalarsDirty,
    sessionPatchDirtySetsReady,
    sessionsClientPatchEnabled,
  };
}

/** Test helper: toggle B.2 client PATCH flag (`sessionsClientPatchEnabled`, default ON). */
export function setSessionsClientPatchEnabledForTests(enabled: boolean): void {
  sessionsClientPatchEnabled = enabled;
}

/** Test helper: toggle C.2 lazy-history flag (`sessionsLazyHistoryEnabled`, default ON). */
export function setSessionsLazyHistoryEnabledForTests(enabled: boolean): void {
  sessionsLazyHistoryEnabled = enabled;
}

/** Whether lazy history loading is enabled (C.2; default true). */
export function isSessionsLazyHistoryEnabled(): boolean {
  return sessionsLazyHistoryEnabled;
}

/** Test helper: force the unloaded-history DEV trap on/off (tsx has no import.meta.env.DEV). */
export function setHistoryTrapForcedForTests(forced: boolean): void {
  historyTrapForcedForTests = forced;
}

/**
 * Test helper: mark a chat unloaded and attach the DEV history trap (requires flag + trap force).
 */
export function attachUnloadedHistoryTrapForTests(chat: Chat): void {
  chat.historyLoaded = false;
  if (!Array.isArray(chat.history)) chat.history = [];
  installUnloadedHistoryTrap(chat);
}

/** Test helper: mark dirty sets trusted (or force full-PUT fallback). */
export function setSessionPatchDirtySetsReadyForTests(ready: boolean): void {
  sessionPatchDirtySetsReady = ready;
}

/** Test helper: force verifier on/off regardless of import.meta.env.DEV. */
export function setDirtyTrackingVerifierForcedForTests(forced: boolean): void {
  dirtyTrackingVerifierForced = forced;
}

/** Test helper: re-capture shadow without flushing. */
export function captureDirtyTrackingShadowForTests(): void {
  captureDirtyTrackingShadow(sessionState);
}

/** Test helper: number of chats currently baselined (0 when the verifier is off). */
export function getDirtyTrackingShadowSizeForTests(): number {
  return dirtyTrackingShadow.size;
}

// ── Session ready ────────────────────────────────────────────────────────────

let sessionPersistenceShutdownRegistered = false;
/** In-flight server PATCH/PUT so tests can await dirty-set clear after success. */
let inFlightSessionSave: Promise<void> | null = null;

/** Resolves once `loadSessionsFromStorage()` has populated `sessionState`. */
let resolveSessionsReady: () => void = () => undefined;
export const sessionsReady: Promise<void> = new Promise((resolve) => {
  resolveSessionsReady = resolve;
});

/** No-op when sessions are already loaded; otherwise waits for boot `initApp`. */
export async function ensureSessionsReady(): Promise<void> {
  if (sessionState) return;
  await sessionsReady;
}

function markSessionsReady(): void {
  resolveSessionsReady();
}

/** Replace in-memory session blob (unit tests). */
export function setSessionStateForTests(state: SessionState | null): void {
  sessionState = state;
  clearSessionDirtySets();
  captureDirtyTrackingShadow(state);
  if (state) {
    markSessionsReady();
    sessionsHydratedFromServer = true;
    sessionPatchDirtySetsReady = true;
  } else {
    sessionsHydratedFromServer = false;
    sessionPatchDirtySetsReady = false;
  }
}

/** Reset persistence guards between unit tests. */
export function resetSessionPersistenceForTests(): void {
  sessionsHydratedFromServer = false;
  sessionPersistenceShutdownRegistered = false;
  clearSessionDirtySets();
  dirtyTrackingShadow.clear();
  dirtyTrackingCursor = 0;
  dirtyTrackingVerifierForced = false;
  sessionsClientPatchEnabled = true;
  sessionsLazyHistoryEnabled = true;
  historyTrapForcedForTests = false;
  sessionPatchDirtySetsReady = false;
  inFlightSessionSave = null;
  sessionSaveQueued = false;
  sessionDirtyEpoch = 0;
  historyLoadInflight.clear();
  if (saveTimer) {
    clearTimeout(saveTimer);
    setSaveTimer(null);
  }
  saveFirstScheduledAt = 0;
}

/** Await the in-flight server PATCH/PUT started by {@link saveSessionsNow} (tests). */
export async function waitForSessionSaveForTests(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    if (!inFlightSessionSave) {
      if (!sessionSaveQueued) return;
      saveSessionsNow();
    }
    await inFlightSessionSave;
  }
}

/** Expose hydration guard for persistence unit tests. */
export function isSessionsHydratedFromServerForTests(): boolean {
  return sessionsHydratedFromServer;
}

export type SaveSessionsResult = 'ok' | 'quota_exceeded';

export interface RemoveChatResult {
  ok: boolean;
  removed?: Chat;
  /** True when the main column should reload the active chat. */
  activeChanged: boolean;
  activeChat: Chat;
}

function requireSessionState(): SessionState {
  if (!sessionState) {
    throw new Error('sessionState is not initialized; call loadSessionsFromStorage() first');
  }
  return sessionState;
}

// ── Chat objects ─────────────────────────────────────────────────────────────

export function newChatId(): string {
  return randomUUID();
}

export function createEmptyChatObject(modelId: string, workspacePath?: string): Chat {
  const boundWorkspace =
    workspacePath !== undefined
      ? normalizeWorkspacePath(workspacePath)
      : normalizeWorkspacePath(getWorkspacePath());
  return {
    id: newChatId(),
    name: PLACEHOLDER_CHAT_NAME,
    workspacePath: boundWorkspace,
    modelId: modelId || '',
    modeId: DEFAULT_MODE_ID,
    workAgentId: null,
    workAgentAuto: true,
    history: [],
    historyLoaded: true,
    lastStats: null,
    modelInfo: {},
    updatedAt: Date.now(),
    lastMessageAt: Date.now(),
  };
}

/** True when `history` is safe to read/mutate without a lazy fetch. */
export function isChatHistoryLoaded(chat: Chat): boolean {
  return chat.historyLoaded !== false;
}

/** Message count without tripping the lazy-history dev trap (sidebar/listing safe). */
export function getChatMessageCount(chat: Chat): number {
  if (chat.historyLoaded === false) {
    return typeof chat.messageCount === 'number' ? chat.messageCount : 0;
  }
  return chat.history.length;
}

/**
 * Throw when history is not loaded — use at highest-risk mutators (category-3).
 * Prefer {@link ensureChatHistoryLoaded} before calling this on the flag-on path.
 */
export function requireHistory(chat: Chat): Message[] {
  if (chat.historyLoaded === false) {
    throw new Error(
      `Chat history not loaded for ${chat.id}; await ensureChatHistoryLoaded(chatId) first`,
    );
  }
  return chat.history;
}

/**
 * Inflate a {@link ChatSummary} into a Chat placeholder (empty history).
 * Spreads cold meta_json fields + non-message children from the summary payload (C.2).
 */
export function chatSummaryToChat(summary: ChatSummary): Chat {
  const {
    messageCount: rawMessageCount,
    lastMessagePreview: _lastMessagePreview,
    sortIndex: _sortIndex,
    historyDigest: _historyDigest,
    ...cold
  } = summary as ChatSummary & Record<string, unknown>;
  void _lastMessagePreview;
  void _sortIndex;
  void _historyDigest;

  const messageCount =
    typeof rawMessageCount === 'number' && Number.isFinite(rawMessageCount)
      ? Math.max(0, Math.floor(rawMessageCount))
      : 0;

  const chat: Chat = {
    ...(cold as Partial<Chat>),
    id: summary.id,
    name: summary.name || PLACEHOLDER_CHAT_NAME,
    workspacePath: summary.workspacePath ?? '',
    modelId: summary.modelId ?? '',
    history: [],
    historyLoaded: false,
    messageCount,
    lastStats: (cold as Partial<Chat>).lastStats ?? null,
    modelInfo: (cold as Partial<Chat>).modelInfo ?? {},
    updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : Date.now(),
  };
  return chat;
}

/**
 * Dev-only trap: first `history` read while unloaded logs an error + stack, then returns [].
 * Active when lazy-history flag is on and Vite DEV (or {@link setHistoryTrapForcedForTests}).
 */
function installUnloadedHistoryTrap(chat: Chat): void {
  if (!shouldInstallHistoryTrap()) return;
  if (chat.historyLoaded !== false) return;

  let store: Message[] = Array.isArray(chat.history) ? chat.history : [];
  let warned = false;
  Object.defineProperty(chat, 'history', {
    configurable: true,
    enumerable: true,
    get() {
      if (chat.historyLoaded === false && !warned) {
        warned = true;
        console.error(
          `[sessions] chat.history read before ensureChatHistoryLoaded (${chat.id})`,
          new Error().stack,
        );
      }
      return store;
    },
    set(value: Message[]) {
      store = Array.isArray(value) ? value : [];
    },
  });
}

/**
 * Merge the fetched transcript into the placeholder and clear the unload marker.
 *
 * A send can land while ensureChatHistoryLoaded is still in flight — hitting
 * Continue on a chat the lazy boot never hydrated does exactly that. The rows the
 * running turn appended live only in the local array, so overwriting it with the
 * server payload left the bubbles on screen while `buildApiMessages` replayed a
 * transcript that no longer contained them. Splice the local tail onto the fetched
 * history instead of choosing one side and dropping the other.
 */
function materializeChatHistory(chat: Chat, messages: Message[]): void {
  const desc = Object.getOwnPropertyDescriptor(chat, 'history');
  if (desc && (desc.get || desc.set)) {
    delete (chat as { history?: Message[] }).history;
  }
  const incoming = Array.isArray(messages) ? messages : [];
  const current = Array.isArray(chat.history) ? chat.history : [];

  chat.history = current.length > 0 ? [...incoming, ...current] : incoming;
  chat.historyLoaded = true;
  chat.messageCount = chat.history.length;
  if (current.length > 0) {
    touchChat(chat);
  }
  if (sessionState) {
    captureDirtyTrackingShadow(sessionState);
  }
}

/** Mark every chat as fully loaded (whole-blob boot / flag-off path). */
function markAllHistoriesLoaded(chats: Chat[]): void {
  for (const chat of chats) {
    chat.historyLoaded = true;
  }
}

/**
 * Build SessionState from GET /api/config/sessions/summaries (flag-on boot).
 * Chats start with `history: []` and `historyLoaded: false`.
 */
function sessionStateFromSummaries(remote: SessionSummariesState): SessionState {
  const inflatedChats = remote.chats.map((summary) => chatSummaryToChat(summary));
  const raw = {
    version: remote.version ?? SESSION_SCHEMA_VERSION,
    activeId: remote.activeId,
    sidebarCollapsed: remote.sidebarCollapsed,
    chats: inflatedChats,
    groups: remote.groups,
    activeBoardGroupId: remote.activeBoardGroupId,
    lastBoardGroupId: remote.lastBoardGroupId,
    lastActiveChatIdByWorkspace: remote.lastActiveChatIdByWorkspace,
    lastActiveChatIdByApp: remote.lastActiveChatIdByApp,
    sidebarWidth: remote.sidebarWidth,
    codeChangeTotalsByWorkspace: remote.codeChangeTotalsByWorkspace,
  } as RawSessionJson;
  const state = parseSessionStateFromJson(raw);
  const summaryById = new Map(remote.chats.map((s) => [s.id, s]));
  for (const chat of state.chats) {
    const summary = summaryById.get(chat.id);
    if (!summary) {
      chat.historyLoaded = true;
      continue;
    }
    chat.historyLoaded = false;
    if (!Array.isArray(chat.history)) chat.history = [];
    const count = summary.messageCount;
    chat.messageCount =
      typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    installUnloadedHistoryTrap(chat);
  }
  return state;
}

/**
 * Idempotent lazy history fetch. Concurrent callers for the same id share one in-flight Promise.
 * No-op when the lazy-history flag is off or the chat is already loaded / missing.
 */
export async function ensureChatHistoryLoaded(chatId: string): Promise<void> {
  const id = typeof chatId === 'string' ? chatId.trim() : '';
  if (!id) return;
  if (!sessionsLazyHistoryEnabled) return;

  const chat = findChatById(id);
  if (!chat || chat.historyLoaded !== false) return;

  const existing = historyLoadInflight.get(id);
  if (existing) return existing;

  const loadPromise = (async () => {
    if (!isServerStorageMode()) {
      const local = findChatById(id);
      if (local) local.historyLoaded = true;
      return;
    }
    const messages = await getChatHistory(id);
    const target = findChatById(id);
    if (!target || target.historyLoaded !== false) return;
    materializeChatHistory(target, messages);
  })().finally(() => {
    historyLoadInflight.delete(id);
  });

  historyLoadInflight.set(id, loadPromise);
  return loadPromise;
}


function ensureGroupsFromRaw(raw: unknown): ChatGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatGroup[] = [];
  for (const item of raw) {
    const group = normalizeGroupRow(item) as ChatGroup | null;
    if (group) out.push(group);
  }
  return out;
}

/** Test helper: hydrate sidebar groups from persisted session JSON. */
export function hydrateSessionGroupsForTests(raw: unknown): ChatGroup[] {
  return ensureGroupsFromRaw(raw);
}

// ── Migrations ───────────────────────────────────────────────────────────────

/** Move legacy chat-owned boards onto sidebar folders (schema v4 → v5). */
export function migrateSessionV4ToV5(state: SessionState): void {
  if (!state.groups) state.groups = [];

  for (const chat of state.chats) {
    const legacyBoard = chat.orchestrateBoard;
    if (!legacyBoard) continue;

    const legacyGroupId =
      typeof (legacyBoard as { groupId?: string }).groupId === 'string'
        ? (legacyBoard as { groupId?: string }).groupId!.trim()
        : '';
    let group = legacyGroupId
      ? state.groups.find((g) => g.id === legacyGroupId)
      : undefined;

    if (!group) {
      const planLabel =
        chat.orchestratePlanPath?.split('/').pop()?.replace(/\.md$/i, '') ||
        legacyBoard.planPath.split('/').pop()?.replace(/\.md$/i, '') ||
        'Orchestrate';
      const ws = normalizeWorkspacePath(chat.workspacePath);
      const siblings = state.groups.filter(
        (g) => normalizeWorkspacePath(g.workspacePath) === ws,
      );
      group = {
        id: `grp_${newChatId().slice(5)}`,
        name: planLabel,
        workspacePath: ws,
        collapsed: false,
        order: siblings.length,
        createdAt: Date.now(),
      };
      state.groups.push(group);
    }

    const boardCopy = { ...legacyBoard };
    delete (boardCopy as { groupId?: string }).groupId;
    group.orchestrateBoard = boardCopy;
    group.orchestratePlanPath =
      chat.orchestratePlanPath ?? group.orchestratePlanPath ?? legacyBoard.planPath;
    group.plannerChatId = chat.id;
    if (chat.viewMode === 'board') {
      group.viewMode = 'board';
      state.activeBoardGroupId = group.id;
    }

    chat.boardGroupId = group.id;
    chat.groupId = group.id;

    for (const task of legacyBoard.tasks) {
      const taskChatId = task.chatId?.trim();
      if (!taskChatId) continue;
      const taskChat = state.chats.find((c) => c.id === taskChatId);
      if (!taskChat) continue;
      taskChat.groupId = group.id;
      taskChat.boardGroupId = group.id;
    }

    delete chat.orchestrateBoard;
    delete chat.viewMode;
  }

  (state as { version: number }).version = 5;
}

/** Experts overhaul: expertId as sole identity, runtime snapshots, drop Auto picker state. */
export function migrateSessionV5ToV6(state: SessionState): void {
  for (const chat of state.chats) {
    const selection = chat.expertSelection;
    if (chat.kind === 'expert') {
      if (!chat.expertId?.trim() && selection?.mode === 'manual' && selection.expertId?.trim()) {
        chat.expertId = selection.expertId.trim();
      }
      if (!chat.expertRuntime) {
        chat.expertRuntime = {
          ...(chat.providerId?.trim() ? { providerId: chat.providerId.trim() } : {}),
          modelId: chat.modelId ?? '',
          modeId: normalizeModeId(chat.modeId),
          toolAllowlist: null,
          toolDenylist: [],
          enabledToolNames: [],
          memoryEnabled: true,
          warnings: [],
          profileSource: 'inherit',
        };
      }
    }
    delete chat.expertSelection;
  }
  state.version = 6;
}

/** Rewrite legacy sandbox / unscoped chats onto the Scratch workspace path. */
export function migrateScratchWorkspacePaths(state: SessionState, scratchPath: string): void {
  const scratchKey = normalizeWorkspacePath(scratchPath);
  if (!scratchKey) return;

  const remapWorkspaceKey = (key: string): string => {
    const normalized = normalizeWorkspacePath(key);
    if (!normalized) return scratchKey;
    if (isMinnowSandboxWorkspacePath(normalized)) return scratchKey;
    return normalized;
  };

  for (const chat of state.chats) {
    const ws = normalizeWorkspacePath(chat.workspacePath ?? '');
    const nextWs = remapWorkspaceKey(ws);
    if (nextWs !== ws) {
      chat.workspacePath = nextWs;
    }
    chat.modeId = normalizeModeId(chat.modeId);
  }

  for (const group of state.groups ?? []) {
    const ws = normalizeWorkspacePath(group.workspacePath ?? '');
    const nextWs = remapWorkspaceKey(ws);
    if (nextWs !== ws) {
      group.workspacePath = nextWs;
    }
  }

  if (state.lastActiveChatIdByWorkspace) {
    const nextMap: Record<string, string> = {};
    for (const [key, chatId] of Object.entries(state.lastActiveChatIdByWorkspace)) {
      const nextKey = remapWorkspaceKey(key);
      if (!nextMap[nextKey]) {
        nextMap[nextKey] = chatId;
      }
    }
    state.lastActiveChatIdByWorkspace = nextMap;
  }

  if (state.lastActiveChatIdByApp) {
    const legacyChat = state.lastActiveChatIdByApp[CHAT_APP_ID];
    if (legacyChat && !state.lastActiveChatIdByApp[CODE_APP_ID]) {
      state.lastActiveChatIdByApp[CODE_APP_ID] = legacyChat;
    }
    delete state.lastActiveChatIdByApp[CHAT_APP_ID];
  }
}

/** Apply Scratch migration when workspace sync provides the canonical sandbox path. */
export function migrateScratchWorkspacePathsForLoadedSession(scratchPath: string): void {
  if (!sessionState) return;
  migrateScratchWorkspacePaths(sessionState, scratchPath);
  scheduleSaveSessions();
}

/** Coerce a chat row via the shared server/client schema (Phase B.1). */
export function ensureChatShape(raw: Partial<Chat> | null | undefined): Chat {
  const chat = normalizeChatRow(raw) as Chat;
  ensureTokenLedger(chat);
  return chat;
}

export function isExpertChat(chat: Chat): boolean {
  return chat.kind === 'expert';
}

/** Legacy Expert Lab sessions are omitted from the main sidebar. */
export function isHiddenFromMainSidebar(chat: Chat): boolean {
  return chat.kind === 'expert-lab';
}

/** Create a new expert-scoped chat from a resolved seed (runtime + greeting). */
export function createExpertChatFromSeed(seed: ExpertChatSeed): Chat {
  const state = requireSessionState();
  const chat = createEmptyChatObject(seed.modelId, seed.workspacePath);
  chat.kind = 'expert';
  chat.expertId = seed.expertId;
  if (seed.providerId?.trim()) chat.providerId = seed.providerId.trim();
  chat.modeId = seed.modeId;
  chat.expertRuntime = { ...seed.runtimeSnapshot };
  chat.name = PLACEHOLDER_CHAT_NAME;
  chat.history.push({ role: 'assistant', content: seed.greeting });
  state.chats.push(chat);
  touchChat(chat);
  scheduleSaveSessions();
  return chat;
}

/** @deprecated Use createExpertChatFromSeed with resolveExpertChatSeed. */
export function createExpertChat(
  expertId: string,
  modelId = '',
  workspacePath?: string,
): Chat {
  const state = requireSessionState();
  const trimmedId = expertId.trim();
  const chat = createEmptyChatObject(
    modelId,
    workspacePath?.trim() || getWorkspacePath(),
  );
  chat.kind = 'expert';
  chat.expertId = trimmedId;
  chat.modeId = 'general';
  chat.expertRuntime = {
    modelId: modelId || '',
    modeId: 'general',
    toolAllowlist: null,
    toolDenylist: [],
    enabledToolNames: [],
    memoryEnabled: true,
    warnings: [],
    profileSource: 'inherit',
  };
  chat.name = PLACEHOLDER_CHAT_NAME;
  state.chats.push(chat);
  touchChat(chat);
  scheduleSaveSessions();
  return chat;
}

/** Expert threads for one specialist, newest activity first. */
export function getExpertChats(expertId: string): Chat[] {
  const state = requireSessionState();
  const id = expertId.trim();
  return state.chats
    .filter((c) => c.kind === 'expert' && c.expertId === id)
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a));
}

/**
 * Set the active chat id, hydrate history, and schedule a session save.
 * Await this (or {@link ensureChatHistoryLoaded}) before painting the transcript —
 * lazy-boot chats start with `history: []` until the history GET lands.
 */
export async function activateChatById(id: string): Promise<void> {
  const state = requireSessionState();
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  state.activeId = id;
  markSessionScalarsDirty();
  maybeRememberActiveChatForForegroundApp(state, chat);
  scheduleSaveSessions();
  if (chat.historyLoaded === false) {
    paintChatHistoryPendingInForegroundShell();
    await ensureChatHistoryLoaded(id);
  }
}

/** Read legacy expert selection when still present on disk (pre-v6). */
export function getExpertSelection(chat: Chat): ExpertSelection {
  if (chat.expertSelection) return chat.expertSelection;
  const expertId = chat.expertId?.trim();
  if (expertId) return { mode: 'manual', expertId };
  return { mode: 'auto', expertId: null };
}

/** Upgrade v1/v2 session JSON to canonical schema v2 in memory. */
export function migrateSessionStateV1ToV2(parsed: RawSessionJson): SessionState {
  const state = migrateSessionJsonToV2(
    parsed,
    (c) => ensureChatShape(c as Partial<Chat>),
    () => createEmptyChatObject(''),
  );
  clearStaleGenerationIdsOnLoad(state.chats);
  return state;
}

/** Parse persisted session JSON (client load path; parity with server validateSessionState). */
export function parseSessionStateFromJson(parsed: RawSessionJson | null): SessionState {
  if (!parsed || !Array.isArray(parsed.chats)) {
    return defaultSessionState();
  }
  const ver = parsed.version;
  if (ver !== 1 && ver !== 2 && ver !== 3 && ver !== 4 && ver !== 5 && ver !== 6) {
    return defaultSessionState();
  }
  const state = migrateSessionStateV1ToV2(parsed);
  const rawSession = parsed as Partial<SessionState>;
  state.groups = ensureGroupsFromRaw(rawSession.groups);
  if (
    typeof rawSession.activeBoardGroupId === 'string' &&
    rawSession.activeBoardGroupId.trim()
  ) {
    state.activeBoardGroupId = rawSession.activeBoardGroupId.trim();
  }
  if (
    typeof rawSession.lastBoardGroupId === 'string' &&
    rawSession.lastBoardGroupId.trim()
  ) {
    state.lastBoardGroupId = rawSession.lastBoardGroupId.trim();
  }
  if (ver < 5 || state.chats.some((c) => c.orchestrateBoard)) {
    migrateSessionV4ToV5(state);
  } else if (ver >= 5) {
    (state as { version: number }).version = ver;
  }
  if (ver < 6) {
    migrateSessionV5ToV6(state);
  } else {
    state.version = 6;
  }
  repairPlannerChatFolderMembership(state);
  repairBoardChatWorktreeRoots(state);
  if (
    rawSession.codeChangeTotalsByWorkspace &&
    typeof rawSession.codeChangeTotalsByWorkspace === 'object'
  ) {
    state.codeChangeTotalsByWorkspace = rawSession.codeChangeTotalsByWorkspace;
  }
  if (!state.lastActiveChatIdByApp) {
    state.lastActiveChatIdByApp = {};
  }
  if (typeof rawSession.sidebarWidth === 'number' && Number.isFinite(rawSession.sidebarWidth)) {
    state.sidebarWidth = Math.min(520, Math.max(200, Math.round(rawSession.sidebarWidth)));
  }
  return state;
}

/** Backfill chat.worktreeRoot from the linked board task after session load. */
function repairBoardChatWorktreeRoots(state: SessionState): void {
  for (const chat of state.chats) {
    if (chat.worktreeRoot?.trim()) continue;
    const root = resolveChatWorktreeRoot(chat, state.groups);
    if (root) chat.worktreeRoot = root;
  }
}

/** Planners linked via boardGroupId appear under their board folder in the sidebar. */
function repairPlannerChatFolderMembership(state: SessionState): void {
  let dirty = false;
  for (const group of state.groups ?? []) {
    const plannerId = group.plannerChatId?.trim();
    if (!plannerId) continue;
    const planner = state.chats.find((c) => c.id === plannerId);
    if (!planner) continue;
    if (planner.boardGroupId === group.id && planner.groupId !== group.id) {
      planner.groupId = group.id;
      dirty = true;
    }
  }
  if (dirty) {
    scheduleSaveSessions();
  }
}

// ── Workspace apps ───────────────────────────────────────────────────────────

/** When a foreground chat surface is active, persist its last active chat id per app. */
function maybeRememberActiveChatForForegroundApp(
  state: SessionState,
  chat: Chat,
): void {
  if (normalizeModeId(chat.modeId) === 'super-plan') return;
  if (getForegroundAppId() === 'code' || isChatAppForeground()) {
    rememberActiveChatForAppInState(state, CODE_APP_ID, chat.id);
  }
}

/** Remember the active chat under the current workspace key before switching scope. */
function rememberActiveChatForWorkspaceKey(workspaceKey: string): void {
  const state = sessionState;
  if (!state?.activeId) return;
  const active = state.chats.find((c) => c.id === state.activeId);
  if (active && normalizeModeId(active.modeId) === 'super-plan') return;
  if (!state.lastActiveChatIdByWorkspace) {
    state.lastActiveChatIdByWorkspace = {};
  }
  state.lastActiveChatIdByWorkspace[workspaceKey] = state.activeId;
  markSessionScalarsDirty();
}

/** Drop a deleted chat id from remembered workspace/app maps (PATCH scalars). */
function purgeRememberedChatId(state: SessionState, chatId: string): void {
  let changed = false;
  if (state.lastActiveChatIdByWorkspace) {
    for (const [key, id] of Object.entries(state.lastActiveChatIdByWorkspace)) {
      if (id === chatId) {
        delete state.lastActiveChatIdByWorkspace[key];
        changed = true;
      }
    }
  }
  if (state.lastActiveChatIdByApp) {
    for (const [appId, id] of Object.entries(state.lastActiveChatIdByApp)) {
      if (id === chatId) {
        delete state.lastActiveChatIdByApp[appId];
        changed = true;
      }
    }
  }
  if (changed) markSessionScalarsDirty();
}

/** Point remembered workspace/app ids at the new active chat after a deletion. */
function syncRememberedActiveChatAfterDelete(
  state: SessionState,
  victim: Chat,
  wasActive: boolean,
): void {
  purgeRememberedChatId(state, victim.id);
  if (!wasActive) return;

  const next = state.chats.find((c) => c.id === state.activeId);
  if (!next) return;

  const workspaceKey = normalizeWorkspacePath(next.workspacePath ?? '');
  if (!state.lastActiveChatIdByWorkspace) {
    state.lastActiveChatIdByWorkspace = {};
  }
  state.lastActiveChatIdByWorkspace[workspaceKey] = next.id;
  markSessionScalarsDirty();

  rememberActiveChatForAppInState(state, CODE_APP_ID, next.id);
}

/** Persist the active chat when it belongs to the given project workspace (before desktop chat). */
export function rememberWorkspaceActiveChat(workspacePath: string): void {
  const state = sessionState;
  if (!state?.activeId) return;
  const key = normalizeWorkspacePath(workspacePath);
  if (!key) return;
  const active = getActiveChat();
  if (normalizeWorkspacePath(active.workspacePath ?? '') !== key) return;
  rememberActiveChatForWorkspaceKey(key);
  scheduleSaveSessions();
}

/** Chats for the given workspace (newest first); empty workspace key returns none. */
export function getChatsForWorkspace(
  workspacePath: string,
  state: SessionState = requireSessionState(),
): Chat[] {
  return filterChatsForWorkspace(workspacePath, state);
}

/** Sidebar session rows for a workspace (excludes ephemeral empty chats). */
export function getSidebarListedChatsForWorkspace(
  workspacePath: string,
  state: SessionState = requireSessionState(),
): Chat[] {
  return filterSidebarListedChatsForWorkspace(workspacePath, state);
}

export {
  isEphemeralEmptyChat,
  isSidebarListedChat,
  pruneEphemeralEmptyChats,
  formatDraftChatSidebarName,
};

/** Legacy or unscoped chats (`workspacePath === ''`), newest first. */
export function getUnassignedChats(state: SessionState = requireSessionState()): Chat[] {
  return filterUnassignedChats(state);
}

/** Assistant chats for the chats workspace sandbox (sidebar-visible, newest first). */
export function getAssistantChats(
  chatsWorkspacePath: string,
  state: SessionState = requireSessionState(),
): Chat[] {
  return filterAssistantChats(state, chatsWorkspacePath);
}

/** All chats bound to the chats workspace (newest first). */
export function getChatsForChatsWorkspace(
  chatsWorkspacePath: string,
  state: SessionState = requireSessionState(),
): Chat[] {
  return filterChatsForChatsWorkspace(state, chatsWorkspacePath);
}

/** Persist last active chat id for a Minnow app. */
export function rememberActiveChatForApp(appId: string, chatId: string): void {
  const state = requireSessionState();
  rememberActiveChatForAppInState(state, appId, chatId);
  markSessionScalarsDirty();
  scheduleSaveSessions();
}

/** Read remembered active chat id for a Minnow app. */
export function getLastActiveChatIdForAppFromSession(appId: string): string | undefined {
  return getLastActiveChatIdForApp(requireSessionState(), appId);
}

/**
 * Activate the last assistant chat for the Chat app or create one (general mode).
 * Requires the absolute chats workspace path from `getChatsWorkspacePath()`.
 */
export function activateAssistantChatForApp(chatsWorkspacePath: string): Chat {
  const state = requireSessionState();
  const nextId = resolveActiveAssistantChatId(chatsWorkspacePath, state, (workspaceKey) => {
    const fresh = createAssistantChat(workspaceKey, newChatId());
    touchChat(fresh);
    return fresh;
  });
  state.activeId = nextId;
  markSessionScalarsDirty();
  rememberActiveChatForAppInState(state, CODE_APP_ID, nextId);
  scheduleSaveSessions();
  return getActiveChat();
}

/**
 * Pick the active chat id for a workspace: remembered id, else newest scoped chat,
 * else create a new empty chat bound to that workspace.
 */
export function resolveActiveChatIdForWorkspace(
  workspacePath: string,
  state: SessionState = requireSessionState(),
  fallbackModelId = '',
): string {
  return pickActiveChatIdForWorkspace(
    workspacePath,
    state,
    fallbackModelId,
    (modelId, workspaceKey) => {
      const fresh = createEmptyChatObject(modelId, workspaceKey);
      touchChat(fresh);
      return fresh;
    },
  );
}

export interface WorkspaceChangeResult {
  activeChat: Chat;
  activeChanged: boolean;
}

/**
 * After the workspace folder changes: persist per-workspace active chat and switch
 * to the best chat for the new path. Awaits history hydrate for the new active chat.
 */
export async function onWorkspaceChanged(
  newPath: string,
  previousPath?: string,
): Promise<WorkspaceChangeResult> {
  const state = requireSessionState();
  const prevKey = normalizeWorkspacePath(previousPath ?? '');
  rememberActiveChatForWorkspaceKey(prevKey);

  const fallbackModelId =
    state.chats.find((c) => c.id === state.activeId)?.modelId ?? '';
  const nextId = pickFreshChatIdForWorkspaceEntry(
    newPath,
    state,
    fallbackModelId,
    (modelId, workspaceKey) => createEmptyChatObject(modelId, workspaceKey),
  );
  const activeChanged = state.activeId !== nextId;
  state.activeId = nextId;
  markSessionScalarsDirty();
  touchChat(getActiveChat());
  pruneEphemeralEmptyChats(state, nextId);
  rememberActiveChatForWorkspaceKey(normalizeWorkspacePath(newPath));
  scheduleSaveSessions();
  await ensureChatHistoryLoaded(nextId);
  return { activeChat: getActiveChat(), activeChanged };
}

export interface LoadSessionsOptions {
  /** Re-fetch from server/localStorage even when sessionState is already populated. */
  force?: boolean;
}

/**
 * True when the parsed state still describes every chat the server listed.
 * Guards against `parseSessionStateFromJson` silently degrading to its
 * one-empty-chat default, which downstream code would otherwise treat as the
 * user's real session.
 */
function sessionStateCoversRemoteChats(
  parsed: SessionState,
  remote: SessionSummariesState,
): boolean {
  const remoteIds = new Set(
    (Array.isArray(remote.chats) ? remote.chats : [])
      .map((summary) => summary?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  if (remoteIds.size === 0) return true;
  const parsedIds = new Set(parsed.chats.map((chat) => chat.id));
  for (const id of remoteIds) {
    if (!parsedIds.has(id)) return false;
  }
  return true;
}

// ── Load storage ─────────────────────────────────────────────────────────────

/** Load sessions from API or localStorage (after detectConfigServer). */
export async function loadSessionsFromStorage(options?: LoadSessionsOptions): Promise<void> {
  if (sessionState && !options?.force) {
    return;
  }
  try {
    if (isServerStorageMode()) {
      try {
        if (sessionsLazyHistoryEnabled) {
          const remote = await getSessionSummaries();
          const parsed = sessionStateFromSummaries(remote);
          /*
           * parseSessionStateFromJson degrades to a one-empty-chat default for any
           * shape it does not recognize. Adopting that as "hydrated" state is how a
           * single bad boot turned into a full PUT that deleted every other chat.
           * A short chat list means the parse failed, not that the store is empty.
           */
          if (!sessionStateCoversRemoteChats(parsed, remote)) {
            throw new Error('Session summaries did not survive parsing');
          }
          sessionState = parsed;
          sessionRevision = typeof remote.revision === 'number' ? remote.revision : null;
          sessionsHydratedFromServer = true;
          /*
           * Hydration of the active transcript is deliberately outside the hydrate
           * gate above: one failed history GET used to discard the entire parsed
           * session and leave the user staring at a single blank chat.
           */
          if (sessionState.activeId) {
            try {
              await ensureChatHistoryLoaded(sessionState.activeId);
              const active = findChatById(sessionState.activeId);
              if (active) clearStaleGenerationIdsOnLoad([active]);
            } catch {
              if (typeof document !== 'undefined') {
                setStatus('err', 'Could not load this chat’s messages — reopen it to retry');
              }
            }
          }
          await runSessionCodeChangeBackfill(sessionState);
        } else {
          const remote = await getSessions();
          sessionState = parseSessionStateFromJson(remote);
          markAllHistoriesLoaded(sessionState.chats);
          sessionsHydratedFromServer = true;
          await runSessionCodeChangeBackfill(sessionState);
        }
        return;
      } catch {
        if (typeof document !== 'undefined') {
          setStatus('err', 'Could not load sessions from ~/.minnow');
        }
        if (!sessionState) {
          sessionState = defaultSessionState();
          markAllHistoriesLoaded(sessionState.chats);
          sessionsHydratedFromServer = false;
          sessionRevision = null;
        }
        return;
      }
    }

    sessionsHydratedFromServer = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        sessionState = defaultSessionState();
        markAllHistoriesLoaded(sessionState.chats);
        return;
      }
      sessionState = parseSessionStateFromJson(JSON.parse(raw) as Partial<SessionState>);
      markAllHistoriesLoaded(sessionState.chats);
      await runSessionCodeChangeBackfill(sessionState);
    } catch {
      sessionState = defaultSessionState();
      markAllHistoriesLoaded(sessionState.chats);
    }
  } finally {
    clearSessionDirtySets();
    sessionPatchDirtySetsReady = false;
    captureDirtyTrackingShadow(sessionState);
    markSessionsReady();
  }
}

// ── Chat fields ──────────────────────────────────────────────────────────────

/**
 * Resolve a chat by id when session state is available.
 * Returns undefined when sessions are not loaded yet (e.g. tests, early boot) so callers
 * can fall back instead of throwing from requireSessionState().
 */
export function findChatById(chatId: string): Chat | undefined {
  if (!sessionState) return undefined;
  return sessionState.chats.find((c) => c.id === chatId);
}

/** Chats ordered newest-first for sidebar display (by last committed message). */
export function getChatsSortedByUpdatedDesc(): Chat[] {
  return [...requireSessionState().chats].sort(
    (a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a),
  );
}

export function getActiveChat(): Chat {
  const state = requireSessionState();
  const c = state.chats.find((x) => x.id === state.activeId);
  return c || state.chats[0];
}

export function touchChat(chat: Chat): void {
  chat.updatedAt = Date.now();
  addDirtyChatId(chat.id);
  bumpSessionDirtyEpoch();
}

/**
 * Mark a chat dirty without restamping `updatedAt`. For machine-written fields (live stats)
 * that must persist but are not a user edit — restamping churns sidebar order (MIN-793).
 */
export function markChatDirty(chat: Chat): void {
  addDirtyChatId(chat.id);
  bumpSessionDirtyEpoch();
}

/** Store a new /goal completion condition on the chat. */
export function setActiveGoal(chat: Chat, conditionText: string): void {
  const trimmed = conditionText.trim().slice(0, MAX_GOAL_CONDITION_CHARS);
  if (!trimmed) return;
  ensureTokenLedger(chat);
  chat.activeGoal = {
    conditionText: trimmed,
    startedAt: Date.now(),
    turnCount: 0,
    tokenBaseline: chat.tokenLedger?.totals.totalTokens ?? 0,
  };
  touchChat(chat);
  scheduleSaveSessions();
}

/** Remove goal state from the chat (/goal clear, /clear, etc.). */
export function clearActiveGoal(chat: Chat): void {
  if (!chat.activeGoal) return;
  chat.activeGoal = undefined;
  touchChat(chat);
  scheduleSaveSessions();
}

/** Replace the build-agent progress checklist on a chat (todo_write). */
export function setChatTodos(chat: Chat, todos: ChatTodo[]): void {
  chat.todos = todos.slice(0, MAX_CHAT_TODO_ITEMS).map((item) => ({
    text: item.text.trim().slice(0, MAX_CHAT_TODO_TEXT_CHARS),
    status: normalizeChatTodoStatus(item.status),
  }));
  chat.todosUpdatedAt = Date.now();
  touchChat(chat);
  scheduleSaveSessions();
}

/** Clear build-agent todos (/clear or empty todo_write). */
export function clearChatTodos(chat: Chat): void {
  if (!chat.todos?.length && chat.todosUpdatedAt === undefined) return;
  chat.todos = undefined;
  chat.todosUpdatedAt = undefined;
  touchChat(chat);
  scheduleSaveSessions();
}

/** Read persisted build-agent todos. */
export function getChatTodos(chat: Chat): ChatTodo[] | undefined {
  return chat.todos?.length ? chat.todos : undefined;
}

/** Read persisted goal state (may be achieved but still visible until cleared). */
export function getActiveGoal(chat: Chat): ActiveGoalState | undefined {
  return chat.activeGoal;
}

/** True while the evaluator loop should auto-continue and auto-approve tools. */
export function isGoalLoopActive(chat: Chat): boolean {
  const goal = chat.activeGoal;
  return Boolean(goal && !goal.achieved);
}

export interface AddActiveLoopInput {
  promptText: string;
  kind: 'interval' | 'auto';
  intervalMs?: number;
  currentDelayMs?: number;
  dueAt: number;
  createdAt: number;
  expiresAt: number;
}

/** Ask loop ticker to reschedule its next wake after dueAt changes. */
function notifyLoopTickerScheduleChanged(): void {
  void import('../chat/loop/ticker')
    .then((mod) => mod.notifyLoopScheduleChanged())
    .catch(() => {
    });
}

/** Arm a new /loop on the chat; returns the stored row. */
export function addActiveLoop(chat: Chat, input: AddActiveLoopInput): ActiveLoopState {
  const id = chat.nextLoopId && chat.nextLoopId > 0
    ? chat.nextLoopId
    : (chat.activeLoops?.reduce((max, loop) => Math.max(max, loop.id), 0) ?? 0) + 1;

  const loop: ActiveLoopState = {
    id,
    promptText: input.promptText.slice(0, MAX_LOOP_PROMPT_CHARS),
    kind: input.kind,
    dueAt: input.dueAt,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    runCount: 0,
  };

  if (input.kind === 'interval') {
    loop.intervalMs = Math.max(
      MIN_LOOP_INTERVAL_MS,
      Math.floor(input.intervalMs ?? MIN_LOOP_INTERVAL_MS),
    );
  } else {
    loop.currentDelayMs = Math.min(
      3_600_000,
      Math.max(
        MIN_LOOP_INTERVAL_MS,
        Math.floor(input.currentDelayMs ?? INITIAL_LOOP_AUTO_DELAY_MS),
      ),
    );
  }

  chat.activeLoops = [...(chat.activeLoops ?? []), loop];
  chat.nextLoopId = id + 1;
  touchChat(chat);
  scheduleSaveSessions();
  notifyLoopTickerScheduleChanged();
  return loop;
}

/** Remove one loop by id, or all loops when target is `all`. */
export function removeActiveLoop(chat: Chat, target: number | 'all'): void {
  if (!chat.activeLoops?.length) return;
  if (target === 'all') {
    chat.activeLoops = undefined;
    touchChat(chat);
    scheduleSaveSessions();
    notifyLoopTickerScheduleChanged();
    return;
  }
  const next = chat.activeLoops.filter((loop) => loop.id !== target);
  if (next.length === chat.activeLoops.length) return;
  chat.activeLoops = next.length ? next : undefined;
  touchChat(chat);
  scheduleSaveSessions();
  notifyLoopTickerScheduleChanged();
}

/** Patch fields on a single active loop (schedule / pacing). */
export function updateActiveLoop(
  chat: Chat,
  id: number,
  patch: Partial<ActiveLoopState>,
): void {
  if (!chat.activeLoops?.length) return;
  const index = chat.activeLoops.findIndex((loop) => loop.id === id);
  if (index < 0) return;
  chat.activeLoops[index] = { ...chat.activeLoops[index], ...patch, id };
  touchChat(chat);
  scheduleSaveSessions();
  notifyLoopTickerScheduleChanged();
}

/** Persist after in-place loop mutations that already updated the array. */
export function touchActiveLoops(chat: Chat): void {
  touchChat(chat);
  scheduleSaveSessions();
  notifyLoopTickerScheduleChanged();
}

/** Read active loops (empty array when none). */
export function getActiveLoops(chat: Chat): ActiveLoopState[] {
  return chat.activeLoops?.length ? [...chat.activeLoops] : [];
}

/** True when the chat has at least one armed loop. */
export function hasActiveLoops(chat: Chat): boolean {
  return Boolean(chat.activeLoops?.length);
}

/** Clear all loops (/clear, etc.). */
export function clearActiveLoops(chat: Chat): void {
  if (!chat.activeLoops?.length && chat.nextLoopId == null) return;
  chat.activeLoops = undefined;
  touchChat(chat);
  scheduleSaveSessions();
}

/** Bump sidebar sort time when user or assistant history is committed. */
export function recordChatMessage(chat: Chat): void {
  const now = Date.now();
  chat.lastMessageAt = now;
  touchChat(chat);
  chat.updatedAt = now;
}

export type SaveSessionsOptions = {
  /** Use fetch keepalive / sendBeacon for unload handlers (fire-and-forget). */
  keepalive?: boolean;
};

/** True when any chat still holds an empty lazy-history placeholder. */
function hasUnloadedChatHistories(state: SessionState): boolean {
  return state.chats.some((chat) => chat.historyLoaded === false);
}

/**
 * Mark the whole session dirty so a PATCH can stand in for a full PUT.
 * Used when the dirty sets are untrusted but a PUT would be unsafe.
 */
function markEveryChatDirty(state: SessionState): void {
  describeOnlyChatIds.clear();
  describeOnlyGroupIds.clear();
  for (const chat of state.chats) {
    // Nothing marked this one — it is only here to describe the session, so skip its transcript.
    if (!dirtyChatIds.has(chat.id)) {
      patchHistoryOmittedChatIds.add(chat.id);
      describeOnlyChatIds.add(chat.id);
    }
    dirtyChatIds.add(chat.id);
    dirtyTrackingShadow.delete(chat.id);
  }
  for (const group of state.groups ?? []) {
    if (!dirtyGroupIds.has(group.id)) describeOnlyGroupIds.add(group.id);
    dirtyGroupIds.add(group.id);
  }
  sessionScalarsDirty = true;
  bumpSessionDirtyEpoch();
}

/**
 * Another window advanced the store while this one was still describing its
 * boot snapshot. Forget the describe-only rows — re-sending them would push this
 * window's stale copies over the other window's edits and revive chats it
 * deleted — and keep whatever this window genuinely changed.
 */
function dropWholeStateDescribe(): void {
  for (const id of describeOnlyChatIds) {
    dirtyChatIds.delete(id);
    patchHistoryOmittedChatIds.delete(id);
  }
  for (const id of describeOnlyGroupIds) {
    dirtyGroupIds.delete(id);
  }
  describeOnlyChatIds.clear();
  describeOnlyGroupIds.clear();
}

// ── Save ─────────────────────────────────────────────────────────────────────

/**
 * Persist session state. In server mode (B.2):
 * - MIN-408: no network write until hydrated from ~/.minnow
 * - PATCH when `sessionsClientPatchEnabled` (default ON) and dirty sets are trusted
 * - full PUT on first save after load, or after a dirty-tracking verifier miss
 * - dirty sets clear only after a successful PATCH/PUT whose dirty epoch still matches
 * - overlapping flushes are serialized; mid-flight deletes queue a follow-up save
 */
export function saveSessionsNow(options?: SaveSessionsOptions): SaveSessionsResult {
  if (!sessionState) return 'ok';

  /*
   * A miss now marks the offending chat dirty, so the next PATCH carries it. Untrusting the
   * whole baseline on top of that only bought a full-session write — in dev that was a loop:
   * miss → baseline untrusted → whole-state PATCH → miss again next switch (MIN-794).
   */
  verifyDirtyChatTracking(sessionState);

  if (isServerStorageMode()) {
    if (!sessionsHydratedFromServer) {
      return 'ok';
    }

    let usePatch = sessionsClientPatchEnabled && sessionPatchDirtySetsReady;
    /*
     * A whole-blob PUT describes the entire session, so it must only be sent by a
     * client that can actually describe it. After a lazy boot most chats hold an
     * empty history placeholder. Rather than PUT that, upgrade to a PATCH that
     * upserts every chat: unhydrated rows omit `history`, which the server reads as
     * "preserve", so no transcript can be replaced by a placeholder.
     */
    let patchCoversWholeState = false;
    if (!usePatch && hasUnloadedChatHistories(sessionState)) {
      markEveryChatDirty(sessionState);
      usePatch = true;
      patchCoversWholeState = true;
    }

    if (usePatch && !hasSessionDirtyWork()) {
      sessionSaveQueued = false;
      captureDirtyTrackingShadow(sessionState);
      void import('../ui/hub').then((m) => m.refreshHubLiveData());
      return 'ok';
    }

    if (options?.keepalive) {
      /*
       * No baseRevision on the shutdown path: a 409 here is unrecoverable (the beacon
       * is fire-and-forget and the page is going away), so a stale-but-landed write
       * beats a rejected one. The write itself is non-destructive — it upserts, omits
       * history for unhydrated chats and deletes only what is named.
       */
      const delta = usePatch && hasSessionDirtyWork() ? buildSessionsPatchDelta(sessionState) : null;
      const wireState = sessionStateForSessionsWire(sessionState);
      const { clearedOk } = flushSessionsOnShutdown(delta, wireState, {
        deleteChatIds: [...deletedChatIds],
        deleteGroupIds: [...deletedGroupIds],
      });
      if (clearedOk) {
        clearSessionDirtySets();
        if (!usePatch) sessionPatchDirtySetsReady = true;
      }
      captureDirtyTrackingShadow(sessionState);
      void import('../ui/hub').then((m) => m.refreshHubLiveData());
      return 'ok';
    }

    if (inFlightSessionSave) {
      sessionSaveQueued = true;
      return 'ok';
    }

    const reportSaveError = (err: unknown): void => {
      if (err instanceof SessionsRevisionConflictError) {
        /*
         * Another window wrote first. Adopt its revision and let the standard
         * follow-up flush retry against it — the dirty markers are still set, and
         * the write itself is non-destructive now (upsert, explicit deletes only,
         * history omitted for chats this client never hydrated). Re-reading the
         * store here instead would replace `sessionState` and throw away exactly
         * the unsaved edits this flush exists to persist.
         */
        sessionRevision = err.revision ?? null;
        if (patchCoversWholeState) {
          /*
           * ...except for the boot-time whole-state describe, which carries rows
           * this window never edited (every other folder's chats, frozen at this
           * window's boot). Re-sending it would overwrite the other window's
           * edits and revive chats it deleted. Drop the describe, keep the real
           * edits, and stop re-describing: the store is authoritative for
           * everything this window has not touched.
           */
          dropWholeStateDescribe();
          sessionPatchDirtySetsReady = true;
        }
        if (typeof document !== 'undefined') {
          setStatus('spin', 'Sessions changed in another window — retrying save');
        }
        return;
      }
      if (typeof document !== 'undefined') {
        setStatus('err', 'Could not save sessions to ~/.minnow');
      }
    };

    const epochAtStart = sessionDirtyEpoch;
    const finishSave = (ok: boolean, revision?: number): void => {
      inFlightSessionSave = null;
      if (ok) {
        if (typeof revision === 'number') sessionRevision = revision;
        if (sessionDirtyEpoch === epochAtStart) {
          clearSessionDirtySets();
        }
        if (!usePatch || patchCoversWholeState) sessionPatchDirtySetsReady = true;
        captureDirtyTrackingShadow(sessionState);
      }
      const shouldFollowUp = sessionSaveQueued || hasSessionDirtyWork();
      sessionSaveQueued = false;
      if (shouldFollowUp) {
        saveSessionsNow();
      }
    };

    if (usePatch) {
      const delta = buildSessionsPatchDelta(sessionState);
      if (sessionRevision != null) delta.baseRevision = sessionRevision;
      inFlightSessionSave = patchSessions(delta, {
        // A describe must not be re-based onto another window's newer revision.
        rebaseOnConflict: !patchCoversWholeState,
      })
        .then((revision) => finishSave(true, revision))
        .catch((err) => {
          reportSaveError(err);
          finishSave(false);
        });
      void import('../ui/hub').then((m) => m.refreshHubLiveData());
      return 'ok';
    }

    const wireState = sessionStateForSessionsWire(sessionState);
    inFlightSessionSave = putSessions(wireState, {
      deleteChatIds: [...deletedChatIds],
      deleteGroupIds: [...deletedGroupIds],
      ...(sessionRevision != null ? { baseRevision: sessionRevision } : {}),
    })
      .then((revision) => finishSave(true, revision))
      .catch((err) => {
        reportSaveError(err);
        finishSave(false);
      });
    void import('../ui/hub').then((m) => m.refreshHubLiveData());
    return 'ok';
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessionState));
    clearSessionDirtySets();
    captureDirtyTrackingShadow(sessionState);
    void import('../ui/hub').then((m) => m.refreshHubLiveData());
    return 'ok';
  } catch (e) {
    const err = e as { name?: string };
    if (err && err.name === 'QuotaExceededError') {
      return 'quota_exceeded';
    }
    return 'ok';
  }
}

export function scheduleSaveSessions(hint?: { chatId?: string; groupId?: string }): void {
  if (hint?.chatId?.trim()) {
    addDirtyChatId(hint.chatId.trim());
    bumpSessionDirtyEpoch();
  }
  if (hint?.groupId?.trim()) markGroupDirty(hint.groupId.trim());
  const now = Date.now();
  if (!saveTimer) saveFirstScheduledAt = now;
  const elapsed = now - saveFirstScheduledAt;
  const delay = Math.min(SAVE_DEBOUNCE_MS, Math.max(0, SAVE_MAX_WAIT_MS - elapsed));
  if (saveTimer) clearTimeout(saveTimer);
  setSaveTimer(
    setTimeout(() => {
      setSaveTimer(null);
      saveFirstScheduledAt = 0;
      saveSessionsNow();
    }, delay)
  );
}

/** Run any debounced session save immediately (unit tests only). */
export function flushScheduledSessionSaveForTests(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  setSaveTimer(null);
  saveFirstScheduledAt = 0;
  saveSessionsNow();
}

/** Flush debounced saves and persist immediately (pagehide / abrupt quit). */
export function flushPendingSessionSaveOnShutdown(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    setSaveTimer(null);
  }
  saveFirstScheduledAt = 0;
  saveSessionsNow({ keepalive: true });
}

/** Register a one-time pagehide handler so debounced saves are not lost on quit. */
export function registerSessionPersistenceShutdownHandler(): void {
  if (sessionPersistenceShutdownRegistered || typeof window === 'undefined') return;
  sessionPersistenceShutdownRegistered = true;
  window.addEventListener('pagehide', () => {
    if (sessionState) {
      for (const chat of sessionState.chats) {
        const inFlight =
          chat.resumeInterrupted === true ||
          Boolean(chat.currentGenerationId?.trim()) ||
          streamingChatIds.has(chat.id);
        if (!inFlight) continue;
        chat.resumeInterrupted = true;
        touchChat(chat);
      }
    }
    flushPendingSessionSaveOnShutdown();
  });
}

// ── Chat CRUD ────────────────────────────────────────────────────────────────

/** Create a chat, make it active, and persist (debounced). */
export function createAndActivateChat(modelId: string): Chat {
  const state = requireSessionState();
  const chat = createEmptyChatObject(modelId);
  const routerDefault = getRouterConfigSync().defaultRouterId;
  if (routerDefault) { chat.providerId = 'minnow-router'; chat.modelId = routerDefault; }
  state.chats.unshift(chat);
  state.activeId = chat.id;
  markSessionScalarsDirty();
  touchChat(chat);
  rememberActiveChatForWorkspaceKey(normalizeWorkspacePath(chat.workspacePath));
  maybeRememberActiveChatForForegroundApp(state, chat);
  scheduleSaveSessions();
  notifySessionCreated(chat.id, chat.workspacePath);
  return chat;
}

/**
 * Switch active chat by id. Returns the chat when switched, or null if id is missing / already active.
 * Awaits history hydrate so callers can paint a full transcript after the Promise settles.
 */
export async function switchActiveChat(id: string): Promise<Chat | null> {
  const state = requireSessionState();
  if (id === state.activeId) return null;
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return null;
  state.activeId = id;
  markSessionScalarsDirty();
  rememberActiveChatForWorkspaceKey(normalizeWorkspacePath(chat.workspacePath ?? ''));
  maybeRememberActiveChatForForegroundApp(state, chat);
  scheduleSaveSessions();
  await ensureChatHistoryLoaded(id);
  return chat;
}

/** Update display title after rename UI commits. */
export function renameChatTitle(chatId: string, name: string): boolean {
  const chat = findChatById(chatId);
  if (!chat) return false;
  const trimmed = name.trim();
  if (trimmed) chat.name = trimmed;
  touchChat(chat);
  scheduleSaveSessions();
  return true;
}

/** Sync model id on the active chat (e.g. when the top-bar model select changes). */
export function setActiveChatModelId(modelId: string): void {
  const chat = getActiveChat();
  chat.modelId = modelId || '';
  touchChat(chat);
  scheduleSaveSessions();
}

export function toggleSidebarCollapsedState(): boolean {
  const state = requireSessionState();
  state.sidebarCollapsed = !state.sidebarCollapsed;
  markSessionScalarsDirty();
  scheduleSaveSessions();
  return state.sidebarCollapsed;
}

export function setSidebarCollapsed(collapsed: boolean): void {
  const state = requireSessionState();
  state.sidebarCollapsed = collapsed;
  markSessionScalarsDirty();
  scheduleSaveSessions();
}

/**
 * Remove a chat by id. If the list becomes empty, inserts a new empty chat using fallbackModelId.
 * Does not show confirm dialogs — callers in UI handle that.
 */
export function removeChatById(chatId: string, fallbackModelId: string): RemoveChatResult {
  const state = requireSessionState();
  const idx = state.chats.findIndex((c) => c.id === chatId);
  if (idx < 0) {
    return { ok: false, activeChanged: false, activeChat: getActiveChat() };
  }

  const victim = state.chats[idx];
  const victimAgent = resolveActiveWorkAgent(victim);
  cleanupChatArchiveOnDelete(
    victim.id,
    victim.workspacePath ?? '',
    victimAgent?.contextEnforcementPolicy,
  );
  void cleanupChatWorktreeOnDelete(victim);
  abortChatTitleGeneration(chatId);
  const wasActive = state.activeId === chatId;

  const boardGroup = (state.groups ?? []).find((g) => g.plannerChatId === chatId);
  if (boardGroup) {
    const planPath = normalizeOrchestratePlanPath(victim.orchestratePlanPath);
    if (planPath) {
      boardGroup.orchestratePlanPath = planPath;
    }
    delete boardGroup.plannerChatId;
  }

  state.chats.splice(idx, 1);
  deletedChatIds.add(chatId);
  bumpSessionDirtyEpoch();
  if (boardGroup) {
    markGroupDirty(boardGroup.id);
  }

  const victimWorkspace = normalizeWorkspacePath(victim.workspacePath ?? '');
  let activeChanged = wasActive;
  if (state.chats.length === 0) {
    const fresh = createEmptyChatObject(fallbackModelId, victimWorkspace);
    state.chats.push(fresh);
    state.activeId = fresh.id;
    markSessionScalarsDirty();
    touchChat(fresh);
    activeChanged = true;
  } else if (wasActive) {
    const remaining =
      victimWorkspace.length > 0
        ? getSidebarListedChatsForWorkspace(victimWorkspace, state)
        : getUnassignedChats(state);
    if (remaining.length) {
      state.activeId = remaining[0]!.id;
      markSessionScalarsDirty();
    } else {
      const fresh = createEmptyChatObject(fallbackModelId, victimWorkspace);
      state.chats.push(fresh);
      state.activeId = fresh.id;
      markSessionScalarsDirty();
      touchChat(fresh);
    }
    activeChanged = true;
  }

  syncRememberedActiveChatAfterDelete(state, victim, wasActive);
  if (saveTimer) {
    clearTimeout(saveTimer);
    setSaveTimer(null);
  }
  saveSessionsNow();
  return {
    ok: true,
    removed: victim,
    activeChanged,
    activeChat: getActiveChat(),
  };
}

/**
 * Apply a model-generated title when the chat still uses the placeholder name,
 * or still matches the exact prompt snippet staged for this title job.
 * Returns false if the chat is missing or was renamed.
 */
export function applyGeneratedChatTitle(
  chatId: string,
  title: string,
  expectedPromptPlaceholder?: string,
): boolean {
  const chat = findChatById(chatId);
  if (
    !chat ||
    (!isPlaceholderChatName(chat.name) && chat.name !== expectedPromptPlaceholder)
  ) {
    return false;
  }
  const trimmed = title.trim();
  if (!trimmed) return false;
  chat.name = trimmed;
  touchChat(chat);
  return true;
}
