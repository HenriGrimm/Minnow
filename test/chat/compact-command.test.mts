import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compactChatHistory } from '../../src/chat/context/compact-command.ts';
import { parseCompactSlashInput } from '../../src/chat/context/parse-compact-command.ts';
import type { Chat, Message } from '../../src/types.ts';

function chatWithTurns(turns: number): Chat {
  const history: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    history.push({ role: 'user', content: `request ${index}` });
    history.push({ role: 'assistant', content: `answer ${index}` });
  }
  return {
    id: 'compact-test-chat',
    name: 'Compact test',
    createdAt: 1,
    updatedAt: 1,
    history,
  };
}

describe('/compact command', () => {
  test('parses the command, focus notes, and aliases without accepting partial tokens', () => {
    assert.deepEqual(parseCompactSlashInput('/compact'), { notes: null });
    assert.deepEqual(parseCompactSlashInput('/compress keep decisions'), {
      notes: 'keep decisions',
    });
    assert.deepEqual(parseCompactSlashInput('/summarize'), { notes: null });
    assert.equal(parseCompactSlashInput('/compacted'), null);
    assert.equal(parseCompactSlashInput('compact'), null);
  });

  test('writes a manual checkpoint while preserving the transcript rows', () => {
    const chat = chatWithTurns(4);
    const originalLength = chat.history.length;

    const result = compactChatHistory(chat, { notes: 'keep the API decisions' });

    assert.equal(result.ok, true);
    assert.equal(chat.history.length, originalLength + 1);
    assert.equal(chat.history.some((row) => row.role === 'user' && row.content === '/compact'), false);
    const notice = chat.history.at(-1);
    assert.equal(notice?.role, 'context');
    if (notice?.role === 'context') {
      assert.equal(notice.compaction?.trigger, 'manual');
      assert.match(notice.compaction?.summary ?? '', /keep the API decisions/);
    }
  });
});
