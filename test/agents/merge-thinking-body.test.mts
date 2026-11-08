import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyUtilityThinkingOff, mergeThinkingIntoCompletionBody } from '../../src/agents/merge-thinking-body.ts';
import {
  markLmStudioThinkingHintShown,
  resetLmStudioThinkingHint,
} from '../../src/agents/thinking-to-body.ts';
import { LLAMA_CPP_LOCAL_PROVIDER_ID } from '../../src/providers/types.ts';
import type { ModelCapabilities } from '../../src/types.ts';

const levelCaps: ModelCapabilities = {
  vision: false,
  tools: null,
  streaming: null,
  grammar: null,
  reasoning: true,
  reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
  reasoningDefault: 'off',
  contextLength: null,
  loadState: null,
};

describe('mergeThinkingIntoCompletionBody', () => {
  test('CLI utility calls keep model defaults when off is unknown or unsupported', () => {
    const catalogs: Array<ModelCapabilities | undefined> = [undefined, { ...levelCaps, reasoningAllowedOptions: ['low', 'medium', 'high'] }];
    for (const caps of catalogs) {
      const body = { model: 'gpt-6.1-sol' };
      applyUtilityThinkingOff(body, { id: 'codex-cli', apiKind: 'agent-cli-v1' }, caps);
      assert.deepEqual(body, { model: 'gpt-6.1-sol' });
    }
  });

  test('CLI utility calls can disable reasoning when the catalog advertises off', () => {
    const body: Record<string, unknown> = { model: 'supports-off' };
    applyUtilityThinkingOff(body, { id: 'codex-cli', apiKind: 'agent-cli-v1' }, levelCaps);
    assert.equal(body.reasoning_effort, 'off');
  });

  test('explicit chat reasoning remains unchanged by the utility policy', () => {
    const body: Record<string, unknown> = { model: 'gpt-6.1-sol' };
    mergeThinkingIntoCompletionBody(body, 'on', { id: 'codex-cli', apiKind: 'agent-cli-v1' }, levelCaps, 'high');
    assert.equal(body.reasoning_effort, 'high');
  });
  test('dropdown models enable thinking when inherited on despite catalog default off', () => {
    const body: Record<string, unknown> = {};
    const { body: merged } = mergeThinkingIntoCompletionBody(
      body,
      'on',
      {
        id: 'lm-studio-local',
        apiKind: 'openai-v1',
        autoApi: false,
        modelApiOverrides: {},
      },
      levelCaps,
      undefined,
      'openai-v1',
      null,
    );
    assert.equal(merged.reasoning_effort, 'medium');
    assert.deepEqual(merged.reasoning, { effort: 'medium' });
  });

  test('utility off forces reasoning_effort off for level-only catalogs', () => {
    const body: Record<string, unknown> = {};
    mergeThinkingIntoCompletionBody(
      body,
      'off',
      {
        id: 'lm-studio-local',
        apiKind: 'openai-v1',
        autoApi: false,
        modelApiOverrides: {},
      },
      {
        ...levelCaps,
        reasoningAllowedOptions: ['low', 'medium', 'high'],
      },
      'off',
      'openai-v1',
    );
    assert.deepEqual(body.thinking, { type: 'disabled' });
  });

  test('llama-cpp applies default request budget when feature is supported', () => {
    const body: Record<string, unknown> = {};
    const { nativeBudgetApplied } = mergeThinkingIntoCompletionBody(
      body,
      'on',
      {
        id: LLAMA_CPP_LOCAL_PROVIDER_ID,
        apiKind: 'openai-v1',
        autoApi: false,
        modelApiOverrides: {},
      },
      {
        ...levelCaps,
        reasoningAllowedOptions: ['off', 'on'],
      },
      undefined,
      'openai-v1',
      null,
      { llamaSupportsThinkingBudget: true },
    );
    assert.equal(body.thinking_budget_tokens, 8192);
    assert.equal(nativeBudgetApplied, true);
  });

  test('Qwen3.8 high on LM Studio sends xhigh and preserve_thinking', () => {
    // Skip the one-shot LM Studio status pill (needs a DOM) so this stays a body-shape test.
    markLmStudioThinkingHintShown();
    const body: Record<string, unknown> = { model: 'qwen/qwen3.8-27b' };
    mergeThinkingIntoCompletionBody(
      body,
      'on',
      {
        id: 'lm-studio-local',
        apiKind: 'lm-studio-v0',
        autoApi: false,
        modelApiOverrides: {},
      },
      {
        ...levelCaps,
        reasoningDefault: 'high',
      },
      'high',
      'lm-studio-v0',
    );
    assert.equal(body.enable_thinking, true);
    assert.equal(body.reasoning_effort, 'xhigh');
    assert.equal(body.preserve_thinking, true);
    resetLmStudioThinkingHint();
  });

  test('GLM-5.3 utility off sends enabled + low, not disabled', () => {
    const body: Record<string, unknown> = { model: 'glm-5.3-flash' };
    mergeThinkingIntoCompletionBody(
      body,
      'off',
      {
        id: 'zai',
        apiKind: 'openai-v1',
        autoApi: false,
        modelApiOverrides: {},
      },
      {
        ...levelCaps,
        reasoningAllowedOptions: ['low', 'high', 'max'],
        reasoningDefault: 'max',
      },
      'off',
      'openai-v1',
      null,
      { modelId: 'glm-5.3-flash' },
    );
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'low');
    assert.notEqual(body.enable_thinking, false);
  });
});
