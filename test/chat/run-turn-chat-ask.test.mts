/**
 * P6-B: chat spike injects AskCapability (fake ask, no Electron modal).
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createChatAskCapability,
  resolveSpikeAskTimeoutMs,
  spikeChatToolDefinitions,
} from '../../src/chat/run-turn-chat.ts';
import { DEFAULT_ASK_TIMEOUT_MS } from '../../server/runner/run-turn.js';
import { setChatMetaForTests, resetChatMetaCache } from '../../src/config/chat-meta.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';

const VALID_ARGS = {
  questions: [
    {
      id: 'q1',
      prompt: 'Ready?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
  ],
};

describe('P6-B chat spike AskCapability (MIN-724)', () => {
  test('spike tool list does not hardcode ask_question', () => {
    const names = spikeChatToolDefinitions().map((tool) => tool.function.name);
    assert.equal(names.includes('ask_question'), false);
  });

  test('createChatAskCapability asks and receives an answer', async () => {
    /** @type {unknown[]} */
    const enqueued = [];
    const capability = createChatAskCapability({
      chatId: CHAT_ID,
      enqueue: async (args, _ctx, chatId) => {
        enqueued.push({ args, chatId });
        return '{"status":"answered","answers":[{"questionId":"q1","selectedIds":["yes"],"otherText":null}]}';
      },
    });
    const content = await capability.ask(VALID_ARGS, {
      signal: new AbortController().signal,
      chatId: CHAT_ID,
    });
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]?.chatId, CHAT_ID);
    assert.equal(typeof content, 'string');
    assert.match(String(content), /"status":"answered"/);
  });

  test('invalid args return an error JSON without enqueueing', async () => {
    let called = 0;
    const capability = createChatAskCapability({
      chatId: CHAT_ID,
      enqueue: async () => {
        called += 1;
        return '';
      },
    });
    const content = await capability.ask({ prompt: 'not a questions array' }, {
      signal: new AbortController().signal,
      chatId: CHAT_ID,
    });
    assert.equal(called, 0);
    assert.match(String(content), /"status":"error"/);
  });

  test('question answer time is independent of the generation silence watchdog', () => {
    resetChatMetaCache();
    setChatMetaForTests({ generationIdleTimeoutMs: 240_000 });
    assert.equal(resolveSpikeAskTimeoutMs(), DEFAULT_ASK_TIMEOUT_MS);
    setChatMetaForTests({ generationIdleTimeoutMs: 0 });
    assert.equal(resolveSpikeAskTimeoutMs(), DEFAULT_ASK_TIMEOUT_MS);
    resetChatMetaCache();
  });
});
