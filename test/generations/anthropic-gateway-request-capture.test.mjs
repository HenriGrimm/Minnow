/**
 * Capture outbound Anthropic gateway request shape for OpenCode Zen tool calls.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { streamText } from 'ai';
import { buildAnthropicProvider } from '../../server/generations/anthropic/provider-runtime.js';
import { mapOpenAiTools } from '../../server/generations/anthropic/openai-tools.js';
import { openAiMessagesToCoreMessages } from '../../server/generations/anthropic/openai-to-core-messages.js';
import {
  adjustAnthropicRequestForGateway,
  adjustAnthropicThinkingForToolHistory,
} from '../../src/lib/anthropic-thinking-style.mjs';

const RUNTIME = {
  profile: { baseUrl: 'https://opencode.ai/zen', authStyle: 'bearer' },
  paths: { chatCompletionsPath: '/v1/messages', messagesPath: '/v1/messages' },
  secrets: { apiKey: 'test-token' },
};

/** Representative built-in tools including ask_question nested additionalProperties. */
const SAMPLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Return the current date and time.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents under a workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          path: { type: 'string', description: 'Directory to search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_question',
      description: 'Ask structured multiple-choice questions.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                    },
                    required: ['id', 'label'],
                  },
                },
              },
              required: ['id', 'prompt', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  },
];

describe('anthropic gateway outbound request capture', () => {
  test('builds sanitized tool request without gateway-rejected fields', async () => {
    /** @type {Record<string, unknown> | null} */
    let capturedBody = null;
    /** @type {Record<string, string> | undefined} */
    let capturedHeaders;

    const fetchImpl = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = /** @type {Record<string, string>} */ (init?.headers);
      return new Response('not-sse', { status: 200 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const tools = SAMPLE_TOOLS;
      let body = {
        model: 'claude-opus-4-7',
        stream: true,
        max_tokens: 32768,
        messages: [{ role: 'user', content: 'list files' }],
        tools,
        tool_choice: 'auto',
        providerOptions: {
          anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
        },
      };

      body = adjustAnthropicRequestForGateway(
        'https://opencode.ai',
        adjustAnthropicThinkingForToolHistory('claude-opus-4-7', body),
      );

      const anthropic = buildAnthropicProvider(RUNTIME);
      const mappedTools = mapOpenAiTools(body.tools);
      const messages = openAiMessagesToCoreMessages(body.messages);

      const result = streamText({
        model: anthropic('claude-opus-4-7'),
        messages,
        tools: mappedTools,
        toolChoice: 'auto',
        maxOutputTokens: 32768,
        allowSystemInMessages: true,
        providerOptions: body.providerOptions,
        abortSignal: AbortSignal.timeout(5000),
      });

      try {
        for await (const _ of result.fullStream) {
          // drain until mock response fails
        }
      } catch {
        // expected — mock response is not valid SSE
      }

      assert.ok(capturedBody, 'expected fetch to be called');
      assert.equal(capturedHeaders?.['x-api-key'], 'test-token');
      assert.equal(capturedHeaders?.Authorization, undefined);
      assert.equal(capturedBody.tools?.length, tools.length);
      assert.deepEqual(capturedBody.thinking, { type: 'adaptive' });
      assert.equal(capturedBody.output_config, undefined);

      const betaHeader =
        capturedHeaders?.['anthropic-beta'] ?? capturedHeaders?.['Anthropic-Beta'] ?? '';
      assert.equal(betaHeader.includes('structured-outputs'), false);
      assert.equal(betaHeader.includes('advanced-tool-use'), false);

      for (const tool of capturedBody.tools ?? []) {
        assert.equal(tool.eager_input_streaming, undefined);
        assert.equal(tool.strict, undefined);
        const schemaJson = JSON.stringify(tool.input_schema ?? {});
        assert.equal(schemaJson.includes('$schema'), false);
        assert.equal(schemaJson.includes('$id'), false);
        assert.equal(schemaJson.includes('maxItems'), false);
        assert.equal(schemaJson.includes('additionalProperties'), false);
      }

      assert.deepEqual(capturedBody.tool_choice, { type: 'auto' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
