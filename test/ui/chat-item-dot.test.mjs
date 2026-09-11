import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  resolveChatItemDotState,
  resolveGroupHeaderDotState,
  isChatItemDotVisible,
} = await import('../../src/ui/chat-item-dot.ts');

function chat(overrides) {
  return {
    id: 'chat-a',
    name: 'A',
    workspacePath: '',
    modelId: '',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    activeChatId: 'other',
    streamingChatIds: new Set(),
    streamPhaseByChatId: new Map(),
    inputPendingChatId: null,
    ...overrides,
  };
}

describe('chat-item-dot resolveChatItemDotState', () => {
  test('a Super Plan run waiting on the user shows needs-input; a running one shows no spinner', () => {
    const waiting = chat({ modeId: 'super-plan', superPlanView: { runId: 'r', status: 'waiting', needsInput: 'accept', finished: false } });
    assert.equal(resolveChatItemDotState(waiting, ctx()), 'needs-input');
    const halted = chat({ modeId: 'super-plan', superPlanView: { runId: 'r', status: 'halted', needsInput: 'halted', finished: false } });
    assert.equal(resolveChatItemDotState(halted, ctx()), 'needs-input');
    const running = chat({ modeId: 'super-plan', superPlanView: { runId: 'r', status: 'running', needsInput: null, finished: false } });
    assert.equal(resolveChatItemDotState(running, ctx()), 'idle', 'runs are long; a spinner would cost local tokens/s');
  });

  test('inactive chat with no flags is idle', () => {
    const c = ctx({
      streamingChatIds: new Set(['other']),
      streamPhaseByChatId: new Map([['other', 'generating']]),
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'idle');
  });

  test('inactive chat with unread is unread', () => {
    assert.equal(
      resolveChatItemDotState(chat({ unread: true }), ctx()),
      'unread',
    );
  });

  test('background chat in thinking stream resolves working but dot stays non-actionable', () => {
    const c = ctx({
      streamingChatIds: new Set(['chat-b']),
      streamPhaseByChatId: new Map([['chat-b', 'thinking']]),
    });
    assert.equal(resolveChatItemDotState(chat({ id: 'chat-b' }), c), 'working');
  });

  test('active chat streaming generating shows working', () => {
    const c = ctx({
      activeChatId: 'chat-a',
      streamingChatIds: new Set(['chat-a']),
      streamPhaseByChatId: new Map([['chat-a', 'generating']]),
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'working');
  });

  test('active chat in thinking stream phase shows working', () => {
    const c = ctx({
      activeChatId: 'chat-a',
      streamingChatIds: new Set(['chat-a']),
      streamPhaseByChatId: new Map([['chat-a', 'thinking']]),
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'working');
  });

  test('active chat streaming loading_model shows working', () => {
    const c = ctx({
      activeChatId: 'chat-a',
      streamingChatIds: new Set(['chat-a']),
      streamPhaseByChatId: new Map([['chat-a', 'loading_model']]),
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'working');
  });

  test('background chat streaming generating shows working', () => {
    const c = ctx({
      activeChatId: 'other',
      streamingChatIds: new Set(['chat-b']),
      streamPhaseByChatId: new Map([['chat-b', 'generating']]),
    });
    assert.equal(resolveChatItemDotState(chat({ id: 'chat-b' }), c), 'working');
  });

  test('needs-input beats error and unread', () => {
    const c = ctx({
      activeChatId: 'other',
      inputPendingChatId: 'chat-a',
    });
    assert.equal(
      resolveChatItemDotState(chat({ unread: true, turnError: true }), c),
      'needs-input',
    );
  });

  test('error beats unread on inactive chat', () => {
    assert.equal(
      resolveChatItemDotState(chat({ unread: true, turnError: true }), ctx()),
      'error',
    );
  });

  test('inactive chat with turnError is error', () => {
    assert.equal(
      resolveChatItemDotState(chat({ turnError: true }), ctx()),
      'error',
    );
  });

  test('active chat with turnError is idle (dot hidden while viewing)', () => {
    assert.equal(
      resolveChatItemDotState(chat({ turnError: true }), ctx({ activeChatId: 'chat-a' })),
      'idle',
    );
  });

  test('needs-input beats working', () => {
    const c = ctx({
      activeChatId: 'chat-a',
      streamingChatIds: new Set(['chat-a']),
      streamPhaseByChatId: new Map([['chat-a', 'thinking']]),
      inputPendingChatId: 'chat-a',
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'needs-input');
  });

  test('parked ask_question chats stay needs-input via inputPendingChatIds', () => {
    const c = ctx({
      activeChatId: 'other',
      inputPendingChatId: 'other',
      inputPendingChatIds: new Set(['chat-a']),
    });
    assert.equal(resolveChatItemDotState(chat({}), c), 'needs-input');
  });
});

describe('chat-item-dot visibility helpers', () => {
  test('isChatItemDotVisible is true only for actionable states', () => {
    assert.equal(isChatItemDotVisible('unread'), true);
    assert.equal(isChatItemDotVisible('needs-input'), true);
    assert.equal(isChatItemDotVisible('error'), true);
    assert.equal(isChatItemDotVisible('idle'), false);
    assert.equal(isChatItemDotVisible('working'), false);
  });

  test('resolveGroupHeaderDotState picks highest-priority member state', () => {
    const c = ctx({ activeChatId: 'active' });
    const members = [
      chat({ id: 'a', unread: true }),
      chat({ id: 'b', turnError: true }),
      chat({ id: 'c' }),
    ];
    assert.equal(resolveGroupHeaderDotState(members, c), 'error');
  });

  test('resolveGroupHeaderDotState returns null when no member needs attention', () => {
    const c = ctx({ activeChatId: 'active' });
    assert.equal(resolveGroupHeaderDotState([chat({ id: 'a' })], c), null);
  });
});
