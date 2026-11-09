/**
 * Peek Chats membership: linked `chatIds` plus distinct boards those chats
 * (or `boardChatId`) belong to. UI stays in issues-chats-section; this file
 * is the list contract tests pin.
 */

import { getMode } from '../chat/modes/registry';
import { workflowSkillForMode } from '../chat/modes/types';
import type { Chat, ChatGroup, IssueCard } from '../types';

/** One row in the peek Chats list (chat session or sibling board). */
export interface IssuePeekChatRow {
  kind: 'chat' | 'board';
  /** Session used to open or to judge Running/Done. */
  chatId: string;
  title: string;
  /** False when the id is on the issue but the session is gone. */
  available: boolean;
  modeLabel: string | null;
  running: boolean;
  /** lastMessageAt / updatedAt for live chats; 0 for missing ids. */
  sortAt: number;
  boardGroupId?: string;
  /** Clear `boardChatId` when this board row is removed. */
  unlinkBoardChat: boolean;
  /** Drop this id from `chatIds` on Remove (chat rows always; board only if stored). */
  unlinkChatId: string | null;
}

export interface IssuePeekChatLookup {
  findChat: (id: string) => Chat | undefined;
  boardForChat: (chat: Chat) => Pick<ChatGroup, 'id' | 'name'> | undefined;
  isStreaming: (id: string) => boolean;
}

function modeLabelForChat(chat: Chat): string {
  const workflow = workflowSkillForMode(chat.pinnedSkill?.id) ?? workflowSkillForMode(chat.modeId);
  return workflow ? getMode(workflow).label : chat.modeId === 'orchestrate' ? 'Orchestrate' : 'Agent';
}

function chatSortAt(chat: Chat): number {
  return chat.lastMessageAt ?? chat.updatedAt ?? 0;
}

/**
 * Linked chats (last-updated first, missing last) then one board row per
 * distinct group on those chats or on `boardChatId`.
 */
export function listIssuePeekChatRows(
  issue: IssueCard,
  lookup: IssuePeekChatLookup,
): IssuePeekChatRow[] {
  const chatIds = [...new Set((issue.chatIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const live: IssuePeekChatRow[] = [];
  const missing: IssuePeekChatRow[] = [];

  for (const chatId of chatIds) {
    const chat = lookup.findChat(chatId);
    if (!chat) {
      missing.push({
        kind: 'chat',
        chatId,
        title: 'Chat unavailable',
        available: false,
        modeLabel: null,
        running: false,
        sortAt: 0,
        unlinkBoardChat: false,
        unlinkChatId: chatId,
      });
      continue;
    }
    live.push({
      kind: 'chat',
      chatId,
      title: chat.name.trim() || 'Untitled chat',
      available: true,
      modeLabel: modeLabelForChat(chat),
      running: lookup.isStreaming(chatId),
      sortAt: chatSortAt(chat),
      unlinkBoardChat: false,
      unlinkChatId: chatId,
    });
  }

  live.sort((a, b) => b.sortAt - a.sortAt);
  const chatRows = [...live, ...missing];

  const boards = new Map<string, IssuePeekChatRow>();
  const boardChatId = issue.boardChatId?.trim() || '';

  const rememberBoard = (
    group: Pick<ChatGroup, 'id' | 'name'>,
    openChatId: string,
    unlinkBoard: boolean,
    unlinkChatId: string | null,
    available: boolean,
    running: boolean,
  ): void => {
    const existing = boards.get(group.id);
    if (existing) {
      existing.unlinkBoardChat = existing.unlinkBoardChat || unlinkBoard;
      if (!existing.unlinkChatId && unlinkChatId) existing.unlinkChatId = unlinkChatId;
      if (running) existing.running = true;
      return;
    }
    boards.set(group.id, {
      kind: 'board',
      chatId: openChatId,
      title: group.name.trim() || 'Board',
      available,
      modeLabel: null,
      running,
      sortAt: 0,
      boardGroupId: group.id,
      unlinkBoardChat: unlinkBoard,
      unlinkChatId,
    });
  };

  for (const chatId of chatIds) {
    const chat = lookup.findChat(chatId);
    if (!chat) continue;
    const group = lookup.boardForChat(chat);
    if (!group) continue;
    rememberBoard(
      group,
      chatId,
      boardChatId === chatId,
      null,
      true,
      lookup.isStreaming(chatId),
    );
  }

  if (boardChatId) {
    const boardChat = lookup.findChat(boardChatId);
    const group = boardChat ? lookup.boardForChat(boardChat) : undefined;
    if (group) {
      rememberBoard(
        group,
        boardChatId,
        true,
        chatIds.includes(boardChatId) ? boardChatId : null,
        true,
        lookup.isStreaming(boardChatId),
      );
    } else if (![...boards.values()].some((row) => row.chatId === boardChatId)) {
      boards.set(`board-chat:${boardChatId}`, {
        kind: 'board',
        chatId: boardChatId,
        title: boardChat ? boardChat.name.trim() || 'Board' : 'Board unavailable',
        available: Boolean(boardChat),
        modeLabel: null,
        running: lookup.isStreaming(boardChatId),
        sortAt: 0,
        unlinkBoardChat: true,
        unlinkChatId: chatIds.includes(boardChatId) ? boardChatId : null,
      });
    }
  }

  return [...chatRows, ...boards.values()];
}
