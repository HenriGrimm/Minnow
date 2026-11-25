import { getMode } from '../chat/modes/registry';
import { workflowSkillForMode } from '../chat/modes/types';
import type { Chat, IssueCard } from '../types';

/** One row in the peek Chats list of linked sessions. */
export interface IssuePeekChatRow {
  /** Session used to open or to judge Running/Done. */
  chatId: string;
  title: string;
  /** False when the id is on the issue but the session is gone. */
  available: boolean;
  modeLabel: string | null;
  running: boolean;
  /** lastMessageAt / updatedAt for live chats; 0 for missing ids. */
  sortAt: number;
  /** Clear `boardChatId` when removing a legacy link. */
  unlinkBoardChat: boolean;
  /** Drop this id from `chatIds` on Remove. */
  unlinkChatId: string | null;
}

export interface IssuePeekChatLookup {
  findChat: (id: string) => Chat | undefined;
  isStreaming: (id: string) => boolean;
}

function modeLabelForChat(chat: Chat): string {
  const workflow = workflowSkillForMode(chat.pinnedSkill?.id) ?? workflowSkillForMode(chat.modeId);
  return workflow ? getMode(workflow).label : 'Agent';
}

function chatSortAt(chat: Chat): number {
  return chat.lastMessageAt ?? chat.updatedAt ?? 0;
}

/** Live linked chats first, ordered by activity, followed by missing sessions. */
export function listIssuePeekChatRows(
  issue: IssueCard,
  lookup: IssuePeekChatLookup,
): IssuePeekChatRow[] {
  const legacyId = issue.boardChatId?.trim();
  const chatIds = new Set((issue.chatIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (legacyId) chatIds.add(legacyId);
  const live: IssuePeekChatRow[] = [];
  const missing: IssuePeekChatRow[] = [];

  for (const chatId of chatIds) {
    const chat = lookup.findChat(chatId);
    if (!chat) {
      missing.push({
        chatId,
        title: 'Chat unavailable',
        available: false,
        modeLabel: null,
        running: false,
        sortAt: 0,
        unlinkBoardChat: chatId === legacyId,
        unlinkChatId: chatId,
      });
      continue;
    }
    live.push({
      chatId,
      title: chat.name.trim() || 'Untitled chat',
      available: true,
      modeLabel: modeLabelForChat(chat),
      running: lookup.isStreaming(chatId),
      sortAt: chatSortAt(chat),
      unlinkBoardChat: chatId === legacyId,
      unlinkChatId: chatId,
    });
  }

  live.sort((a, b) => b.sortAt - a.sortAt);
  return [...live, ...missing];
}
