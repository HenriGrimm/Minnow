/**
 * Peek Chats list membership: linked sessions, stale ids, sibling boards.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { listIssuePeekChatRows, type IssuePeekChatLookup } from '../../src/issues/issue-peek-chats.ts';
import type { Chat, IssueCard } from '../../src/types.ts';

function issue(partial: Partial<IssueCard> & Pick<IssueCard, 'id'>): IssueCard {
  return {
    type: 'task',
    title: 'Card',
    description: '',
    status: 'todo',
    priority: 'none',
    labels: [],
    workspacePath: '/w',
    createdAt: 1_000,
    updatedAt: 1_000,
    source: 'user',
    ...partial,
  };
}

function chat(
  id: string,
  extra: Partial<Chat> = {},
): Chat {
  return {
    id,
    name: extra.name ?? id,
    workspacePath: '/w',
    modelId: '',
    modeId: extra.modeId ?? 'build',
    history: [],
    historyLoaded: true,
    lastStats: null,
    modelInfo: {},
    updatedAt: extra.updatedAt ?? 1_000,
    lastMessageAt: extra.lastMessageAt ?? extra.updatedAt ?? 1_000,
    ...extra,
  };
}

function lookup(chats: Chat[], streaming: string[] = []): IssuePeekChatLookup {
  const byId = new Map(chats.map((row) => [row.id, row]));
  const live = new Set(streaming);
  return {
    findChat: (id) => byId.get(id),
    isStreaming: (id) => live.has(id),
  };
}

describe('listIssuePeekChatRows', () => {
  test('orders live chats by last message, missing ids last', () => {
    const older = chat('chat-old', { name: 'Old', lastMessageAt: 10, modeId: 'debug' });
    const newer = chat('chat-new', { name: 'New', lastMessageAt: 99, modeId: 'plan' });
    const rows = listIssuePeekChatRows(
      issue({ id: 'ISS-1', chatIds: ['gone', 'chat-old', 'chat-new'] }),
      lookup([older, newer]),
    );
    assert.deepEqual(
      rows.map((row) => row.chatId),
      ['chat-new', 'chat-old', 'gone'],
    );
    assert.equal(rows[2]?.title, 'Chat unavailable');
    assert.equal(rows[2]?.available, false);
    assert.equal(rows[0]?.modeLabel, 'Plan');
    assert.equal(rows[1]?.modeLabel, 'Debug');
  });

  test('marks streaming chats Running', () => {
    const session = chat('chat-a', { name: 'Agent' });
    const rows = listIssuePeekChatRows(
      issue({ id: 'ISS-1', chatIds: ['chat-a'] }),
      lookup([session], ['chat-a']),
    );
    assert.equal(rows[0]?.running, true);
    assert.equal(rows[0]?.title, 'Agent');
  });

  test('legacy issue links open as chats and duplicate links unlink together', () => {
    const planner = chat('chat-plan', { name: 'Planner' });
    const rows = listIssuePeekChatRows(
      issue({ id: 'ISS-1', chatIds: ['chat-plan'], boardChatId: 'chat-plan' }), lookup([planner]),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.title, 'Planner');
    assert.equal(rows[0]?.unlinkChatId, planner.id);
    assert.equal(rows[0]?.unlinkBoardChat, true);
    const [missing] = listIssuePeekChatRows(issue({ id: 'ISS-1', boardChatId: 'gone' }), lookup([]));
    assert.equal(missing?.available, false);
    assert.equal(missing?.unlinkBoardChat, true);
  });
});
