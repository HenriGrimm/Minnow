import type { Chat } from '../types';

const versions = new WeakMap<Chat, number>();

/** Renderer-only invalidation; persisted revisions and the session protocol are unchanged. */
export function noteChatMutation(chat: Chat): void {
  versions.set(chat, chatMutationVersion(chat) + 1);
}

export function chatMutationVersion(chat: Chat): number {
  return versions.get(chat) ?? 0;
}
