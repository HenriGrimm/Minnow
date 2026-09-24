/**
 * Unit tests for reasoning effort helpers (`src/lib/reasoning-effort.ts`).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  defaultComposerReasoningLevel,
  getComposerReasoningLevelOptions,
  ensureGlm53ReasoningAllowedOptions,
  ensureDeepSeekV4ReasoningAllowedOptions,
  ensureQwen38ReasoningAllowedOptions,
  inferReasoningOptionsFromModelId,
  isGlm53ModelId,
  isDeepSeekV4ModelId,
  isQwen38ModelId,
  modelHasSelectableReasoningEffort,
  modelShowsComposerBrainToggle,
  modelUsesAlwaysOnReasoning,
  modelUsesComposerReasoningBinaryDropdown,
  modelUsesComposerReasoningDropdown,
  modelUsesComposerThinkingToggle,
  normalizeReasoningAllowedOptions,
  normalizeReasoningCatalogValue,
  resolveEffectiveReasoningEffort,
} from '../../src/lib/reasoning-effort.ts';

// ── normalizeReasoningAllowedOptions ─────────────────────────────────────────

describe('normalizeReasoningAllowedOptions', () => {
  test('preserves low, medium, and high in canonical order', () => {
    const result = normalizeReasoningAllowedOptions([
      'high',
      'invalid',
      'low',
      'medium',
      'bogus',
    ]);
    assert.deepEqual(result, ['low', 'medium', 'high']);
  });

  test('drops unknown values and keeps off/on when present', () => {
    const result = normalizeReasoningAllowedOptions(['on', 'nope', 'off']);
    assert.deepEqual(result, ['off', 'on']);
  });

  test('returns empty array when nothing is valid', () => {
    assert.deepEqual(normalizeReasoningAllowedOptions(['x', 1, null]), []);
  });

  test('maps xhigh onto high so the composer can show High', () => {
    assert.deepEqual(
      normalizeReasoningAllowedOptions(['xhigh', 'medium', 'low', 'off']),
      ['off', 'low', 'medium', 'high'],
    );
  });

  test('maps none onto off', () => {
    assert.deepEqual(normalizeReasoningAllowedOptions(['none', 'low', 'xhigh']), [
      'off',
      'low',
      'high',
    ]);
  });
});

// ── modelHasSelectableReasoningEffort ────────────────────────────────────────

describe('modelHasSelectableReasoningEffort', () => {
  test('returns false with zero or one allowed option', () => {
    assert.equal(modelHasSelectableReasoningEffort(null), false);
    assert.equal(modelHasSelectableReasoningEffort({}), false);
    assert.equal(
      modelHasSelectableReasoningEffort({ reasoningAllowedOptions: ['medium'] }),
      false,
    );
  });

  test('returns true when two or more options are allowed', () => {
    assert.equal(
      modelHasSelectableReasoningEffort({
        reasoningAllowedOptions: ['off', 'on'],
      }),
      true,
    );
    assert.equal(
      modelHasSelectableReasoningEffort({
        reasoningAllowedOptions: ['low', 'medium', 'high'],
      }),
      true,
    );
  });
});

// ── composer reasoning ───────────────────────────────────────────────────────

describe('composer reasoning control helpers', () => {
  test('dropdown when low/medium/high are allowed', () => {
    const caps = { reasoningAllowedOptions: ['low', 'medium', 'high'] };
    assert.equal(modelUsesComposerReasoningDropdown(caps), true);
    assert.equal(modelUsesComposerThinkingToggle(caps), false);
    assert.equal(modelShowsComposerBrainToggle(caps), true);
  });

  test('brain toggle when only off/on are allowed (no binary effort select)', () => {
    const caps = { reasoningAllowedOptions: ['off', 'on'] };
    assert.equal(modelUsesComposerReasoningDropdown(caps), false);
    assert.equal(modelUsesComposerReasoningBinaryDropdown(caps), false);
    assert.equal(modelUsesComposerThinkingToggle(caps), true);
    assert.equal(modelShowsComposerBrainToggle(caps), true);
  });

  test('brain toggle when reasoning is advertised without explicit options', () => {
    assert.equal(modelUsesComposerThinkingToggle({ reasoning: true }), true);
    assert.equal(modelUsesComposerThinkingToggle({ reasoning: false }), false);
  });

  test('level options exclude off and on', () => {
    assert.deepEqual(
      getComposerReasoningLevelOptions(['off', 'low', 'medium', 'high', 'on']),
      ['low', 'medium', 'high'],
    );
  });

  test('defaultComposerReasoningLevel prefers catalog default', () => {
    assert.equal(
      defaultComposerReasoningLevel({
        reasoningAllowedOptions: ['low', 'medium', 'high'],
        reasoningDefault: 'high',
      }),
      'high',
    );
  });
});

// ── inferReasoningOptionsFromModelId ─────────────────────────────────────────

describe('inferReasoningOptionsFromModelId', () => {
  // Bare {id} catalogs (llama.cpp, mlx_lm.server, MTPLX) give no reasoning metadata,
  // so levels stay the openai-v1 default. Narrowing this to an allowlist of
  // effort-trained families regressed MTPLX, hiding the dropdown on ids it missed.
  test('infers off/low/medium/high for any openai-v1 model without catalog', () => {
    const expected = ['off', 'low', 'medium', 'high'];
    for (const id of [
      'openai/o3-mini',
      'gpt-5-preview',
      'openai/gpt-oss-20b',
      'meta-llama/Llama-3.2-3B',
      'qwen/qwen3-32b',
      'Youssofal/Qwen3.8-27B-MTP-4bit',
    ]) {
      assert.deepEqual(inferReasoningOptionsFromModelId(id, 'openai-v1'), expected, id);
    }
  });

  test('uses off/on for thinking-type-only vendors on openai-v1', () => {
    assert.deepEqual(
      inferReasoningOptionsFromModelId('moonshot/kimi-k2', 'openai-v1'),
      ['off', 'on'],
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId('deepseek/deepseek-chat', 'openai-v1'),
      ['off', 'on'],
    );
  });

  test('DeepSeek V4 exposes its documented low/high/max effort levels', () => {
    for (const id of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']) {
      assert.equal(isDeepSeekV4ModelId(id), true);
      assert.deepEqual(inferReasoningOptionsFromModelId(id, 'openai-v1'), [
        'off', 'low', 'high', 'max',
      ]);
      assert.deepEqual(
        ensureDeepSeekV4ReasoningAllowedOptions(id, ['off', 'on']),
        ['off', 'low', 'high', 'max'],
      );
    }
    assert.equal(isDeepSeekV4ModelId('deepseek-chat'), false);
    assert.deepEqual(inferReasoningOptionsFromModelId('deepseek-chat', 'openai-v1'), ['off', 'on']);
  });

  test('returns empty for lm-studio-v0 (catalog should drive options)', () => {
    assert.deepEqual(
      inferReasoningOptionsFromModelId('openai/o3-mini', 'lm-studio-v0'),
      [],
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId('meta-llama/Llama-3.2-3B', 'lm-studio-v0'),
      [],
    );
  });

  test('infers off/low/medium/high for Qwen3.8 on any api kind', () => {
    const expected = ['off', 'low', 'medium', 'high'];
    assert.deepEqual(
      inferReasoningOptionsFromModelId('qwen/qwen3.8-27b', 'lm-studio-v0'),
      expected,
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId('Qwen/Qwen3.8-27B', 'openai-v1'),
      expected,
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId(
        'gguf:unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-Q4_K_M.gguf',
      ),
      expected,
    );
  });

  test('returns empty for non-Qwen models when apiKind is missing', () => {
    assert.deepEqual(inferReasoningOptionsFromModelId('llama-3-8b'), []);
  });
});

// ── resolveEffectiveReasoningEffort ──────────────────────────────────────────

describe('resolveEffectiveReasoningEffort', () => {
  const caps = {
    reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
    reasoningDefault: 'medium',
  };

  test('prefers chat.reasoningEffort when allowed', () => {
    assert.equal(
      resolveEffectiveReasoningEffort({ reasoningEffort: 'high' }, caps, 'off'),
      'high',
    );
  });

  test('falls back to catalog default when chat override is unset', () => {
    assert.equal(resolveEffectiveReasoningEffort({}, caps, 'off'), 'medium');
  });

  test('honors explicit off even when catalog omits off from allowed list', () => {
    assert.equal(
      resolveEffectiveReasoningEffort(
        { reasoningEffort: 'off' },
        { reasoningAllowedOptions: ['low', 'medium', 'high'] },
        'on',
      ),
      'off',
    );
  });

  test('ignores chat override that is not in allowed list', () => {
    assert.equal(
      resolveEffectiveReasoningEffort({ reasoningEffort: 'on' }, caps, 'off'),
      'medium',
    );
  });

  test('maps resolved brain on to medium when catalog default is absent', () => {
    const effortOnly = { reasoningAllowedOptions: ['off', 'low', 'medium', 'high'] };
    assert.equal(resolveEffectiveReasoningEffort({}, effortOnly, 'on'), 'medium');
  });

  test('inherited on beats catalog default off', () => {
    assert.equal(
      resolveEffectiveReasoningEffort(
        {},
        { reasoningAllowedOptions: ['off', 'low', 'medium', 'high'], reasoningDefault: 'off' },
        'on',
      ),
      'medium',
    );
  });

  test('inherited on uses catalog default high when present', () => {
    assert.equal(
      resolveEffectiveReasoningEffort(
        {},
        {
          reasoningAllowedOptions: ['off', 'low', 'medium', 'high'],
          reasoningDefault: 'high',
        },
        'on',
      ),
      'high',
    );
  });

  test('maps resolved brain off to off when catalog default is absent', () => {
    const effortOnly = { reasoningAllowedOptions: ['off', 'low', 'medium', 'high'] };
    assert.equal(resolveEffectiveReasoningEffort({}, effortOnly, 'off'), 'off');
  });

  test('uses first allowed option as last resort', () => {
    const minimal = { reasoningAllowedOptions: ['low', 'high'] };
    assert.equal(resolveEffectiveReasoningEffort({}, minimal, 'on'), 'low');
  });

  test('returns undefined when model exposes no allowed options', () => {
    assert.equal(resolveEffectiveReasoningEffort({}, {}, 'on'), undefined);
    assert.equal(resolveEffectiveReasoningEffort({}, {}, 'off'), undefined);
  });
});

// ── isQwen38ModelId ──────────────────────────────────────────────────────────

describe('isQwen38ModelId', () => {
  test('matches dotted and underscored 3.8 ids, not Qwen3-8B', () => {
    assert.equal(isQwen38ModelId('qwen/qwen3.8-27b'), true);
    assert.equal(isQwen38ModelId('qwen3.8-27b'), true);
    assert.equal(isQwen38ModelId('Qwen/Qwen3.8-27B'), true);
    assert.equal(isQwen38ModelId('qwen3_8-27b'), true);
    assert.equal(isQwen38ModelId('Qwen/Qwen3-8B'), false);
    assert.equal(isQwen38ModelId('qwen/qwen3-32b'), false);
    assert.equal(isQwen38ModelId('qwen3.5-27b'), false);
  });

  test('ensureQwen38ReasoningAllowedOptions upgrades off/on catalogs to levels', () => {
    assert.deepEqual(
      ensureQwen38ReasoningAllowedOptions('qwen/qwen3.8-27b', ['off', 'on']),
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(
      ensureQwen38ReasoningAllowedOptions('qwen/qwen3.8-27b', ['low', 'xhigh']),
      ['off', 'low', 'medium', 'high'],
    );
    assert.deepEqual(
      ensureQwen38ReasoningAllowedOptions('qwen/qwen3-32b', ['off', 'on']),
      ['off', 'on'],
    );
  });

  test('normalizeReasoningCatalogValue maps xhigh to high', () => {
    assert.equal(normalizeReasoningCatalogValue('xhigh'), 'high');
    assert.equal(normalizeReasoningCatalogValue('none'), 'off');
    assert.equal(normalizeReasoningCatalogValue('medium'), 'medium');
    assert.equal(normalizeReasoningCatalogValue('nope'), undefined);
  });
});

// ── isGlm53ModelId ───────────────────────────────────────────────────────────

describe('isGlm53ModelId', () => {
  test('matches GLM-5.3 family ids, not 5.2 / 5.1 / 5 / 4.x', () => {
    assert.equal(isGlm53ModelId('glm-5.3'), true);
    assert.equal(isGlm53ModelId('glm-5.3-flash'), true);
    assert.equal(isGlm53ModelId('z-ai/glm-5.3-flash'), true);
    assert.equal(isGlm53ModelId('GLM-5.3-Flash-GGUF'), true);
    assert.equal(isGlm53ModelId('glm5.3'), true);
    assert.equal(isGlm53ModelId('glm_5_3'), true);
    assert.equal(isGlm53ModelId('glm-5.2'), false);
    assert.equal(isGlm53ModelId('glm-5.1'), false);
    assert.equal(isGlm53ModelId('glm-5'), false);
    assert.equal(isGlm53ModelId('glm-4.7'), false);
  });

  test('ensureGlm53ReasoningAllowedOptions always replaces off/on and low/medium/high', () => {
    assert.deepEqual(
      ensureGlm53ReasoningAllowedOptions('glm-5.3-flash', ['off', 'on']),
      ['low', 'high', 'max'],
    );
    assert.deepEqual(
      ensureGlm53ReasoningAllowedOptions('z-ai/glm-5.3-flash', [
        'off',
        'low',
        'medium',
        'high',
      ]),
      ['low', 'high', 'max'],
    );
    assert.deepEqual(
      ensureGlm53ReasoningAllowedOptions('glm-5.2', ['off', 'on']),
      ['off', 'on'],
    );
  });

  test('infers low/high/max for GLM-5.3 on any api kind', () => {
    const expected = ['low', 'high', 'max'];
    assert.deepEqual(
      inferReasoningOptionsFromModelId('glm-5.3-flash', 'lm-studio-v0'),
      expected,
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId('z-ai/glm-5.3-flash', 'openai-v1'),
      expected,
    );
    assert.deepEqual(
      inferReasoningOptionsFromModelId('GLM-5.3-Flash-GGUF'),
      expected,
    );
  });

  test('maps xhigh / extra_high onto max only for GLM-5.3', () => {
    assert.equal(normalizeReasoningCatalogValue('xhigh', 'glm-5.3-flash'), 'max');
    assert.equal(normalizeReasoningCatalogValue('extra_high', 'glm-5.3'), 'max');
    assert.equal(normalizeReasoningCatalogValue('xhigh', 'qwen/qwen3.8-27b'), 'high');
    assert.deepEqual(
      normalizeReasoningAllowedOptions(['xhigh', 'low'], 'glm-5.3-flash'),
      ['low', 'max'],
    );
  });

  test('always-on catalog hides the brain and shows Low/High/Max', () => {
    const caps = {
      reasoningAllowedOptions: ['low', 'high', 'max'],
      reasoningDefault: 'max',
    };
    assert.equal(modelUsesAlwaysOnReasoning(caps), true);
    assert.equal(modelUsesComposerReasoningDropdown(caps), true);
    assert.equal(modelShowsComposerBrainToggle(caps), false);
    assert.deepEqual(getComposerReasoningLevelOptions(caps.reasoningAllowedOptions), [
      'low',
      'high',
      'max',
    ]);
    assert.equal(defaultComposerReasoningLevel(caps), 'max');
  });

  test('does not honor stored off when the model is always-on', () => {
    assert.equal(
      resolveEffectiveReasoningEffort(
        { reasoningEffort: 'off' },
        {
          reasoningAllowedOptions: ['low', 'high', 'max'],
          reasoningDefault: 'max',
        },
        'on',
      ),
      'max',
    );
  });

  test('clamps stored medium by falling through to catalog default max', () => {
    assert.equal(
      resolveEffectiveReasoningEffort(
        { reasoningEffort: 'medium' },
        {
          reasoningAllowedOptions: ['low', 'high', 'max'],
          reasoningDefault: 'max',
        },
        'on',
      ),
      'max',
    );
  });
});
