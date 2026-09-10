/**
 * P10-D (MIN-769) — decorating transcript store.
 *
 * Persisted rows must match what `renderChatFromHistory` reads: thinking[],
 * stats/usage, tool attachments/codeChange — not wire reasoning or inner-loop
 * nudge user bubbles.
 */

import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { Chat, Message, TurnSnapshot } from '../../src/types.ts';
import {
  createEmptyChatObject,
  getSessionDirtyTrackingForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { createRun, findRunById } from '../../src/state/runs-store.ts';
import { overlayMultimodalHistoryForRunTurn } from '../../src/chat/build-api-messages.ts';
import { createSessionTranscriptStore } from '../../src/agents/session-transcript-store.ts';
import { createChatTranscriptStore } from '../../src/chat/chat-transcript-store.ts';
import {
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
  EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  INTENT_TO_ACT_RETRY_INSTRUCTION,
  PROSE_QUESTION_RETRY_INSTRUCTION,
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
} from '../../src/tools/turn-continuation.ts';
import { ThoughtBubbleController } from '../../src/ui/thought-bubbles.ts';

const CHAT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const TOOL_ATTACHMENTS = [
  { type: 'image' as const, url: '/tmp/shot.png', mime: 'image/png' as const, alt: 'shot' },
];
const TOOL_CODE_CHANGE = {
  additions: 3,
  deletions: 1,
  path: 'src/a.ts',
  source: 'file-tool' as const,
};
const ROUND_USAGE = { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 };
const ROUND_STATS = { tokens_per_second: 12.5, time_to_first_token: 0.2 };

function baseSnapshot(): TurnSnapshot {
  return {
    forkHistoryIndex: 0,
    userContent: 'What time is it?',
    skillId: null,
    providerId: 'vite-fallback',
    modelId: 'm1',
    temperature: 0.7,
    maxTokens: 4096,
    thinkingMode: 'on',
    modeId: 'build',
    workAgentId: null,
    workAgentAuto: true,
    composedSystemPrompt: 'You are a helpful assistant.',
    enabledToolNames: ['get_datetime'],
    historyPrefixHash: 'abc123',
  };
}

function makeChat(): Chat {
  const chat = createEmptyChatObject('m1');
  chat.id = CHAT_ID;
  chat.providerId = 'vite-fallback';
  chat.modelId = 'm1';
  chat.history = [{ role: 'user', content: 'What time is it?' }];
  return chat;
}

function install(chat: Chat): void {
  setSessionStateForTests({
    version: 3,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
}

describe('P10-D chat transcript decorator (MIN-769)', () => {
  test('persists exact provider blocks separately from formatted thoughts and restores replay', async () => {
    const chat = makeChat();
    chat.modelId = 'claude-opus-5';
    install(chat);
    const store = createChatTranscriptStore();
    const blocks: import('../../src/types').AnthropicThinkingBlock[] = [
      { type: 'thinking', thinking: '  Read\n\n\nprices.  ', signature: 'sig' },
      { type: 'redacted_thinking', data: 'opaque' },
    ];
    store.observe({ type: 'round_start', index: 0 });
    store.observe({ type: 'thinking', text: blocks[0].type === 'thinking' ? blocks[0].thinking : '' });
    store.append(CHAT_ID, { role: 'assistant', content: null,
      tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_page', arguments: '{}' } }],
      reasoning_blocks: blocks,
    });
    store.append(CHAT_ID, { role: 'tool', tool_call_id: 'read', content: '$20' });
    const saved = JSON.parse(JSON.stringify(chat.history));
    assert.deepEqual(saved[1].thinkingBlocks, blocks);
    assert.equal(saved[1].reasoning_blocks, undefined);
    assert.deepEqual(saved[1].thinking, ['Read', 'prices.']);
    chat.history = saved;
    const { buildApiMessages } = await import('../../src/chat/build-api-messages.ts');
    const messages = buildApiMessages(chat, 'System', { modelId: chat.modelId });
    const replay = messages.find(m => m.role === 'assistant');
    assert.deepEqual(replay?.role === 'assistant' ? replay.reasoning_blocks : undefined, blocks);
  });

  afterEach(() => {
    setSessionStateForTests(null);
  });

  test('tool turn round-trips thoughts, stats, attachments, and code-change', () => {
    const chat = makeChat();
    install(chat);
    const run = createRun(chat, baseSnapshot());
    const store = createChatTranscriptStore({ turnRunId: run.runId });

    store.observe({ type: 'round_start', index: 0 });
    store.observe({ type: 'thinking', text: 'I should call get_datetime' });
    store.observe({ type: 'reasoning_end' });
    store.observe({
      type: 'stream_meta',
      usage: ROUND_USAGE,
      stats: ROUND_STATS,
      finishReason: 'tool_calls',
    });
    store.append(CHAT_ID, {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_dt',
          type: 'function',
          function: { name: 'get_datetime', arguments: '{}' },
        },
      ],
      reasoning: 'I should call get_datetime',
      reasoning_content: 'I should call get_datetime',
      reasoning_signature: 'sig-wire',
    });
    assert.equal(store.lastAssistantHistoryIndex(), 1);
    store.observe({
      type: 'tool_result',
      name: 'get_datetime',
      id: 'call_dt',
      content: '2026-08-31T12:00:00.000Z',
      attachments: TOOL_ATTACHMENTS,
      codeChange: TOOL_CODE_CHANGE,
    });
    store.append(CHAT_ID, {
      role: 'tool',
      tool_call_id: 'call_dt',
      content: '2026-08-31T12:00:00.000Z',
    });
    store.observe({
      type: 'round_end',
      index: 0,
      text: '',
      reasoning: 'I should call get_datetime',
      toolCallCount: 1,
      usage: ROUND_USAGE,
      stats: ROUND_STATS,
      finishReason: 'tool_calls',
      t0: 0,
      tFirst: 1,
      tEnd: 2,
    });

    const assistant = chat.history.find((m) => m.role === 'assistant') as Extract<
      Message,
      { role: 'assistant' }
    >;
    const tool = chat.history.find((m) => m.role === 'tool') as Extract<
      Message,
      { role: 'tool' }
    >;

    assert.ok(assistant);
    assert.deepEqual(assistant.thinking, ['I should call get_datetime']);
    // round_end reconciles via finalizeResponseMeta — server timing fields survive.
    assert.equal(assistant.stats?.tokens_per_second, ROUND_STATS.tokens_per_second);
    assert.equal(assistant.stats?.time_to_first_token, ROUND_STATS.time_to_first_token);
    assert.deepEqual(assistant.usage, ROUND_USAGE);
    assert.equal('reasoning' in assistant, false);
    assert.equal('reasoning_content' in assistant, false);
    assert.equal('reasoning_signature' in assistant, false);

    assert.ok(tool);
    assert.deepEqual(tool.attachments, TOOL_ATTACHMENTS);
    assert.deepEqual(tool.codeChange, TOOL_CODE_CHANGE);

    const recorded = findRunById(chat, run.runId);
    assert.equal(recorded?.outputHistoryStart, 1);
    assert.equal(recorded?.outputHistoryEnd, 2);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [CHAT_ID]);
  });

  test('inner-loop control user rows are not persisted', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.append(CHAT_ID, {
      role: 'user',
      content: SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
    });
    store.append(CHAT_ID, {
      role: 'user',
      content: EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
    });
    store.append(CHAT_ID, {
      role: 'user',
      content: PROSE_QUESTION_RETRY_INSTRUCTION,
    });
    store.append(CHAT_ID, {
      role: 'user',
      content: INTENT_TO_ACT_RETRY_INSTRUCTION,
    });
    store.append(CHAT_ID, {
      role: 'user',
      content: CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
    });
    store.append(CHAT_ID, { role: 'assistant', content: 'It is noon.' });

    assert.deepEqual(
      chat.history.map((m) => m.role),
      ['user', 'assistant'],
    );
    assert.equal(chat.history[0]?.content, 'What time is it?');
    assert.equal(chat.history[1]?.content, 'It is noon.');
  });

  test('pure-reasoning reply persists thinking and is not an empty bubble', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({ type: 'round_start', index: 0 });
    store.observe({ type: 'thinking', text: 'Step A\n\nStep B' });
    store.observe({
      type: 'round_end',
      index: 0,
      text: '',
      reasoning: 'Step A\n\nStep B',
      toolCallCount: 0,
      finishReason: 'stop',
      t0: 0,
      tFirst: 1,
      tEnd: 2,
    });
    store.append(CHAT_ID, { role: 'assistant', content: '', reasoning: 'Step A\n\nStep B' });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.ok(assistant);
    assert.deepEqual(assistant.thinking, ['Step A', 'Step B']);
    assert.ok(typeof assistant.content === 'string' && assistant.content.trim().length > 0);
    assert.equal('reasoning' in assistant, false);
  });

  test('finishReason length lands truncated on the persisted row', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({
      type: 'round_end',
      index: 0,
      text: 'Hello wor',
      reasoning: '',
      toolCallCount: 0,
      finishReason: 'length',
      t0: 0,
      tFirst: 1,
      tEnd: 2,
    });
    store.append(CHAT_ID, { role: 'assistant', content: 'Hello wor' });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.truncated, true);
  });

  test('empty assistant without thinking persists a placeholder, not a silent empty row', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({ type: 'round_start', index: 0 });
    store.observe({
      type: 'round_end',
      index: 0,
      text: '',
      reasoning: '',
      toolCallCount: 0,
      finishReason: 'stop',
      t0: 0,
      tFirst: null,
      tEnd: 1,
    });
    store.append(CHAT_ID, { role: 'assistant', content: '' });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.ok(typeof assistant.content === 'string' && assistant.content.trim().length > 0);
  });

  test('tool-round round_end patches truncated onto the already-persisted assistant', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.append(CHAT_ID, {
      role: 'assistant',
      content: 'Hello wor',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_datetime', arguments: '{}' },
        },
      ],
    });
    store.observe({
      type: 'round_end',
      index: 0,
      text: 'Hello wor',
      reasoning: '',
      toolCallCount: 1,
      finishReason: 'length',
      t0: 0,
      tFirst: 1,
      tEnd: 2,
    });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.truncated, true);
  });

  test('ThoughtBubbleController segments win over wire reasoning', () => {
    const chat = makeChat();
    install(chat);
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const controller = new ThoughtBubbleController(wrap);
    controller.appendReasoningDelta('Controller thought');
    const store = createChatTranscriptStore({ thoughtController: controller });

    store.append(CHAT_ID, {
      role: 'assistant',
      content: 'Reply.',
      reasoning: 'Wire thought that must not persist',
    });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.deepEqual(assistant.thinking, ['Controller thought']);
    assert.equal('reasoning' in assistant, false);
  });

  test('noteGeneration records the id and marks the chat dirty', () => {
    const chat = makeChat();
    install(chat);
    const run = createRun(chat, baseSnapshot());
    const store = createChatTranscriptStore({ turnRunId: run.runId });

    store.noteGeneration(CHAT_ID, 'gen-fixed-1');

    assert.deepEqual(findRunById(chat, run.runId)?.generationIds, ['gen-fixed-1']);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, [CHAT_ID]);
  });

  test('load stays in step with overlayMultimodalHistoryForRunTurn', () => {
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      {
        role: 'injection',
        kind: 'brain-notes',
        body: 'notes',
        createdAt: 1,
      },
      { role: 'user', content: 'second' },
    ] as Message[];
    install(chat);

    const decorated = createChatTranscriptStore();
    const bare = createSessionTranscriptStore();
    const overlay = overlayMultimodalHistoryForRunTurn(chat, { attachments: [] });

    assert.equal(decorated.load(CHAT_ID)?.messages.length, bare.load(CHAT_ID)?.messages.length);
    assert.equal(decorated.load(CHAT_ID)?.messages.length, overlay.length);
  });

  test('round_end without server stats persists client-derived timing chips', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({ type: 'round_start', index: 0 });
    store.append(CHAT_ID, {
      role: 'assistant',
      content: 'Done.',
    });
    store.observe({
      type: 'round_end',
      index: 0,
      text: 'Done.',
      reasoning: '',
      toolCallCount: 0,
      usage: { total_tokens: 15522, completion_tokens: 200 },
      finishReason: 'stop',
      t0: 0,
      tFirst: 100,
      tEnd: 5_100,
    });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.usage?.total_tokens, 15522);
    assert.ok(assistant.stats?.time_to_first_token != null);
    assert.ok(assistant.stats?.generation_time != null);
    assert.ok(assistant.stats?.tokens_per_second != null);
  });

  test('round_end fills total_tokens from prompt + completion', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({ type: 'round_start', index: 0 });
    store.append(CHAT_ID, {
      role: 'assistant',
      content: 'Hello.',
    });
    store.observe({
      type: 'round_end',
      index: 0,
      text: 'Hello.',
      reasoning: '',
      toolCallCount: 0,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      stats: {
        tokens_per_second: 40,
        time_to_first_token: 0.2,
        generation_time: 1.25,
        prompt_tokens_per_second: 5000,
        draft_acceptance: 0.6,
      },
      finishReason: 'stop',
      t0: 0,
      tFirst: 200,
      tEnd: 1_450,
    });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.usage?.total_tokens, 150);
    assert.equal(assistant.stats?.tokens_per_second, 40);
    assert.equal(assistant.stats?.prompt_tokens_per_second, 5000);
    assert.equal(assistant.stats?.draft_acceptance, 0.6);
  });

  test('round_end derives usage from stream_meta llama timings when usage is omitted', () => {
    const chat = makeChat();
    install(chat);
    const store = createChatTranscriptStore();

    store.observe({ type: 'round_start', index: 0 });
    store.observe({
      type: 'stream_meta',
      stats: {
        tokens_per_second: 146.55,
        time_to_first_token: 1.45,
        generation_time: 1.36,
      },
      runtime: {
        timings: {
          prompt_n: 7797,
          predicted_n: 200,
          predicted_ms: 1364,
          predicted_per_second: 146.55,
        },
      },
    });
    store.append(CHAT_ID, {
      role: 'assistant',
      content: 'Hello.',
    });
    store.observe({
      type: 'round_end',
      index: 0,
      text: 'Hello.',
      reasoning: '',
      toolCallCount: 0,
      stats: {
        tokens_per_second: 146.55,
        time_to_first_token: 1.45,
        generation_time: 1.36,
      },
      finishReason: 'stop',
      t0: 0,
      tFirst: 1450,
      tEnd: 2814,
    });

    const assistant = chat.history[1] as Extract<Message, { role: 'assistant' }>;
    assert.equal(assistant.usage?.prompt_tokens, 7797);
    assert.equal(assistant.usage?.completion_tokens, 200);
    assert.equal(assistant.usage?.total_tokens, 7997);
    assert.equal(assistant.stats?.tokens_per_second, 146.55);
  });
});
