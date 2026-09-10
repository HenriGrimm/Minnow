import { streamingChatIds } from '../app-state';
import { chatAwaitingUserInputTool } from '../chat/incomplete-tool-batch';
import { getActiveChat, sessionState } from '../state/sessions';
import type { Chat } from '../types';

/** Ephemeral "last time user viewed this chat" for unread detection (not persisted). */
const chatLastOpenedAt = new Map<string, number>();

/** Per-chat stream phase for sidebar thinking dots (concurrent streams). */
const streamPhaseByChatId = new Map<string, 'loading_model' | 'generating' | 'thinking'>();

/** Active chat id while a tool-approval strip is open (singleton surface). */
let inputPendingChatId: string | null = null;

/** Chats with a parked or visible ask_question strip (independent of tool approval). */
const questionPendingChatIds = new Set<string>();

export type ChatItemDotState = 'idle' | 'unread' | 'needs-input' | 'error' | 'working';

export interface ChatItemDotContext {
  activeChatId: string | null;
  streamingChatIds: ReadonlySet<string>;
  streamPhaseByChatId: ReadonlyMap<string, 'loading_model' | 'generating' | 'thinking'>;
  inputPendingChatId: string | null;
  /** Optional: parked ask_question strips on chats other than `inputPendingChatId`. */
  inputPendingChatIds?: ReadonlySet<string>;
}

/** Build context from app + module state (for sidebar render and DOM sync). */
export function getChatItemDotContext(activeChatId: string | null): ChatItemDotContext {
  return {
    activeChatId,
    streamingChatIds,
    streamPhaseByChatId,
    inputPendingChatId,
    inputPendingChatIds: questionPendingChatIds,
  };
}

/** True when this chat has an in-flight model turn (any stream phase). */
function isChatStreamWorking(chat: Chat, ctx: ChatItemDotContext): boolean {
  const phase = ctx.streamPhaseByChatId.get(chat.id);
  const streamingThisChat = ctx.streamingChatIds.has(chat.id);
  if (streamingThisChat) {
    return (
      phase == null ||
      phase === 'loading_model' ||
      phase === 'generating' ||
      phase === 'thinking'
    );
  }
  if (chat.id !== ctx.activeChatId) return false;
  if (!chat.currentGenerationId?.trim()) return false;
  return (
    phase === 'loading_model' || phase === 'generating' || phase === 'thinking'
  );
}

/** True when this chat is blocked on a tool approval or ask_question strip. */
function isChatInputPending(chatId: string, ctx: ChatItemDotContext): boolean {
  if (ctx.inputPendingChatIds?.has(chatId)) return true;
  return ctx.inputPendingChatId != null && chatId === ctx.inputPendingChatId;
}

/** One resolved visual state per chat. */
export function resolveChatItemDotState(chat: Chat, ctx: ChatItemDotContext): ChatItemDotState {
  if (isChatInputPending(chat.id, ctx)) {
    return 'needs-input';
  }
  if (chatAwaitingUserInputTool(chat)) {
    return 'needs-input';
  }
  if (chat.id !== ctx.activeChatId && chat.turnError === true) {
    return 'error';
  }
  if (isChatStreamWorking(chat, ctx)) {
    return 'working';
  }
  if (chat.id !== ctx.activeChatId && chat.unread === true) {
    return 'unread';
  }
  return 'idle';
}

/** True when the sidebar should render a colored status dot (not idle/working). */
export function isChatItemDotVisible(state: ChatItemDotState): boolean {
  return state === 'unread' || state === 'needs-input' || state === 'error';
}

const GROUP_DOT_PRIORITY: readonly ChatItemDotState[] = ['needs-input', 'error', 'unread'];

/** Highest-priority actionable dot among group member chats (for board folder headers). */
export function resolveGroupHeaderDotState(
  members: readonly Chat[],
  ctx: ChatItemDotContext,
): ChatItemDotState | null {
  let best: ChatItemDotState | null = null;
  let bestRank = GROUP_DOT_PRIORITY.length;
  for (const chat of members) {
    const state = resolveChatItemDotState(chat, ctx);
    if (!isChatItemDotVisible(state)) continue;
    const rank = GROUP_DOT_PRIORITY.indexOf(state);
    if (rank >= 0 && rank < bestRank) {
      best = state;
      bestRank = rank;
    }
  }
  return best;
}

/** Updates data-dot-state on the dot and optional row (for collapsed rail badge styling). */
export function applyChatItemDotClasses(
  dotEl: HTMLElement,
  state: ChatItemDotState,
  rowEl?: HTMLElement | null,
): void {
  dotEl.dataset.dotState = state;
  dotEl.hidden = state === 'idle';
  if (rowEl) {
    if (state === 'idle') {
      delete rowEl.dataset.dotState;
      rowEl.removeAttribute('aria-busy');
    } else {
      rowEl.dataset.dotState = state;
      if (state === 'working') {
        rowEl.setAttribute('aria-busy', 'true');
      } else {
        rowEl.removeAttribute('aria-busy');
      }
    }
  }
  const existing = dotEl.querySelector('.chat-item-dot__spinner');
  if (state === 'working') {
    if (!existing) {
      const sp = document.createElement('span');
      sp.className = 'chat-item-dot__spinner';
      sp.setAttribute('aria-hidden', 'true');
      dotEl.appendChild(sp);
    }
  } else if (existing) {
    existing.remove();
  }
}

/** Apply or remove the aggregated status dot on a board group header. */
export function applyGroupHeaderDotClasses(
  headEl: HTMLElement,
  state: ChatItemDotState | null,
): void {
  const existing = headEl.querySelector('.chat-group-header__dot');
  if (!state) {
    existing?.remove();
    delete headEl.dataset.dotState;
    return;
  }
  const dotEl =
    existing instanceof HTMLElement
      ? existing
      : (() => {
          const dot = document.createElement('span');
          dot.className = 'chat-group-header__dot';
          dot.setAttribute('aria-hidden', 'true');
          headEl.insertBefore(dot, headEl.firstChild);
          return dot;
        })();
  dotEl.dataset.dotState = state;
  headEl.dataset.dotState = state;
}

/** Refreshes every chat row dot without rebuilding the sidebar list. */
export function syncChatItemDotsInDom(): void {
  const state = sessionState;
  if (!state) return;
  const ctx = getChatItemDotContext(state.activeId);
  const list = document.getElementById('chatList');
  if (!list) return;
  // One pass over chats instead of a find/filter per row and per group header (MIN-793).
  const chatById = new Map(state.chats.map((c) => [c.id, c]));
  const chatsByGroupId = new Map<string, typeof state.chats>();
  for (const chat of state.chats) {
    const groupId = chat.groupId;
    if (!groupId) continue;
    const bucket = chatsByGroupId.get(groupId);
    if (bucket) bucket.push(chat);
    else chatsByGroupId.set(groupId, [chat]);
  }
  for (const row of list.querySelectorAll<HTMLElement>('.chat-item-row[data-chat-id]')) {
    const id = row.dataset.chatId;
    if (!id) continue;
    const chat = chatById.get(id);
    if (!chat) continue;
    const dotState = resolveChatItemDotState(chat, ctx);
    const inGroup = row.classList.contains('chat-item-row--in-group');
    const dot = row.querySelector('.chat-item-dot');
    if (inGroup) {
      dot?.remove();
      if (isChatItemDotVisible(dotState) || dotState === 'working') {
        row.dataset.dotState = dotState;
        if (dotState === 'working') {
          row.setAttribute('aria-busy', 'true');
        } else {
          row.removeAttribute('aria-busy');
        }
      } else {
        delete row.dataset.dotState;
        row.removeAttribute('aria-busy');
      }
      continue;
    }
    if (!(dot instanceof HTMLElement)) continue;
    applyChatItemDotClasses(dot, dotState, row);
  }
  for (const head of list.querySelectorAll<HTMLElement>('.chat-group-header[data-group-id]')) {
    const groupId = head.dataset.groupId;
    if (!groupId) continue;
    const members = chatsByGroupId.get(groupId) ?? [];
    applyGroupHeaderDotClasses(head, resolveGroupHeaderDotState(members, ctx));
  }
}

/** Alias for call sites that already use this name from the plan. */
export const refreshSidebarChatDots = syncChatItemDotsInDom;

/** Read the last-known stream phase for sidebar dots / stream DOM remount. */
export function getSidebarStreamPhase(
  chatId: string,
): 'loading_model' | 'generating' | 'thinking' | null {
  return streamPhaseByChatId.get(chatId) ?? null;
}

/** Called when the model enters or leaves the reasoning SSE phase for a chat. */
export function setSidebarStreamPhase(
  phase: 'loading_model' | 'generating' | 'thinking' | null,
  chatId?: string,
): void {
  const id = chatId?.trim() || getActiveChat().id;
  if (!id) return;
  if (phase === null) {
    streamPhaseByChatId.delete(id);
  } else {
    streamPhaseByChatId.set(id, phase);
  }
  syncChatItemDotsInDom();
}

/** Marks which chat is blocked on tool approval (singleton composer strip). */
export function setSidebarInputPendingChatId(chatId: string | null): void {
  inputPendingChatId = chatId;
  syncChatItemDotsInDom();
}

/** True when a visible or parked ask_question strip is blocking this chat. */
export function isChatQuestionPending(chatId: string): boolean {
  const trimmed = chatId.trim();
  return trimmed ? questionPendingChatIds.has(trimmed) : false;
}

/** Mark a chat as waiting on an ask_question strip (visible or parked). */
export function addSidebarInputPendingChatId(chatId: string): void {
  const trimmed = chatId.trim();
  if (!trimmed || questionPendingChatIds.has(trimmed)) return;
  questionPendingChatIds.add(trimmed);
  syncChatItemDotsInDom();
}

/** Clear the ask_question pending mark for one chat without touching others. */
export function removeSidebarInputPendingChatId(chatId: string): void {
  const trimmed = chatId.trim();
  if (!trimmed || !questionPendingChatIds.delete(trimmed)) return;
  syncChatItemDotsInDom();
}

/** Convenience: mark pending for the active chat, or clear. */
export function setSidebarInputPendingForActiveChat(active: boolean): void {
  if (!active) {
    setSidebarInputPendingChatId(null);
    return;
  }
  setSidebarInputPendingChatId(getActiveChat().id);
}

/** Mark a failed turn so inactive chats show a red sidebar dot until opened again. */
export function markChatTurnError(chat: Chat): void {
  chat.turnError = true;
}

/** Records that the user opened this chat (baseline for unread vs new assistant activity). */
export function recordChatOpened(chatId: string): void {
  chatLastOpenedAt.set(chatId, Date.now());
}

/** Boot: treat the initially active chat as "opened" so we do not mark unread incorrectly. */
export function bootstrapActiveChatOpenedTimestamp(): void {
  recordChatOpened(getActiveChat().id);
}

/** If the assistant produced output after the user last viewed this chat, mark unread (typically called when switching away from this chat). */
export function maybeMarkChatUnreadAfterLeave(chat: Chat): void {
  const openedAt = chatLastOpenedAt.get(chat.id) ?? 0;
  const lastAsst = chat.lastAssistantAt;
  if (lastAsst != null && Number.isFinite(lastAsst) && lastAsst > openedAt) {
    chat.unread = true;
  }
}

/** Updates the timestamp used when the user later leaves this chat (active stream only). */
export function recordAssistantReplyOnChat(chat: Chat): void {
  chat.lastAssistantAt = Date.now();
  if (chat.background === true && getActiveChat().id !== chat.id) {
    chat.unread = true;
  }
}
