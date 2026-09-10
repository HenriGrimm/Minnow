/**
 * Chat Completions → OpenAI Responses body mapping.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  chatCompletionBodyToResponses,
  responsesJsonToOpenAiCompletion,
} from '../../server/generations/openai-responses/chat-to-responses.js';

describe('chatCompletionBodyToResponses', () => {
  test('maps system, user, tools, and a tool-loop turn', () => {
    const body = chatCompletionBodyToResponses({
      model: 'muse-spark-1.3-contributor',
      stream: true,
      temperature: 0.2,
      max_tokens: 512,
      reasoning_effort: 'medium',
      thinking: { type: 'enabled' },
      chat_template_kwargs: { enable_thinking: true },
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'You are Minnow.' },
        { role: 'user', content: 'Open pkg.json' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_read_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"pkg.json"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_read_1', content: '{"ok":true}' },
      ],
    });

    assert.equal(body.model, 'muse-spark-1.3-contributor');
    assert.equal(body.stream, true);
    assert.equal(body.instructions, 'You are Minnow.');
    assert.equal(body.max_output_tokens, 512);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    assert.equal(body.thinking, undefined);
    assert.equal(body.chat_template_kwargs, undefined);
    assert.equal(body.messages, undefined);
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    assert.equal(body.tool_choice, 'auto');
    assert.equal(body.input.length, 3);
    assert.equal(body.input[0].role, 'user');
    assert.equal(body.input[0].content, 'Open pkg.json');
    assert.deepEqual(body.input[1], {
      type: 'function_call',
      call_id: 'call_read_1',
      name: 'read_file',
      arguments: '{"path":"pkg.json"}',
    });
    assert.deepEqual(body.input[2], {
      type: 'function_call_output',
      call_id: 'call_read_1',
      output: '{"ok":true}',
    });
  });

  test('maps thinking disabled to reasoning.effort none', () => {
    const body = chatCompletionBodyToResponses({
      model: 'gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      stream: false,
    });
    assert.deepEqual(body.reasoning, { effort: 'none' });
  });

  test('uses the minimum supported effort when Muse Spark thinking is disabled', () => {
    const body = chatCompletionBodyToResponses({
      model: 'opencode-go/muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'expand this prompt' }],
      thinking: { type: 'disabled' },
      reasoning_effort: 'none',
      stream: false,
    });
    assert.deepEqual(body.reasoning, { effort: 'low' });
  });
});

describe('responsesJsonToOpenAiCompletion', () => {
  test('extracts text, reasoning, and function calls', () => {
    const openai = responsesJsonToOpenAiCompletion(
      {
        id: 'resp_fixed',
        model: 'muse-spark-1.3-contributor',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'ping',
            arguments: '{}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
      'muse-spark-1.3-contributor',
    );

    assert.equal(openai.choices[0].message.content, 'done');
    assert.equal(openai.choices[0].message.reasoning, 'plan');
    assert.equal(openai.choices[0].finish_reason, 'tool_calls');
    assert.equal(openai.choices[0].message.tool_calls[0].id, 'call_1');
    assert.equal(openai.usage.prompt_tokens, 10);
    assert.equal(openai.usage.completion_tokens, 4);
  });

  test('passes through existing chat.completion JSON', () => {
    const original = {
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    };
    assert.equal(responsesJsonToOpenAiCompletion(original), original);
  });
});
