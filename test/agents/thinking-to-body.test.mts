import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  reasoningEffortToCompletionBody,
  thinkingToCompletionBody,
} from '../../src/agents/thinking-to-body.ts';
import type { ModelCapabilities } from '../../src/types.ts';

const reasoningCaps: ModelCapabilities = {
  vision: false,
  tools: null,
  streaming: null,
  grammar: null,
  reasoning: true,
  reasoningAllowedOptions: ['off', 'on', 'low', 'medium', 'high'],
  contextLength: null,
  loadState: null,
};

describe('thinkingToCompletionBody', () => {
  const bareReasoningCaps = {
    vision: false,
    tools: null,
    streaming: null,
    grammar: null,
    reasoning: true,
    contextLength: null,
    loadState: null,
  };

  test('openai-v1 on omits enable_thinking for Kimi/Moonshot (they 400 on it)', () => {
    for (const modelId of ['moonshotai/kimi-k2-thinking', 'moonshot-v1-128k']) {
      const { body } = thinkingToCompletionBody(
        'on',
        'openai-v1',
        bareReasoningCaps,
        null,
        modelId,
      );
      assert.deepEqual(body, { thinking: { type: 'enabled' } }, modelId);
    }
  });

  test('openai-v1 on carries enable_thinking for everything else', () => {
    // thinking.type reaches no local runtime; chat_template_kwargs is the only
    // switch mlx_lm.server reads, so the on/off toggle has to ride there too.
    const { body } = thinkingToCompletionBody(
      'on',
      'openai-v1',
      bareReasoningCaps,
      null,
      'qwen/qwen3-32b',
    );
    assert.deepEqual(body, {
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    assert.equal(body.reasoning_effort, undefined);
  });

  test('openai-v1 off disables DeepSeek thinking without reasoning_effort none', () => {
    const { body } = thinkingToCompletionBody('off', 'openai-v1', {
      vision: false,
      tools: null,
      streaming: null,
      grammar: null,
      reasoning: true,
      contextLength: null,
      loadState: null,
    });
    assert.deepEqual(body, {
      thinking: { type: 'disabled' },
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    assert.equal(body.reasoning_effort, undefined);
  });

  test('lm-studio-v0 on includes enable_thinking and medium effort', () => {
    const patch = thinkingToCompletionBody('on', 'lm-studio-v0', {
      vision: false,
      tools: null,
      streaming: null,
      grammar: null,
      reasoning: true,
      contextLength: null,
      loadState: null,
    });
    assert.equal(patch.body.reasoning_effort, 'medium');
    assert.deepEqual(patch.body.reasoning, { effort: 'medium' });
    assert.equal(patch.body.enable_thinking, true);
    assert.equal(patch.hint?.bestEffort, true);
  });

  test('lm-studio-v0 off includes none effort and best-effort hint', () => {
    const patch = thinkingToCompletionBody('off', 'lm-studio-v0', {
      vision: false,
      tools: null,
      streaming: null,
      grammar: null,
      reasoning: true,
      contextLength: null,
      loadState: null,
    });
    assert.equal(patch.body.reasoning_effort, 'none');
    assert.equal(patch.hint?.bestEffort, true);
  });

  test('respects reasoningAllowedOptions', () => {
    const { body } = thinkingToCompletionBody('on', 'openai-v1', {
      vision: false,
      tools: null,
      streaming: null,
      grammar: null,
      reasoning: true,
      reasoningAllowedOptions: ['off'],
      contextLength: null,
      loadState: null,
    });
    assert.deepEqual(body, {});
  });

  test('level-only allowed options map on to medium effort', () => {
    const patch = thinkingToCompletionBody('on', 'openai-v1', {
      ...reasoningCaps,
      reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
    }, null);
    assert.equal(patch.body.reasoning_effort, 'medium');
    assert.deepEqual(patch.body.reasoning, { effort: 'medium' });
  });

  test('anthropic-v1 uses adaptive thinking for sonnet-5 capabilities', () => {
    const patch = thinkingToCompletionBody('on', 'anthropic-v1', {
      vision: false,
      tools: null,
      streaming: null,
      grammar: null,
      reasoning: true,
      reasoningThinkingEnabledValue: 'adaptive',
      contextLength: null,
      loadState: null,
    });
    assert.deepEqual(patch.body.providerOptions, {
      anthropic: { thinking: { type: 'adaptive' } },
    });
  });

  test('anthropic-v1 medium effort maps to adaptive + effort for opus-4-6', () => {
    const patch = reasoningEffortToCompletionBody('medium', 'anthropic-v1', {
      ...reasoningCaps,
      reasoningThinkingEnabledValue: 'adaptive',
    });
    assert.deepEqual(patch.body.providerOptions, {
      anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
  });

  test('anthropic-v1 off omits thinking (do not send disabled)', () => {
    const { body } = thinkingToCompletionBody('off', 'anthropic-v1', reasoningCaps);
    assert.deepEqual(body, {});
  });

  test('anthropic-v1 explicit budget beats effort map with 1024 floor', () => {
    const patch = reasoningEffortToCompletionBody('low', 'anthropic-v1', reasoningCaps, 800);
    const thinking = (
      patch.body.providerOptions as { anthropic: { thinking: { budgetTokens: number } } }
    ).anthropic.thinking;
    assert.equal(thinking.budgetTokens, 1024);
    assert.equal(patch.nativeBudgetApplied, true);
  });

  test('anthropic adaptive skips explicit budget', () => {
    const patch = thinkingToCompletionBody(
      'on',
      'anthropic-v1',
      {
        ...reasoningCaps,
        reasoningThinkingEnabledValue: 'adaptive',
      },
      4096,
    );
    assert.deepEqual(patch.body.providerOptions, {
      anthropic: { thinking: { type: 'adaptive' } },
    });
    assert.notEqual(patch.nativeBudgetApplied, true);
  });

  test('openai-v1 emits thinking_budget_tokens when budget set', () => {
    const { body } = thinkingToCompletionBody('on', 'openai-v1', reasoningCaps, 2048);
    assert.equal(body.thinking_budget_tokens, 2048);
  });
});

describe('reasoningEffortToCompletionBody', () => {
  test('minimal and xhigh survive the shared OpenAI and LM Studio request mapping', () => {
    const caps: ModelCapabilities = {
      ...reasoningCaps,
      reasoningAllowedOptions: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    };
    for (const apiKind of ['openai-v1', 'lm-studio-v0'] as const) {
      for (const effort of ['minimal', 'xhigh'] as const) {
        const { body } = reasoningEffortToCompletionBody(effort, apiKind, caps);
        assert.equal(body.reasoning_effort, effort, `${apiKind}: ${effort}`);
        assert.deepEqual(body.reasoning, { effort });
        assert.deepEqual(body.chat_template_kwargs, {
          enable_thinking: true,
          reasoning_effort: effort,
        });
      }
    }
  });

  test('unsupported advertised effort is still blocked', () => {
    const caps: ModelCapabilities = {
      ...reasoningCaps,
      reasoningAllowedOptions: ['low', 'medium', 'high'],
    };
    for (const apiKind of ['openai-v1', 'lm-studio-v0', 'anthropic-v1', 'agent-cli-v1'] as const) {
      const { body } = reasoningEffortToCompletionBody('xhigh', apiKind, caps);
      assert.deepEqual(body, {});
    }
  });

  test('Anthropic adaptive preserves advertised xhigh and max efforts', () => {
    const caps: ModelCapabilities = {
      ...reasoningCaps,
      reasoningAllowedOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
      reasoningThinkingEnabledValue: 'adaptive',
    };
    for (const effort of ['xhigh', 'max'] as const) {
      const patch = reasoningEffortToCompletionBody(effort, 'anthropic-v1', caps, 4096);
      assert.deepEqual(patch.body.providerOptions, {
        anthropic: { thinking: { type: 'adaptive' }, effort },
      });
      assert.notEqual(patch.nativeBudgetApplied, true);
    }
  });

  test('Anthropic does not forward the OpenAI minimal effort', () => {
    const patch = reasoningEffortToCompletionBody('minimal', 'anthropic-v1', {
      ...reasoningCaps,
      reasoningAllowedOptions: ['minimal', 'low', 'medium', 'high'],
      reasoningThinkingEnabledValue: 'adaptive',
    });
    assert.deepEqual(patch.body.providerOptions, {
      anthropic: { thinking: { type: 'adaptive' } },
    });
  });

  test('openai-v1 off disables thinking without reasoning_effort none', () => {
    const { body } = reasoningEffortToCompletionBody('off', 'openai-v1', reasoningCaps);
    assert.deepEqual(body, {
      thinking: { type: 'disabled' },
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  test('openai-v1 on carries template kwargs, but not for Kimi', () => {
    const { body } = reasoningEffortToCompletionBody('on', 'openai-v1', reasoningCaps);
    assert.deepEqual(body, {
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    assert.equal(body.reasoning_effort, undefined);

    const kimi = reasoningEffortToCompletionBody(
      'on',
      'openai-v1',
      reasoningCaps,
      null,
      'moonshotai/kimi-k2-thinking',
    ).body;
    assert.deepEqual(kimi, { thinking: { type: 'enabled' } });
  });

  test('openai-v1 low uses top-level reasoning_effort and nested reasoning.effort', () => {
    const { body } = reasoningEffortToCompletionBody('low', 'openai-v1', {
      ...reasoningCaps,
      reasoningAllowedOptions: ['low', 'medium', 'high'],
    });
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.equal(body.thinking, undefined);
  });

  test('openai-v1 medium and high send nested reasoning.effort', () => {
    for (const effort of ['medium', 'high'] as const) {
      const { body } = reasoningEffortToCompletionBody(effort, 'openai-v1', reasoningCaps);
      assert.deepEqual(body.reasoning, { effort });
      assert.equal(body.enable_thinking, true);
    }
  });

  test('openai-v1 on uses adaptive for MiniMax', () => {
    const { body } = reasoningEffortToCompletionBody('on', 'openai-v1', {
      ...reasoningCaps,
      reasoningThinkingEnabledValue: 'adaptive',
    });
    assert.deepEqual(body, {
      thinking: { type: 'adaptive' },
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  test('lm-studio-v0 off sets none effort and disables enable_thinking', () => {
    const patch = reasoningEffortToCompletionBody('off', 'lm-studio-v0', reasoningCaps);
    assert.equal(patch.body.reasoning_effort, 'none');
    assert.equal(patch.body.enable_thinking, false);
    assert.equal(patch.hint?.bestEffort, true);
  });

  test('lm-studio-v0 on uses medium effort with enable_thinking', () => {
    const patch = reasoningEffortToCompletionBody('on', 'lm-studio-v0', reasoningCaps);
    assert.equal(patch.body.reasoning_effort, 'medium');
    assert.deepEqual(patch.body.reasoning, { effort: 'medium' });
    assert.equal(patch.body.enable_thinking, true);
    assert.equal(patch.hint?.bestEffort, true);
  });

  test('lm-studio-v0 low/medium/high map effort fields directly', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const patch = reasoningEffortToCompletionBody(effort, 'lm-studio-v0', reasoningCaps);
      assert.equal(patch.body.reasoning_effort, effort);
      assert.deepEqual(patch.body.reasoning, { effort });
      assert.equal(patch.body.enable_thinking, true);
    }
  });

  test('Qwen3.8 LM Studio high maps to xhigh with preserve_thinking', () => {
    const patch = reasoningEffortToCompletionBody(
      'high',
      'lm-studio-v0',
      reasoningCaps,
      null,
      'qwen/qwen3.8-27b',
    );
    assert.equal(patch.body.enable_thinking, true);
    assert.equal(patch.body.reasoning_effort, 'xhigh');
    assert.deepEqual(patch.body.reasoning, { effort: 'xhigh' });
    assert.equal(patch.body.preserve_thinking, true);
  });

  test('Qwen3.8 LM Studio off disables thinking without preserve_thinking', () => {
    const patch = reasoningEffortToCompletionBody(
      'off',
      'lm-studio-v0',
      reasoningCaps,
      null,
      'qwen/qwen3.8-27b',
    );
    assert.equal(patch.body.enable_thinking, false);
    assert.equal(patch.body.reasoning_effort, 'none');
    assert.equal(patch.body.preserve_thinking, undefined);
  });

  test('Qwen3.8 openai-v1 high maps to xhigh and local Jinja kwargs', () => {
    const patch = reasoningEffortToCompletionBody(
      'high',
      'openai-v1',
      reasoningCaps,
      null,
      'Qwen/Qwen3.8-27B',
    );
    assert.equal(patch.body.reasoning_effort, 'xhigh');
    assert.deepEqual(patch.body.reasoning, { effort: 'xhigh' });
    assert.equal(patch.body.enable_thinking, true);
    assert.deepEqual(patch.body.chat_template_kwargs, {
      enable_thinking: true,
      preserve_thinking: true,
      reasoning_effort: 'xhigh',
    });
  });

  test('non-Qwen3.8 openai-v1 high carries template kwargs without preserve_thinking', () => {
    const patch = reasoningEffortToCompletionBody('high', 'openai-v1', reasoningCaps);
    assert.equal(patch.body.reasoning_effort, 'high');
    // mlx_lm.server reads only chat_template_kwargs, so the level has to ride there
    // for every model — top-level reasoning_effort alone made Low/Medium/High inert.
    assert.deepEqual(patch.body.chat_template_kwargs, {
      enable_thinking: true,
      reasoning_effort: 'high',
    });
    assert.equal(patch.body.enable_thinking, true);
    assert.equal(patch.body.preserve_thinking, undefined);
  });

  test('openai-v1 levels differ on the wire for a local runtime', () => {
    const bodies = (['low', 'medium', 'high'] as const).map(
      (effort) =>
        reasoningEffortToCompletionBody(effort, 'openai-v1', reasoningCaps).body
          .chat_template_kwargs,
    );
    assert.deepEqual(bodies, [
      { enable_thinking: true, reasoning_effort: 'low' },
      { enable_thinking: true, reasoning_effort: 'medium' },
      { enable_thinking: true, reasoning_effort: 'high' },
    ]);
  });
});

const GLM53_FLASH = 'z-ai/glm-5.3-flash';
const glm53Caps: ModelCapabilities = {
  vision: false,
  tools: null,
  streaming: null,
  grammar: null,
  reasoning: true,
  reasoningAllowedOptions: ['low', 'high', 'max'],
  reasoningDefault: 'max',
  contextLength: null,
  loadState: null,
};

describe('GLM-5.3 thinking bodies', () => {
  test('openai-v1 off remaps to enabled + low (never disabled)', () => {
    const { body } = thinkingToCompletionBody(
      'off',
      'openai-v1',
      glm53Caps,
      null,
      GLM53_FLASH,
    );
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.reasoning, { effort: 'low' });
    assert.notEqual((body.thinking as { type?: string }).type, 'disabled');
  });

  test('openai-v1 on remaps to max, not medium', () => {
    const { body } = thinkingToCompletionBody(
      'on',
      'openai-v1',
      glm53Caps,
      null,
      GLM53_FLASH,
    );
    assert.equal(body.reasoning_effort, 'max');
    assert.deepEqual(body.thinking, { type: 'enabled' });
  });

  test('openai-v1 medium remaps to low', () => {
    const { body } = reasoningEffortToCompletionBody(
      'medium',
      'openai-v1',
      glm53Caps,
      null,
      GLM53_FLASH,
    );
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.thinking, { type: 'enabled' });
  });

  test('openai-v1 high stays high; max stays max', () => {
    const high = reasoningEffortToCompletionBody(
      'high',
      'openai-v1',
      glm53Caps,
      null,
      GLM53_FLASH,
    ).body;
    assert.equal(high.reasoning_effort, 'high');
    const max = reasoningEffortToCompletionBody(
      'max',
      'openai-v1',
      glm53Caps,
      null,
      'glm-5.3',
    ).body;
    assert.equal(max.reasoning_effort, 'max');
  });

  test('does not send enable_thinking false', () => {
    const { body } = reasoningEffortToCompletionBody(
      'off',
      'openai-v1',
      glm53Caps,
      null,
      GLM53_FLASH,
    );
    assert.notEqual(body.enable_thinking, false);
  });
});
