/**
 * OpenAI SSE encoder for Anthropic bridge stream parts.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createOpenAiSseEncoder,
  encodeNonStreamingCompletion,
  encodeOpenAiSseDone,
  mapOpenAiFinishReason,
} from '../../server/generations/anthropic/openai-sse-encoder.js';

/** Minimal merge for tests (mirrors mergeToolCallDelta in chat.ts). */
function mergeToolCallDelta(acc, chunk) {
  const deltas = chunk.choices?.[0]?.delta?.tool_calls;
  if (!deltas?.length) return acc;

  const next = { ...acc };
  for (const d of deltas) {
    const idx = d.index;
    const existing = next[idx] || { type: 'function', function: { name: '', arguments: '' } };
    const merged = {
      ...existing,
      type: 'function',
      function: {
        name: existing.function?.name || '',
        arguments: existing.function?.arguments || '',
      },
    };
    if (d.id) merged.id = d.id;
    if (d.function?.name) {
      merged.function = {
        ...merged.function,
        name: (merged.function?.name || '') + d.function.name,
      };
    }
    if (d.function?.arguments) {
      merged.function = {
        ...merged.function,
        arguments: (merged.function?.arguments || '') + d.function.arguments,
      };
    }
    next[idx] = merged;
  }
  return next;
}

function parseSseDataLine(line) {
  const trimmed = line.trim();
  assert.ok(trimmed.startsWith('data: '));
  const payload = trimmed.slice('data: '.length);
  if (payload === '[DONE]') return payload;
  return JSON.parse(payload);
}

describe('mapOpenAiFinishReason', () => {
  test('maps AI SDK finish reasons to OpenAI values', () => {
    assert.equal(mapOpenAiFinishReason('stop'), 'stop');
    assert.equal(mapOpenAiFinishReason('tool-calls'), 'tool_calls');
    assert.equal(mapOpenAiFinishReason('content-filter'), 'content_filter');
  });
});

describe('createOpenAiSseEncoder', () => {
  test('encodes text and reasoning deltas', () => {
    const encoder = createOpenAiSseEncoder();
    const textChunk = parseSseDataLine(
      encoder.encodeStreamPart({ type: 'text-delta', text: 'Hi', id: 't1' }),
    );
    const reasoningChunk = parseSseDataLine(
      encoder.encodeStreamPart({ type: 'reasoning-delta', text: 'think', id: 'r1' }),
    );

    assert.equal(textChunk.choices[0].delta.content, 'Hi');
    assert.equal(reasoningChunk.choices[0].delta.reasoning_format, 'summary');
    assert.equal(reasoningChunk.choices[0].delta.reasoning, 'think');
  });

  test('forwards Anthropic reasoning signatures on reasoning deltas', () => {
    const encoder = createOpenAiSseEncoder();
    const chunk = parseSseDataLine(
      encoder.encodeStreamPart({
        type: 'reasoning-delta',
        text: '',
        id: 'r1',
        providerMetadata: {
          anthropic: { signature: 'sig_test_123' },
        },
      }),
    );

    assert.equal(chunk.choices[0].delta.reasoning_signature, 'sig_test_123');
  });

  test('streams indexed tool call deltas compatible with mergeToolCallDelta', () => {
    const encoder = createOpenAiSseEncoder();
    const lines = [
      encoder.encodeStreamPart({
        type: 'tool-input-start',
        id: 'call_a',
        toolName: 'read_file',
      }),
      encoder.encodeStreamPart({
        type: 'tool-input-delta',
        id: 'call_a',
        delta: '{"path":',
      }),
      encoder.encodeStreamPart({
        type: 'tool-input-delta',
        id: 'call_a',
        delta: '"a.txt"}',
      }),
    ].map(parseSseDataLine);

    let acc = {};
    for (const chunk of lines) {
      acc = mergeToolCallDelta(acc, chunk);
    }

    assert.deepEqual(acc[0], {
      id: 'call_a',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
    });
  });

  test('does not double name/arguments when a terminal tool-call follows incremental streaming', () => {
    // fullStream emits tool-input-start/-delta for incremental streaming, then a
    // terminal tool-call part carrying the same, now-complete name + input. The
    // terminal part must be dropped or mergeToolCallDelta concatenates it twice.
    const encoder = createOpenAiSseEncoder();
    const lines = [
      encoder.encodeStreamPart({
        type: 'tool-input-start',
        id: 'call_a',
        toolName: 'read_file',
      }),
      encoder.encodeStreamPart({
        type: 'tool-input-delta',
        id: 'call_a',
        delta: '{"path":"a.txt"}',
      }),
      encoder.encodeStreamPart({
        type: 'tool-input-end',
        id: 'call_a',
      }),
      encoder.encodeStreamPart({
        type: 'tool-call',
        toolCallId: 'call_a',
        toolName: 'read_file',
        input: { path: 'a.txt' },
      }),
    ]
      .filter(Boolean)
      .map(parseSseDataLine);

    let acc = {};
    for (const chunk of lines) {
      acc = mergeToolCallDelta(acc, chunk);
    }

    assert.deepEqual(acc[0], {
      id: 'call_a',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"a.txt"}',
      },
    });
  });

  test('emits the terminal tool-call when no incremental streaming preceded it', () => {
    // Some providers/models never stream tool-input-start/-delta and only emit the
    // final tool-call part; that path must still deliver the name + arguments once.
    const encoder = createOpenAiSseEncoder();
    const chunk = parseSseDataLine(
      encoder.encodeStreamPart({
        type: 'tool-call',
        toolCallId: 'call_b',
        toolName: 'read_file',
        input: { path: 'b.txt' },
      }),
    );

    const acc = mergeToolCallDelta({}, chunk);

    assert.deepEqual(acc[0], {
      id: 'call_b',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"b.txt"}',
      },
    });
  });
});

describe('encodeNonStreamingCompletion', () => {
  test('builds an OpenAI chat.completion object', () => {
    const body = encodeNonStreamingCompletion({
      model: 'claude-sonnet-4-5',
      text: 'Done',
      reasoningText: 'thought',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          noCacheTokens: 10,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 5,
          reasoningTokens: undefined,
        },
      },
    });

    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'claude-sonnet-4-5');
    assert.equal(body.choices[0].message.content, 'Done');
    assert.equal(body.choices[0].message.reasoning, 'thought');
    assert.equal(body.usage.total_tokens, 15);
  });
});

describe('encodeOpenAiSseDone', () => {
  test('emits the OpenAI stream terminator', () => {
    assert.equal(encodeOpenAiSseDone(), 'data: [DONE]\n\n');
  });
});
