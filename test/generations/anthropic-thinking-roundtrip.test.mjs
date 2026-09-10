import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamText } from 'ai';
import { buildAnthropicProvider } from '../../server/generations/anthropic/provider-runtime.js';
import { createOpenAiSseEncoder, encodeNonStreamingCompletion } from '../../server/generations/anthropic/openai-sse-encoder.js';
import { openAiMessagesToCoreMessages } from '../../server/generations/anthropic/openai-to-core-messages.js';
import { mapOpenAiTools } from '../../server/generations/anthropic/openai-tools.js';
import { adjustAnthropicRequestForGateway } from '../../src/lib/anthropic-thinking-style.mjs';

test('real SDK streams signed and redacted blocks and replays exact native blocks through Zen', async () => {
  const blocks = [
    { type: 'thinking', thinking: '  Compare\n\n\nprices.  ', signature: 'sig-one' },
    { type: 'redacted_thinking', data: 'opaque-provider-data' },
    { type: 'thinking', thinking: 'Read the source.', signature: 'sig-two' },
  ];
  const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }];
  for (const [index, block] of blocks.entries()) {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : block });
    if (block.type === 'thinking') {
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    }
    events.push({ type: 'content_block_stop', index });
  }
  events.push(
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tool_1', name: 'read_page', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  );
  const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const provider = buildAnthropicProvider({ profile: { baseUrl: 'https://opencode.ai/zen', authStyle: 'bearer' }, paths: { messagesPath: '/v1/messages' }, secrets: { apiKey: 'test' } });
    const tools = [{ type: 'function', function: { name: 'read_page', parameters: { type: 'object', properties: {} } } }];
    const options = adjustAnthropicRequestForGateway('https://opencode.ai', { tools, providerOptions: { anthropic: { thinking: { type: 'adaptive' } } } }).providerOptions;
    const run = messages => streamText({ model: provider('claude-opus-5'), messages: openAiMessagesToCoreMessages(messages), tools: mapOpenAiTools(tools), providerOptions: options, maxOutputTokens: 1024, maxRetries: 0 });
    const first = run([{ role: 'user', content: 'Check prices' }]);
    const encoder = createOpenAiSseEncoder();
    const replay = [];
    let visibleReasoning = '';
    for await (const part of first.fullStream) {
      if (part.type === 'error') throw part.error;
      const encoded = encoder.encodeStreamPart(part);
      if (!encoded) continue;
      const delta = JSON.parse(encoded.slice(6)).choices?.[0]?.delta;
      visibleReasoning += delta?.reasoning ?? '';
      replay.push(...(delta?.reasoning_blocks ?? []));
    }
    assert.deepEqual(replay, blocks);
    assert.equal(visibleReasoning, blocks[0].thinking + blocks[2].thinking);
    const nonStream = encodeNonStreamingCompletion({ model: 'claude-opus-5', reasoning: await first.reasoning });
    assert.deepEqual(nonStream.choices[0].message.reasoning_blocks, blocks);
    const second = run([
      { role: 'user', content: 'Check prices' },
      { role: 'assistant', content: '', reasoning_blocks: replay, tool_calls: [{ id: 'tool_1', type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tool_1', content: '$20' },
    ]);
    for await (const part of second.fullStream) if (part.type === 'error') throw part.error;
    assert.deepEqual(requests[1].thinking, { type: 'adaptive' });
    assert.deepEqual(requests[1].messages.find(m => m.role === 'assistant').content.slice(0, 3), blocks);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
