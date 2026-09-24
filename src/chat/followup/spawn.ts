/**
 * Spawn the next /followup chat (MIN-206).
 *
 * One link of a chain: create the chat, hand it the decremented chain record, and
 * seed it with the previous chat's context summary plus the task. The first link is
 * the user's own next task, so it opens in front of them; later links arrive as
 * background chats (sidebar unread dot) rather than yanking the window away.
 */

import { ensureBackgroundChat, findBackgroundChat } from '../../state/background-chat';
import {
  clearFollowupChain,
  findChatById,
  getFollowupChain,
  scheduleSaveSessions,
  setFollowupChain,
  touchChat,
} from '../../state/sessions';
import type { Chat, FollowupChainState } from '../../types';
import type { CreateChatWithModeOptions, CreateChatWithModeResult } from '../../ui/sidebar';
import { composeFollowupSeedMessage, followupTitleSeed } from './seed-message';

/** Sidebar name cap for a spawned link. */
const MAX_BACKGROUND_NAME_TASK_CHARS = 60;
const pendingSendChatIds = new Set<string>();

/** A child chain cannot advance until its seeded turn finishes. */
export function isFollowupSendPending(chatId: string): boolean {
  return pendingSendChatIds.has(chatId);
}

export interface SpawnFollowupInput {
  /** Chat that owns the chain record and is handing the work forward. */
  sourceChat: Chat;
  chain: FollowupChainState;
  taskText: string;
  /** Context summary of `sourceChat`, already built. */
  summary: string;
  /** Becomes false when the user stops or replaces the source chain. */
  isCurrent?: () => boolean;
}

export interface FollowupSpawnDeps {
  createForegroundChat: (
    options: CreateChatWithModeOptions,
    isCurrent?: () => boolean,
  ) => CreateChatWithModeResult | Promise<CreateChatWithModeResult>;
  ensureBackgroundChat: typeof ensureBackgroundChat;
  send: (
    chat: Chat,
    text: string,
    options: { parseSlash: boolean; titleSeed: string; requireCompletedTurn: true },
  ) => Promise<void>;
}

export type SpawnFollowupResult =
  | { ok: true; chatId: string }
  | { ok: false; error: string };

async function defaultCreateForegroundChat(
  options: CreateChatWithModeOptions,
  isCurrent: () => boolean = () => true,
): Promise<CreateChatWithModeResult> {
  const { createChatWithMode } = await import('../../ui/sidebar');
  if (!isCurrent()) return { ok: false, error: 'follow-up chain was stopped' };
  return createChatWithMode(options);
}

async function defaultSend(
  chat: Chat,
  text: string,
  options: { parseSlash: boolean; titleSeed: string; requireCompletedTurn: true },
): Promise<void> {
  const { sendProgrammaticChatText } = await import('../messaging');
  await sendProgrammaticChatText(chat, text, options);
}

const DEFAULT_DEPS: FollowupSpawnDeps = {
  createForegroundChat: defaultCreateForegroundChat,
  ensureBackgroundChat,
  send: defaultSend,
};

/** Create the next follow-up chat and start its first turn. */
export async function spawnFollowupChat(
  input: SpawnFollowupInput,
  deps: Partial<FollowupSpawnDeps> = {},
): Promise<SpawnFollowupResult> {
  const { createForegroundChat, ensureBackgroundChat: ensureBackground, send } = {
    ...DEFAULT_DEPS,
    ...deps,
  };

  const { sourceChat, chain } = input;
  const linkNumber = chain.index + 1;
  const taskText = input.taskText.trim();
  const workspacePath = sourceChat.workspacePath?.trim() || undefined;
  const isCurrent = input.isCurrent ?? (() => true);
  const key = `followup:${chain.chainId}:${linkNumber}`;

  if (!isCurrent()) return { ok: false, error: 'follow-up chain was stopped' };

  let chatId = '';
  try {
    if (linkNumber === 1) {
      const existing = findBackgroundChat(key);
      if (existing) {
        chatId = existing.id;
      } else {
        const created = await createForegroundChat({
          modeId: chain.modeId,
          workspacePath,
          modelId: sourceChat.modelId,
          providerId: sourceChat.providerId,
          forceNewChat: true,
        }, isCurrent);
        if (!created.ok || !created.chatId) {
          return { ok: false, error: created.error ?? 'could not create the follow-up chat' };
        }
        chatId = created.chatId;
      }
    } else {
      const created = ensureBackground({
        key,
        name: `Follow-up ${linkNumber}/${chain.total}: ${taskText.slice(0, MAX_BACKGROUND_NAME_TASK_CHARS)}`,
        workspacePath,
        modeId: chain.modeId,
        modelId: sourceChat.modelId,
        providerId: sourceChat.providerId,
      });
      if (!created) return { ok: false, error: 'sessions are not loaded yet' };
      chatId = created.id;
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'could not create the follow-up chat',
    };
  }

  const chat = findChatById(chatId);
  if (!chat) return { ok: false, error: 'follow-up chat disappeared before seeding' };
  if (!isCurrent()) return { ok: false, error: 'follow-up chain was stopped' };
  if (linkNumber === 1 && chat.backgroundKey !== key) {
    chat.backgroundKey = key;
    touchChat(chat);
    scheduleSaveSessions();
  }

  const remaining = chain.total - linkNumber;
  const childChain: FollowupChainState | null = remaining > 0
    ? {
        ...chain,
        index: linkNumber,
        remaining,
        promptText: '',
        parentChatId: sourceChat.id,
      }
    : null;
  if (childChain) {
    pendingSendChatIds.add(chat.id);
    setFollowupChain(chat, childChain);
  }

  try {
    await send(chat, composeFollowupSeedMessage({
      sourceChatName: sourceChat.name,
      index: linkNumber,
      total: chain.total,
      summary: input.summary,
      taskText,
    }), {
      // The seeded summary must never be read as a slash skill.
      parseSlash: false,
      titleSeed: followupTitleSeed(taskText),
      requireCompletedTurn: true,
    });
  } catch (err) {
    const childWasStopped = Boolean(childChain && getFollowupChain(chat) !== childChain);
    if (childChain && !childWasStopped) clearFollowupChain(chat);
    if (childWasStopped && getFollowupChain(sourceChat) === chain) {
      // Stopping from the focused child also stops the source's in-flight handoff.
      clearFollowupChain(sourceChat);
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'could not start the follow-up chat',
    };
  } finally {
    pendingSendChatIds.delete(chat.id);
  }

  if (childChain && getFollowupChain(chat) !== childChain) {
    if (getFollowupChain(sourceChat) === chain) clearFollowupChain(sourceChat);
    return { ok: false, error: 'follow-up chain was stopped' };
  }
  if (!isCurrent()) {
    if (childChain && getFollowupChain(chat) === childChain) clearFollowupChain(chat);
    return { ok: false, error: 'follow-up chain was stopped' };
  }

  return { ok: true, chatId };
}
