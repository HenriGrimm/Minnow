/**
 * Anthropic adaptive-thinking model detection and providerOptions normalization.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  adjustAnthropicRequestForGateway,
  adjustAnthropicThinkingForToolHistory,
  anthropicBudgetTokensToEffort,
  anthropicHistoryHasUnsignedToolCalls,
  anthropicModelUsesAdaptiveThinking,
  normalizeAnthropicProviderOptions,
} from '../../src/lib/anthropic-thinking-style.mjs';

describe('anthropicModelUsesAdaptiveThinking', () => {
  test('matches newer Claude families that require adaptive thinking', () => {
    for (const modelId of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-fable-5',
    ]) {
      assert.equal(anthropicModelUsesAdaptiveThinking(modelId), true, modelId);
    }
  });

  test('does not match legacy Claude families that use enabled budgets', () => {
    for (const modelId of [
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet',
    ]) {
      assert.equal(anthropicModelUsesAdaptiveThinking(modelId), false, modelId);
    }
  });
});

describe('anthropicBudgetTokensToEffort', () => {
  test('maps budget token tiers to adaptive effort', () => {
    assert.equal(anthropicBudgetTokensToEffort(1024), 'low');
    assert.equal(anthropicBudgetTokensToEffort(10240), 'medium');
    assert.equal(anthropicBudgetTokensToEffort(32768), 'high');
  });
});

describe('normalizeAnthropicProviderOptions', () => {
  test('rewrites enabled thinking to adaptive for sonnet-5', () => {
    const normalized = normalizeAnthropicProviderOptions('claude-sonnet-5', {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 10240 },
      },
    });

    assert.deepEqual(normalized?.anthropic?.thinking, { type: 'adaptive' });
    assert.equal(normalized?.anthropic?.effort, 'medium');
  });

  test('leaves enabled thinking for sonnet-4-5', () => {
    const input = {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 10240 },
      },
    };
    const normalized = normalizeAnthropicProviderOptions('claude-sonnet-4-5', input);
    assert.deepEqual(normalized, input);
  });
});

describe('anthropicHistoryHasUnsignedToolCalls', () => {
  test('detects assistant tool_calls missing reasoning_signature', () => {
    assert.equal(
      anthropicHistoryHasUnsignedToolCalls([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        },
      ]),
      true,
    );
  });

  test('returns false when signature is present', () => {
    assert.equal(
      anthropicHistoryHasUnsignedToolCalls([
        {
          role: 'assistant',
          content: null,
          reasoning_signature: 'sig_ok',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        },
      ]),
      false,
    );
  });
});

describe('adjustAnthropicThinkingForToolHistory', () => {
  test('preserves thinking with signed blocks, and after an older unsigned user turn', () => {
    const tools = [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }];
    const body = { thinking: { type: 'adaptive' }, messages: [
      { role: 'user', content: 'old request' },
      { role: 'assistant', tool_calls: tools },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', tool_calls: tools, reasoning_blocks: [
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'thinking', thinking: 'exact text', signature: 'signature' },
      ] },
    ] };
    assert.deepEqual(adjustAnthropicThinkingForToolHistory('claude-opus-5', body), body);
  });

  test('disables thinking when unsigned tool history would 400', () => {
    const adjusted = adjustAnthropicThinkingForToolHistory('claude-opus-4-6', {
      model: 'claude-opus-4-6',
      temperature: 0.7,
      top_p: 0.95,
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: 'medium',
        },
      },
      messages: [
        { role: 'user', content: 'run tool' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });

    assert.equal(adjusted.temperature, undefined);
    assert.equal(adjusted.top_p, undefined);
    assert.equal(adjusted.providerOptions?.anthropic?.thinking, undefined);
    assert.equal(adjusted.providerOptions?.anthropic?.effort, undefined);
  });
});

describe('adjustAnthropicRequestForGateway', () => {
  test('strips unsupported fields while preserving thinking for tool requests on OpenCode', () => {
    const adjusted = adjustAnthropicRequestForGateway('https://opencode.ai', {
      model: 'claude-opus-4-6',
      tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: 'medium',
        },
      },
    });

    assert.deepEqual(adjusted.providerOptions?.anthropic?.thinking, { type: 'adaptive' });
    assert.equal(adjusted.providerOptions?.anthropic?.effort, undefined);
    assert.equal(adjusted.providerOptions?.anthropic?.structuredOutputMode, undefined);
    assert.equal(adjusted.providerOptions?.anthropic?.toolStreaming, false);
    assert.equal(adjusted.providerOptions?.anthropic?.disableParallelToolUse, undefined);
  });
});
