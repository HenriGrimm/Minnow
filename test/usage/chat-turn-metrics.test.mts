/**
 * Last-turn metrics resolver: stored lastStats merged with the last assistant row.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildLastStatsSnapshot,
  lastStatsFromHistory,
  lastStatsHasMetrics,
  lastStatsNeedsHydration,
  mergeLastStats,
  resolveLastTurnMetrics,
  resolveLastRequestMetrics,
} from '../../src/usage/chat-turn-metrics.ts';
import type { Chat } from '../../src/types.ts';

function chatWith(partial: Partial<Chat>): Chat {
  return {
    id: 'chat-1',
    name: 'Test',
    workspacePath: '',
    modelId: 'm1',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
    ...partial,
  } as Chat;
}

describe('buildLastStatsSnapshot', () => {
  test('latest CLI request survives persistence while ledger counts both delayed requests', async () => {
    const { recordTokenUsage } = await import('../../src/usage/token-ledger.ts');
    const usage = { prompt_tokens: 246053, completion_tokens: 188, total_tokens: 246241,
      last_request_usage: { prompt_tokens: 123122, completion_tokens: 96, total_tokens: 123218 } };
    const chat = chatWith({ history: [{ role: 'assistant', content: 'Done.', usage }], lastStats: buildLastStatsSnapshot({}, usage) });
    recordTokenUsage(chat, { source: { kind: 'main', modeId: 'general' }, providerId: 'codex-cli', modelId: 'fixture', usage, costUsd: null });
    const restored = JSON.parse(JSON.stringify(chat)) as Chat;
    assert.equal(resolveLastRequestMetrics(restored)?.total_tokens, 123218);
    assert.equal(resolveLastRequestMetrics(restored)?.prompt_tokens, 123122);
    assert.equal(restored.tokenLedger?.totals.totalTokens, 246241);
    assert.equal(restored.tokenLedger?.totals.promptTokens, 246053);
  });

  test('aggregate-only CLI usage stays unknown instead of falling back to stale or aggregate metrics', () => {
    const chat = chatWith({ history: [{ role: 'assistant', content: 'Done.', usage: {
      prompt_tokens: 500, completion_tokens: 40, last_request_usage: null,
    } }], lastStats: buildLastStatsSnapshot({}, { total_tokens: 540 }) });
    assert.equal(resolveLastRequestMetrics(chat)?.total_tokens, null);
    assert.equal(resolveLastRequestMetrics(chat)?.prompt_tokens, null);
  });

  test('ordinary API usage retains hydration from the richer lastStats snapshot', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 20 };
    const chat = chatWith({ history: [{ role: 'assistant', content: 'Done.', usage }],
      lastStats: buildLastStatsSnapshot({}, usage) });
    assert.equal(resolveLastRequestMetrics(chat)?.total_tokens, 120);
    chat.history[0].usage = { prompt_tokens: 100 };
    assert.equal(resolveLastRequestMetrics(chat)?.total_tokens, 120);
  });

  test('fills total_tokens from prompt + completion', () => {
    const ls = buildLastStatsSnapshot({ tokens_per_second: 10 }, {
      prompt_tokens: 61_692,
      completion_tokens: 5_794,
    });
    assert.equal(ls.total_tokens, 67_486);
    assert.equal(ls.prompt_tokens, 61_692);
    assert.equal(ls.completion_tokens, 5_794);
    assert.equal(ls.tokens_per_second, 10);
  });

  test('keeps an explicit total_tokens', () => {
    const ls = buildLastStatsSnapshot({}, { total_tokens: 15_522 });
    assert.equal(ls.total_tokens, 15_522);
  });
});

describe('mergeLastStats', () => {
  test('fills completion from the same-prompt history row', () => {
    const stored = buildLastStatsSnapshot({}, { prompt_tokens: 61_692 });
    const history = buildLastStatsSnapshot(
      { tokens_per_second: 40, time_to_first_token: 0.4, generation_time: 12 },
      { prompt_tokens: 61_692, completion_tokens: 5_794, total_tokens: 67_486 },
    );
    const merged = mergeLastStats(stored, history);
    assert.equal(merged?.prompt_tokens, 61_692);
    assert.equal(merged?.completion_tokens, 5_794);
    assert.equal(merged?.total_tokens, 67_486);
    assert.equal(merged?.tokens_per_second, 40);
  });

  test('a same-round history row overrides a stale tool-loop rollup', () => {
    // What older builds persisted for a 3-round turn: latest prompt + summed
    // completions (100 + 200 + 50). The final assistant row knows the truth.
    const storedRollup = buildLastStatsSnapshot(
      { tokens_per_second: 21.4, generation_time: 21 },
      { prompt_tokens: 3_000, completion_tokens: 350, total_tokens: 3_350 },
    );
    const finalRound = buildLastStatsSnapshot(
      { tokens_per_second: 50, generation_time: 1 },
      { prompt_tokens: 3_000, completion_tokens: 50, total_tokens: 3_050 },
    );
    const merged = mergeLastStats(storedRollup, finalRound);
    assert.equal(merged?.completion_tokens, 50);
    assert.equal(merged?.total_tokens, 3_050);
    // Rates stay turn-averaged.
    assert.equal(merged?.tokens_per_second, 21.4);
    assert.equal(lastStatsNeedsHydration(storedRollup, merged!), true);
  });

  test('does not mix completions from a different prompt size', () => {
    const stored = buildLastStatsSnapshot({}, {
      prompt_tokens: 3_000,
      completion_tokens: 50,
      total_tokens: 3_050,
    });
    const previous = buildLastStatsSnapshot({}, {
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
    });
    const merged = mergeLastStats(stored, previous);
    assert.equal(merged?.prompt_tokens, 3_000);
    assert.equal(merged?.completion_tokens, 50);
    assert.equal(merged?.total_tokens, 3_050);
  });
});

describe('resolveLastTurnMetrics', () => {
  test('hydrates prompt-only lastStats from the last assistant row', () => {
    const chat = chatWith({
      lastStats: buildLastStatsSnapshot({}, { prompt_tokens: 61_692 }),
      history: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'ok',
          stats: {
            tokens_per_second: 21.4,
            time_to_first_token: 0.5,
            generation_time: 8,
          },
          usage: { prompt_tokens: 61_692, completion_tokens: 5_794, total_tokens: 67_486 },
        },
      ],
    });
    const resolved = resolveLastTurnMetrics(chat);
    assert.equal(resolved?.total_tokens, 67_486);
    assert.equal(resolved?.prompt_tokens, 61_692);
    assert.equal(resolved?.completion_tokens, 5_794);
    assert.equal(resolved?.tokens_per_second, 21.4);
    assert.equal(lastStatsNeedsHydration(chat.lastStats, resolved!), true);
  });

  test('skips unloaded lazy history', () => {
    const chat = chatWith({
      historyLoaded: false,
      lastStats: null,
      history: [
        {
          role: 'assistant',
          content: 'ok',
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ],
    });
    assert.equal(lastStatsFromHistory(chat), null);
    assert.equal(resolveLastTurnMetrics(chat), null);
  });

  test('uses history when lastStats is null', () => {
    const chat = chatWith({
      lastStats: null,
      history: [
        {
          role: 'assistant',
          content: 'ok',
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        },
      ],
    });
    const resolved = resolveLastTurnMetrics(chat);
    assert.equal(resolved?.total_tokens, 120);
    assert.equal(lastStatsHasMetrics(resolved), true);
  });
});
