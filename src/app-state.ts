import type { ChatStopReason, LmModelRecord } from './types';
import { notifyPluginContextChanged } from './plugins/events';
import { getChatRunActivity, setChatRunActivity } from './state/chat-run-activity';

/** Shared mutable app flags (streaming, abort controllers, debounce timers). */

/** Chats with an in-flight assistant turn (supports concurrent streams). */
export const streamingChatIds = new Set<string>();

/** Per-chat fetch abort for SSE / tool-loop turns. */
export const abortByChatId = new Map<string, AbortController>();

/** Per-chat stop reason recorded before abort; consumed when the turn finalizes. */
const stopReasonByChatId = new Map<string, ChatStopReason>();

export function setChatStopReason(chatId: string, reason: ChatStopReason): void {
  const id = chatId.trim();
  if (!id) return;
  stopReasonByChatId.set(id, reason);
}

/** Read and clear the stop reason for a chat (defaults to `user` when unset). */
export function takeChatStopReason(chatId: string): ChatStopReason {
  const id = chatId.trim();
  if (!id) return 'user';
  const reason = stopReasonByChatId.get(id);
  stopReasonByChatId.delete(id);
  return reason ?? 'user';
}

/**
 * Legacy boolean: true when any chat is streaming.
 * Kept for call sites that gate on global activity (tool approval, legacy UI).
 */
export let streaming = false;

/** @deprecated Use streamingChatIds — kept for gradual migration of dot context. */
export let streamingChatId: string | null = null;

/** Model id → metadata from GET /api/v0/models (used by stats strip). */
export const modelCache = new Map<string, LmModelRecord>();
export let modelsFetchAbort: AbortController | null = null;
export let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Which preset the textarea should match (empty string = Custom). */
export let activeSystemPromptPresetId = '';

/** Avoid re-entrancy when programmatically reverting the preset select after cancel. */
export let suppressSystemPromptSelectChange = false;

/** Debounced assistant markdown render while SSE tokens arrive. */
export let assistantRenderDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** True while the full-page Experts hub covers the chat shell. */
export let expertsPageOpen = false;

/** @deprecated Use expertsPageOpen */
export let expertLabPageOpen = expertsPageOpen;

export function setExpertsPageOpen(value: boolean): void {
  expertsPageOpen = value;
  expertLabPageOpen = value;
}

/** @deprecated Use setExpertsPageOpen */
export function setExpertLabPageOpen(value: boolean): void {
  setExpertsPageOpen(value);
}

export function isExpertsPageOpen(): boolean {
  return expertsPageOpen;
}

function syncLegacyStreamingFlags(): void {
  streaming = streamingChatIds.size > 0;
  streamingChatId =
    streamingChatIds.size === 1 ? [...streamingChatIds][0]! : streamingChatIds.size > 1 ? null : null;
}

/**
 * Register or clear streaming for a chat.
 * `setStreaming(false)` with no chatId clears all entries (use sparingly).
 */
export function setStreaming(value: boolean, chatId?: string | null): void {
  if (value && chatId != null && chatId !== '') {
    streamingChatIds.add(chatId);
    setChatRunActivity(chatId, 'running');
  } else if (!value && chatId != null && chatId !== '') {
    if (streamingChatIds.has(chatId) && getChatRunActivity(chatId) === 'running') setChatRunActivity(chatId, 'interrupted');
    streamingChatIds.delete(chatId);
  } else if (!value) {
    for (const id of streamingChatIds) {
      if (getChatRunActivity(id) === 'running') setChatRunActivity(id, 'interrupted');
    }
    streamingChatIds.clear();
  }
  syncLegacyStreamingFlags();
  notifyPluginContextChanged();
}

export function isAnyChatStreaming(): boolean {
  return streamingChatIds.size > 0;
}

export function getChatAbort(chatId: string): AbortController | undefined {
  return abortByChatId.get(chatId);
}

export function setChatAbort(chatId: string, controller: AbortController | null): void {
  if (controller === null) {
    abortByChatId.delete(chatId);
  } else {
    abortByChatId.set(chatId, controller);
  }
}

export function setModelsFetchAbort(controller: AbortController | null): void {
  modelsFetchAbort = controller;
}

export function setSaveTimer(timer: ReturnType<typeof setTimeout> | null): void {
  saveTimer = timer;
}

export function setActiveSystemPromptPresetId(id: string): void {
  activeSystemPromptPresetId = id;
}

export function setSuppressSystemPromptSelectChange(value: boolean): void {
  suppressSystemPromptSelectChange = value;
}

export function setAssistantRenderDebounceTimer(
  timer: ReturnType<typeof setTimeout> | null,
): void {
  assistantRenderDebounceTimer = timer;
}
