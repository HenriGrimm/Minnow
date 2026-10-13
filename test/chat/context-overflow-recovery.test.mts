/**
 * Context-window overflow recognition, provider-number recovery, and the
 * calibration that keeps a turn from paying for the same miss twice.
 *
 * Regression cover for the failure where every overflow ended the turn: the
 * marker list did not match llama.cpp, nothing retried, and the budget's own
 * trigger point sat above the hard limit it was meant to protect.
 */

import assert from 'node:assert/strict';
import { describe, test, beforeEach } from 'node:test';
import {
  contextRetryMessageLimit,
  isContextOverflowText,
  parseContextOverflowNumbers,
  parseMaxTokensOverflow,
} from '../../src/chat/context/context-overflow-error.ts';
import {
  contextCalibratedMessageLimit,
  contextEstimateBias,
  recordContextEstimateBias,
  resetContextEstimateCalibrationForTests,
} from '../../src/chat/context/estimate-calibration.ts';
import { SAFETY_MARGIN } from '../../src/chat/context-budget.ts';

/** Verbatim from ~/.minnow/logs/diagnostics.jsonl, 2026-08-25. */
const LLAMA_CPP_400 =
  'Upstream HTTP 400: request (104264 tokens) exceeds the available context size ' +
  '(89088 tokens), try increasing it';

/** Verbatim error message from the 2026-09-09 local Qwen failure artifact. */
const LLAMA_CPP_EXCEED_CONTEXT_ERROR =
  'request (69351 tokens) exceeds the available context size (58368 tokens), try increasing it';

/** Reported by Strata (stratallm.org) when prompt + max_tokens > window. */
const STRATA_400 =
  'Upstream HTTP 400: request exceeds the context window: prompt (13355 tokens) + max tokens (131072) ' +
  'exceeds the context (131072); requests are never truncated. Send a smaller max_tokens (at most 117709 here)';

describe('parseMaxTokensOverflow', () => {
  test('recovers prompt, max_tokens and window from Strata', () => {
    assert.deepEqual(parseMaxTokensOverflow(STRATA_400), {
      promptTokens: 13355,
      maxTokens: 131072,
      contextTokens: 131072,
    });
  });

  test('returns null for other overflow shapes', () => {
    assert.equal(parseMaxTokensOverflow(LLAMA_CPP_400), null);
    assert.equal(parseMaxTokensOverflow('Upstream HTTP 401: invalid api key'), null);
  });
});

describe('isContextOverflowText', () => {
  test("matches Strata's prompt + max tokens rejection", () => {
    assert.equal(isContextOverflowText(STRATA_400), true);
  });

  test("matches llama.cpp's wording", () => {
    assert.equal(isContextOverflowText(LLAMA_CPP_400), true);
    assert.equal(isContextOverflowText(LLAMA_CPP_EXCEED_CONTEXT_ERROR), true);
  });

  test('matches OpenAI and Anthropic wordings', () => {
    assert.equal(
      isContextOverflowText(
        "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.",
      ),
      true,
    );
    assert.equal(isContextOverflowText('prompt is too long: 210000 tokens > 200000'), true);
    assert.equal(
      isContextOverflowText('Prompt too long: 40016 tokens exceeds max context window of 32768 tokens'),
      true,
    );
  });

  test('does not match unrelated failures', () => {
    assert.equal(isContextOverflowText('Upstream HTTP 401: invalid api key'), false);
    assert.equal(isContextOverflowText('ECONNREFUSED 127.0.0.1:5432'), false);
    assert.equal(isContextOverflowText('Maximum tool turns reached'), false);
  });
});

describe('parseContextOverflowNumbers', () => {
  test('recovers the request and limit the server measured', () => {
    assert.deepEqual(parseContextOverflowNumbers(LLAMA_CPP_400), {
      requestTokens: 104264,
      limitTokens: 89088,
    });
  });

  test('recovers the exact local Qwen overflow measurements', () => {
    assert.deepEqual(parseContextOverflowNumbers(LLAMA_CPP_EXCEED_CONTEXT_ERROR), {
      requestTokens: 69351,
      limitTokens: 58368,
    });
  });

  test('returns null when the provider reported no usable pair', () => {
    assert.equal(parseContextOverflowNumbers('context length exceeded'), null);
    // A request that already fits cannot be the cause of an overflow.
    assert.equal(
      parseContextOverflowNumbers('request (10 tokens) exceeds the size (99 tokens)'),
      null,
    );
  });
});

describe('contextRetryMessageLimit', () => {
  test('scales the message estimate by the overshoot the server reported', () => {
    const numbers = parseContextOverflowNumbers(LLAMA_CPP_400)!;
    // 80000 estimated message tokens produced a 104264-token request, so the
    // ceiling that lands on 0.9 × 89088 real is the same fraction of 80000.
    const limit = contextRetryMessageLimit(80000, numbers, SAFETY_MARGIN);
    assert.equal(limit, Math.floor((80000 * 89088 * 0.9) / 104264));
    assert.ok(limit < 80000);
  });

  test('a retry always targets less than what was just rejected', () => {
    const numbers = parseContextOverflowNumbers(LLAMA_CPP_400);
    for (const sent of [1, 500, 40000, 250000]) {
      assert.ok(contextRetryMessageLimit(sent, numbers, SAFETY_MARGIN) <= sent);
    }
  });

  test('falls back to a blind shrink when the provider gave no numbers', () => {
    const limit = contextRetryMessageLimit(10000, null, SAFETY_MARGIN);
    assert.ok(limit > 0);
    assert.ok(limit < 10000);
  });
});

describe('estimate calibration', () => {
  beforeEach(() => {
    resetContextEstimateCalibrationForTests();
  });

  test('learns the real-per-estimated ratio from a rejected request', () => {
    recordContextEstimateBias('qwen', 104264, 80000);
    assert.equal(contextEstimateBias('qwen'), 104264 / 80000);
  });

  test('an unmeasured model stays on the ordinary budget', () => {
    assert.equal(contextEstimateBias('never-seen'), null);
    assert.equal(contextCalibratedMessageLimit('never-seen', 89088, SAFETY_MARGIN), null);
  });

  test('the calibrated ceiling is below the plain margin budget', () => {
    recordContextEstimateBias('qwen', 104264, 80000);
    const calibrated = contextCalibratedMessageLimit('qwen', 89088, SAFETY_MARGIN)!;
    assert.ok(calibrated < Math.floor(89088 * SAFETY_MARGIN));
  });

  test('the tool reserve is taken out once, not twice', () => {
    // Both the recorded sample and the ceiling exclude the reserve, so a model
    // with a perfectly accurate estimator lands exactly on the plain budget.
    const reserve = 12048;
    recordContextEstimateBias('exact', 80000 + reserve, 80000, reserve);
    assert.equal(contextEstimateBias('exact'), null);

    recordContextEstimateBias('slight', 82000 + reserve, 80000, reserve);
    const ceiling = contextCalibratedMessageLimit(
      'slight',
      89088,
      SAFETY_MARGIN,
      reserve,
    )!;
    const plain = Math.floor(89088 * SAFETY_MARGIN) - reserve;
    assert.ok(ceiling < plain);
    // A 2.5% miss must not cost anything like the 15% the reserve is worth.
    assert.ok(ceiling > plain * 0.9);
  });

  test('keeps the worst gap seen, so a light turn cannot relax the ceiling', () => {
    recordContextEstimateBias('qwen', 104264, 80000); // ratio 1.303
    recordContextEstimateBias('qwen', 90052, 85000); // ratio 1.059
    assert.equal(contextEstimateBias('qwen'), 104264 / 80000);
  });

  test('ignores samples that show no undercount at all', () => {
    recordContextEstimateBias('qwen', 900, 1000);
    assert.equal(contextEstimateBias('qwen'), null);
  });
});
