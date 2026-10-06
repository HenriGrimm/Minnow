import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  acknowledgeFailedAssistantOutput,
  clearFailedAssistantOutput,
  copyHistoryForOutboundApi,
  indexOfLastFailedAssistantAtTail,
  repairSessionHistoryTail,
  rollbackFailedTurnHistory,
  turnProducedOutput,
} from '../../src/chat/history.ts';
import { hasPostToolTail } from '../../src/tools/turn-continuation.ts';
import type { Chat, Message } from '../../src/types.ts';

function poisonedChat(): Chat {
  const history: Message[] = [
    { role: 'user', content: 'read missing file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"nope"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'Error: not found' },
  ];
  return {
    id: 'chat_test',
    title: 'test',
    modeId: 'general',
    history,
    lastStats: null,
    modelInfo: {},
    updatedAt: 0,
  };
}

describe('chat/history (MIN-184)', () => {
  test('copyHistoryForOutboundApi drops incomplete assistant tool_calls tail', () => {
    const history: Message[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'get_datetime', arguments: '{}' },
          },
        ],
      },
    ];
    const outbound = copyHistoryForOutboundApi(history);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].role, 'user');
    assert.equal(history.length, 2);
  });

  test('rollbackFailedTurnHistory keeps user row and drops partial tool loop', () => {
    const chat = poisonedChat();
    assert.equal(hasPostToolTail(chat.history), true);
    const ok = rollbackFailedTurnHistory(chat, 0);
    assert.equal(ok, true);
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0].role, 'user');
    assert.equal(hasPostToolTail(chat.history), false);
  });

  test('rollbackFailedTurnHistory is false when nothing to remove', () => {
    const chat = poisonedChat();
    chat.history = chat.history.slice(0, 1);
    assert.equal(rollbackFailedTurnHistory(chat, 0), false);
  });

  test('repairSessionHistoryTail drops only incomplete tool chains', () => {
    const history: Message[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_x',
            type: 'function',
            function: { name: 'get_datetime', arguments: '{}' },
          },
        ],
      },
    ];
    const chat: Chat = {
      id: 'chat_incomplete',
      title: 'test',
      modeId: 'general',
      history,
      lastStats: null,
      modelInfo: {},
      updatedAt: 0,
    };
    assert.equal(repairSessionHistoryTail(chat), true);
    assert.equal(chat.history.length, 1);
  });

  // A Stop mid tool batch leaves exactly this shape. The next user send used to
  // slice back to the last user row, deleting the whole turn the user was following
  // up on; a paired tail is legal history and now survives the repair.
  test('repairSessionHistoryTail keeps an answered tool tail before reprompt', () => {
    const chat = poisonedChat();
    assert.equal(hasPostToolTail(chat.history), true);
    assert.equal(repairSessionHistoryTail(chat), false);
    assert.equal(chat.history.length, 3);
    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['user', 'assistant', 'tool'],
    );
  });

  test('turnProducedOutput is true when assistant or tool rows exist after user fork', () => {
    const chat = poisonedChat();
    assert.equal(turnProducedOutput(chat.history, 0), true);
  });

  test('turnProducedOutput is false for user-only history at fork', () => {
    const chat = poisonedChat();
    chat.history = chat.history.slice(0, 1);
    assert.equal(turnProducedOutput(chat.history, 0), false);
  });

  test('rollback still drops partial tool loop when no output was produced', () => {
    const chat = poisonedChat();
    const ok = rollbackFailedTurnHistory(chat, 0);
    assert.equal(ok, true);
    assert.equal(chat.history.length, 1);
  });
});

describe('clearFailedAssistantOutput (MIN-666)', () => {
  function failedTurnChat(): Chat {
    const history: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'now do X' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'assistant', content: 'Partial answer befo', failed: true },
    ];
    return {
      id: 'chat_failed',
      title: 'test',
      modeId: 'general',
      history,
      lastStats: null,
      modelInfo: {},
      updatedAt: 0,
    };
  }

  test('drops only the failed assistant row and keeps the user prompt', () => {
    const chat = failedTurnChat();
    const ok = clearFailedAssistantOutput(chat, 2);
    assert.equal(ok, true);
    assert.equal(chat.history.length, 5);
    assert.equal(chat.history[2].role, 'user');
    assert.equal(chat.history[2].content, 'now do X');
    assert.equal(chat.history.at(-1)?.role, 'tool');
    assert.equal(
      chat.history.some((m) => m.role === 'assistant' && 'failed' in m && m.failed),
      false,
    );
  });

  test('does not wipe earlier successful turns', () => {
    const chat = failedTurnChat();
    clearFailedAssistantOutput(chat, 2);
    assert.equal(chat.history[0].content, 'hello');
    assert.equal(chat.history[1].content, 'Hi there.');
  });

  test('is a no-op when there is no failed assistant after the fork', () => {
    const chat = poisonedChat();
    assert.equal(clearFailedAssistantOutput(chat, 0), false);
    assert.equal(chat.history.length, 3);
  });

  test('indexOfLastFailedAssistantAtTail ignores a failed row after a later user message', () => {
    const history: Message[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'partial', failed: true },
      { role: 'user', content: 'two' },
    ];
    assert.equal(indexOfLastFailedAssistantAtTail(history), -1);
  });
});

test('acknowledging Continue keeps tool results and earlier failures intact', () => {
  const history: Message[] = [
    { role: 'user', content: 'Earlier turn' },
    { role: 'assistant', content: 'Earlier partial', failed: true },
    { role: 'user', content: 'Current turn' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'Actual result' },
    { role: 'assistant', content: 'Current partial', failed: true, thinking: ['Checking'] },
  ];
  const before = structuredClone(history);
  assert.equal(acknowledgeFailedAssistantOutput(history), true);
  delete (before[5] as Extract<Message, { role: 'assistant' }>).failed;
  assert.deepEqual(history, before);
  assert.equal(acknowledgeFailedAssistantOutput(history), false);
});
