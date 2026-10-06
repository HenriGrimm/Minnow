/**
 * Create-or-reuse the chat that owns one source of background work (MIN-637).
 *
 * Every background spawner used to pass "whatever chat is open right now" as its
 * parent, so an issue expansion or a scheduled run grafted itself onto the user's
 * current conversation. Background work gets its own chat per source instead,
 * found again through a stable `key`.
 *
 * The one rule this module exists to enforce: it never assigns
 * `sessionState.activeId`. Creating a background chat must not move the user.
 */

import { reportBackgroundError } from '../boot/report-background-error.ts';
import type { ModeId } from '../chat/modes/types.ts';
import { decodeModelSelectKey } from '../lib/model-select-key.ts';
import type { Chat } from '../types.ts';
import {
  createEmptyChatObject,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from './sessions.ts';

export interface EnsureBackgroundChatOptions {
  /** Stable identity of the work source: issue id, dev-server id, schedule id. */
  key: string;
  /** Sidebar name used only when the chat is created. */
  name: string;
  /** Workspace to bind on create; defaults to the current workspace. */
  workspacePath?: string;
  /** Operating mode for the new chat; defaults to `build`. */
  modeId?: ModeId;
  /** Model binding override; defaults to the global model picker. */
  modelId?: string;
  providerId?: string;
}

/** Global default model without requiring a DOM (node tests, headless callers). */
function readDefaultModelBinding(): { modelId: string; providerId?: string } {
  if (typeof document === 'undefined') return { modelId: '' };
  const raw =
    (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value?.trim() ??
    '';
  const parsed = decodeModelSelectKey(raw);
  return { modelId: parsed?.modelId ?? raw, providerId: parsed?.providerId };
}

/** Existing background chat for this work source, if one is still around. */
export function findBackgroundChat(key: string): Chat | null {
  const wanted = key.trim();
  if (!wanted || !sessionState) return null;
  return sessionState.chats.find((c) => c.backgroundKey === wanted) ?? null;
}

/**
 * The background chat for `key`, creating it when absent.
 *
 * Returns `null` only when sessions have not loaded yet. Callers should pass the
 * returned chat id as `parentChatId` rather than reading `sessionState.activeId`.
 */
export function ensureBackgroundChat(
  options: EnsureBackgroundChatOptions,
): Chat | null {
  const key = options.key.trim();
  if (!key) return null;

  const existing = findBackgroundChat(key);
  if (existing) return existing;
  if (!sessionState) return null;

  const binding =
    options.modelId !== undefined
      ? { modelId: options.modelId, providerId: options.providerId }
      : readDefaultModelBinding();

  const chat = createEmptyChatObject(binding.modelId, options.workspacePath);
  if (binding.providerId) chat.providerId = binding.providerId;
  chat.name = options.name.trim() || chat.name;
  chat.modeId = options.modeId ?? 'build';
  chat.background = true;
  chat.backgroundKey = key;

  sessionState.chats.unshift(chat);
  touchChat(chat);
  scheduleSaveSessions();

  if (typeof document !== 'undefined') {
    void import('../ui/sidebar.ts')
      .then((m) => m.renderSidebar())
      .catch((err) => reportBackgroundError('background-chat-sidebar', err));
  }

  return chat;
}

/** True when this chat exists to hold background work rather than a user conversation. */
export function isBackgroundChat(chat: Pick<Chat, 'background'>): boolean {
  return chat.background === true;
}
