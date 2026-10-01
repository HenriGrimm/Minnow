import type { Chat } from '../types';
import { getChatLastMessageAt } from '../state/session-workspace-scope';
import type { Command } from './command-registry';

/** Metadata only: unopened transcripts must remain lazy. */
export function buildRecentChatCommands(chats: Chat[], openChat: (id: string) => void): Command[] {
  return [...chats]
    .sort((a, b) => getChatLastMessageAt(b) - getChatLastMessageAt(a))
    .slice(0, 12)
    .map((chat) => ({
      id: `chat.recent.${chat.id}`,
      title: chat.name?.trim() || 'Untitled chat',
      group: 'Recent chats',
      category: 'Chats',
      keywords: 'recent conversation session resume',
      run: () => openChat(chat.id),
    }));
}
