/**
 * Gateway fetch sanitizer for Anthropic Messages proxies (OpenCode Zen).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MINNOW_OPENCODE_USER_AGENT } from '../../server/providers/opencode-identity.js';
import {
  createAnthropicGatewayFetch,
  sanitizeAnthropicGatewayRequestBody,
  sanitizeAnthropicGatewayRequestInit,
  stripAnthropicGatewayBetas,
  stripAnthropicGatewayBetasFromSet,
  sanitizeAnthropicGatewayInputSchema,
} from '../../server/generations/anthropic/gateway-fetch.js';

describe('stripAnthropicGatewayBetas', () => {
  test('removes structured-outputs beta while keeping others', () => {
    assert.equal(
      stripAnthropicGatewayBetas('structured-outputs-2025-11-13, interleaved-thinking'),
      'interleaved-thinking',
    );
  });
});

describe('sanitizeAnthropicGatewayRequestBody', () => {
  test('drops explicit disabled thinking and eager_input_streaming on tools', () => {
    const sanitized = sanitizeAnthropicGatewayRequestBody({
      thinking: { type: 'disabled' },
      tools: [{ name: 'read_file', eager_input_streaming: true }],
    });

    assert.equal(sanitized.thinking, undefined);
    assert.deepEqual(sanitized.tools, [{ name: 'read_file' }]);
  });

  test('strips output_config and strict tool fields', () => {
    const sanitized = sanitizeAnthropicGatewayRequestBody({
      output_config: { effort: 'medium' },
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: [
        {
          name: 'noop',
          strict: true,
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
          },
        },
      ],
    });

    assert.equal(sanitized.output_config, undefined);
    assert.deepEqual(sanitized.tool_choice, { type: 'auto' });
    assert.deepEqual(sanitized.tools, [{ name: 'noop', input_schema: { type: 'object' } }]);
    assert.equal(JSON.stringify(sanitized.tools).includes('additionalProperties'), false);
  });
});

describe('stripAnthropicGatewayBetasFromSet', () => {
  test('removes unsupported betas from a mutable set', () => {
    const betas = new Set(['structured-outputs-2025-11-13', 'interleaved-thinking']);
    stripAnthropicGatewayBetasFromSet(betas);
    assert.deepEqual([...betas], ['interleaved-thinking']);
  });
});

describe('sanitizeAnthropicGatewayInputSchema', () => {
  test('recursively removes draft metadata keys', () => {
    const sanitized = sanitizeAnthropicGatewayInputSchema({
      $schema: 'http://example',
      type: 'object',
      properties: {
        path: { $id: 'x', type: 'string' },
      },
    });

    assert.deepEqual(sanitized, {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
    });
  });

  test('removes unsupported array and string constraints', () => {
    const sanitized = sanitizeAnthropicGatewayInputSchema({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[a-z]+$' },
        },
      },
    });

    assert.deepEqual(sanitized, {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
  });

  test('strips additionalProperties from nested object schemas', () => {
    const sanitized = sanitizeAnthropicGatewayInputSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
      required: ['questions'],
    });

    assert.deepEqual(sanitized, {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
            required: ['id'],
          },
        },
      },
      required: ['questions'],
    });
  });
});

describe('sanitizeAnthropicGatewayRequestInit', () => {
  test('rewrites anthropic-beta header and JSON body', () => {
    const init = sanitizeAnthropicGatewayRequestInit({
      method: 'POST',
      headers: {
        'anthropic-beta': 'structured-outputs-2025-11-13, interleaved-thinking',
      },
      body: JSON.stringify({
        thinking: { type: 'disabled' },
        tools: [{ name: 'noop', eager_input_streaming: true }],
      }),
    });

    assert.equal(
      /** @type {Record<string, string>} */ (init?.headers)['anthropic-beta'],
      'interleaved-thinking',
    );
    const body = JSON.parse(String(init?.body));
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.tools, [{ name: 'noop' }]);
  });
});

describe('createAnthropicGatewayFetch', () => {
  test('passes through native Anthropic hosts unchanged', async () => {
    let seenInit;
    const fetchImpl = async (_input, init) => {
      seenInit = init;
      return new Response('ok');
    };

    const wrapped = createAnthropicGatewayFetch('https://api.anthropic.com', fetchImpl);
    await wrapped('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-beta': 'structured-outputs-2025-11-13' },
      body: JSON.stringify({ thinking: { type: 'disabled' } }),
    });

    assert.equal(
      /** @type {Record<string, string>} */ (seenInit?.headers)['anthropic-beta'],
      'structured-outputs-2025-11-13',
    );
  });

  test('sanitizes OpenCode Zen requests', async () => {
    let seenInit;
    const fetchImpl = async (_input, init) => {
      seenInit = init;
      return new Response('ok');
    };

    const wrapped = createAnthropicGatewayFetch('https://opencode.ai', fetchImpl, {
      sessionId: '11111111-1111-1111-1111-111111111111',
    });
    await wrapped('https://opencode.ai/zen/v1/messages', {
      method: 'POST',
      headers: { 'anthropic-beta': 'structured-outputs-2025-11-13', 'User-Agent': 'ai-sdk/anthropic' },
      body: JSON.stringify({ thinking: { type: 'disabled' } }),
    });

    assert.equal(
      /** @type {Record<string, string>} */ (seenInit?.headers)['anthropic-beta'],
      undefined,
    );
    assert.equal(
      /** @type {Record<string, string>} */ (seenInit?.headers)['User-Agent'],
      MINNOW_OPENCODE_USER_AGENT,
    );
    assert.equal(
      /** @type {Record<string, string>} */ (seenInit?.headers)['x-opencode-session'],
      '11111111-1111-1111-1111-111111111111',
    );
    const body = JSON.parse(String(seenInit?.body));
    assert.equal(body.thinking, undefined);
  });
});
