import {
  getActiveChat,
  getChatMessageCount,
  isEphemeralEmptyChat,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import {
  hasComposerDraft,
} from '../state/session-workspace-scope';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Chat } from '../types';
import { clearComposerInput, getActiveComposerSurface } from './composer-surface';
import { autoResize } from './input';
import { clearAttachments } from '../attachments/store';
import { composerPromptHistoryDraft, resetComposerPromptHistory } from './composer-prompt-history';

let draftRestoreSuspended = false;

/** Debounce draft-only sidebar title tweaks (full rebuild only when list membership changes). */
let draftSidebarLabelTimer: ReturnType<typeof setTimeout> | null = null;
const DRAFT_SIDEBAR_LABEL_DEBOUNCE_MS = 200;

/** Session PATCH after a typing pause stringified the whole chat (and in DEV every chat) on the main thread — glyphs froze, then caught up. */
const DRAFT_SESSION_SAVE_IDLE_MS = 2500;
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
let draftSaveChatId: string | null = null;

// ── Persist ──────────────────────────────────────────────────────────────────

function scheduleComposerDraftSidebarLabelSync(chat: Chat): void {
  if (getChatMessageCount(chat) !== 0 || !hasComposerDraft(chat)) return;
  if (draftSidebarLabelTimer) clearTimeout(draftSidebarLabelTimer);
  draftSidebarLabelTimer = setTimeout(() => {
    draftSidebarLabelTimer = null;
    void import('./sidebar').then((m) => m.syncComposerDraftSidebarLabels(chat));
  }, DRAFT_SIDEBAR_LABEL_DEBOUNCE_MS);
}

/** True while programmatically restoring draft text into the composer. */
export function isComposerDraftRestoreSuspended(): boolean {
  return draftRestoreSuspended;
}

/** Write unsent composer text onto a chat row (clears when empty). */
export function persistComposerDraftOnChat(chat: Chat, rawText: string): boolean {
  const trimmed = rawText.trim();
  const hadDraft = hasComposerDraft(chat);
  if (trimmed) {
    chat.composerDraft = rawText;
  } else {
    delete chat.composerDraft;
  }
  return hadDraft !== hasComposerDraft(chat);
}

/** Write a pending draft flush now (blur, chat switch, send). */
export function flushComposerDraftSessionSave(chatId?: string): void {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  const id = chatId ?? draftSaveChatId;
  draftSaveChatId = null;
  if (id) scheduleSaveSessions({ chatId: id });
}

function scheduleIdleComposerDraftSave(chatId: string): void {
  draftSaveChatId = chatId;
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    const id = draftSaveChatId;
    draftSaveChatId = null;
    if (id) scheduleSaveSessions({ chatId: id });
  }, DRAFT_SESSION_SAVE_IDLE_MS);
}

// ── Clear ────────────────────────────────────────────────────────────────────

/** Remove persisted draft text after a user message is committed. */
export function clearComposerDraftOnChat(chat: Chat): void {
  delete chat.composerDraft;
}

/** Clear textarea and persisted draft after text is committed (send, queue, or slash command). */
export function clearComposerAfterSend(
  chat: Chat,
  inputEl?: HTMLTextAreaElement | null,
): void {
  const hadDraft = hasComposerDraft(chat);
  clearComposerDraftOnChat(chat);
  clearComposerInput(inputEl ?? getActiveComposerSurface().inputEl);
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
  draftSaveChatId = null;
  if (!hadDraft) return;
  scheduleSaveSessions({ chatId: chat.id });
  void import('./sidebar').then((m) => m.renderSidebar());
  void import('./chat-app').then((m) => m.refreshChatAppSessionRail());
}

/** Snapshot the active composer into a chat before leaving it. */
export function persistComposerDraftForChatId(chatId: string): boolean {
  if (!sessionState) return false;
  const chat = sessionState.chats.find((c) => c.id === chatId);
  if (!chat) return false;
  cancelScheduledDraftInput();
  const input = getActiveComposerSurface().inputEl;
  const text = input ? composerPromptHistoryDraft(input, chatId) : '';
  const changed = persistComposerDraftOnChat(chat, text);
  if (draftSaveChatId === chatId || changed || text.trim()) {
    flushComposerDraftSessionSave(chatId);
  }
  return changed;
}

/** Load a chat's draft into the active composer (or clear when none). */
export function applyComposerDraftForChat(chat: Chat): void {
  const input = getActiveComposerSurface().inputEl;
  if (!input) return;
  draftRestoreSuspended = true;
  input.value = chat.composerDraft ?? '';
  resetComposerPromptHistory(chat.id);
  autoResize(input);
  draftRestoreSuspended = false;
}

// ── Input ────────────────────────────────────────────────────────────────────

/** Track draft edits on the active chat and refresh sidebar when visibility changes. */
export function handleComposerDraftInput(): void {
  const active = sessionState;
  if (draftRestoreSuspended || !active?.activeId) return;
  const chat = active.chats.find((c) => c.id === active.activeId);
  if (!chat) return;

  const input = getActiveComposerSurface().inputEl;
  const text = input ? composerPromptHistoryDraft(input) : '';
  const visibilityChanged = persistComposerDraftOnChat(chat, text);
  if (!visibilityChanged && !hasComposerDraft(chat)) return;

  scheduleIdleComposerDraftSave(chat.id);

  if (visibilityChanged) {
    void import('./sidebar').then((m) => m.renderSidebar());
    void import('./chat-app').then((m) => m.refreshChatAppSessionRail());
  } else {
    scheduleComposerDraftSidebarLabelSync(chat);
  }
}

let draftInputFrame = 0;

function cancelScheduledDraftInput(): void {
  if (!draftInputFrame) return;
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(draftInputFrame);
  } else {
    clearTimeout(draftInputFrame);
  }
  draftInputFrame = 0;
}

/** Run draft persist after the browser paints the new glyph (macOS input lag). */
function scheduleComposerDraftInput(): void {
  if (draftInputFrame) return;
  const run = (): void => {
    draftInputFrame = 0;
    handleComposerDraftInput();
  };
  if (typeof requestAnimationFrame === 'function') {
    draftInputFrame = requestAnimationFrame(run);
    return;
  }
  draftInputFrame = setTimeout(run, 0) as unknown as number;
}

/** Wire draft persistence for one composer textarea. */
export function initComposerDraftListener(inputEl?: HTMLTextAreaElement | null): void {
  const input = inputEl ?? getActiveComposerSurface().inputEl;
  if (!input || input.dataset.draftListener === '1') return;
  input.dataset.draftListener = '1';
  input.addEventListener('input', () => {
    scheduleComposerDraftInput();
  });
  if (!input.dataset.draftBlurListener) {
    input.dataset.draftBlurListener = '1';
    input.addEventListener('blur', () => {
      cancelScheduledDraftInput();
      handleComposerDraftInput();
      flushComposerDraftSessionSave();
    });
  }
}

// ── Switch ───────────────────────────────────────────────────────────────────

/** Flush the active composer, then clear it for a fresh ephemeral chat. */
export function flushActiveComposerDraftBeforeNewChat(): void {
  if (sessionState?.activeId) {
    persistComposerDraftForChatId(sessionState.activeId);
  }
  clearComposerInput(getActiveComposerSurface().inputEl);
  clearAttachments();
}

/** When reusing the current ephemeral chat, just clear the composer. */
export function resetComposerForEphemeralReuse(): void {
  clearComposerInput(getActiveComposerSurface().inputEl);
  clearAttachments();
}

/** Persist leaving chat draft, then restore the target chat draft. */
export function switchComposerDraft(prevChatId: string | null | undefined, nextChat: Chat): void {
  if (prevChatId && prevChatId !== nextChat.id) {
    persistComposerDraftForChatId(prevChatId);
  }
  if (prevChatId !== nextChat.id) clearAttachments();
  applyComposerDraftForChat(nextChat);
}

/** True when the active chat can be reused instead of creating another empty row. */
export function canReuseActiveEphemeralChat(workspacePath: string): boolean {
  try {
    const chat = getActiveChat();
    return (
      isEphemeralEmptyChat(chat) &&
      normalizeWorkspacePath(chat.workspacePath ?? '') === normalizeWorkspacePath(workspacePath)
    );
  } catch {
    return false;
  }
}
