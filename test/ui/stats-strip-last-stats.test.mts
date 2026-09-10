/**
 * Metrics strip paints the canonical last-turn snapshot and survives model-cache refreshes.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  installHappyDomGlobals,
  seedMinimalSession,
  teardownHappyDomAsync,
} from '../os/dom-helpers.mts';

const { setSessionStateForTests, getActiveChat } = await import('../../src/state/sessions.ts');
const { refreshMetricsStripForChat } = await import('../../src/ui/stats.ts');
const { showCachedModelInfo } = await import('../../src/api/models.ts');
const { formatStatCount } = await import('../../src/usage/format-stat-count.ts');
const { buildLastStatsSnapshot } = await import('../../src/usage/chat-turn-metrics.ts');
const { appendStats } = await import('../../src/ui/messages.ts');
const { getContextBudget } = await import('../../src/chat/context-usage.ts');

/** @type {import('happy-dom').Window | undefined} */
let win;

function setupStripDom() {
  win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = `
    <select id="modelSelect"><option value="local/qwen" selected>qwen</option></select>
    <div id="stripTPS">—</div>
    <div id="stripTTFT">—</div>
    <div id="stripGen">—</div>
    <div id="stripTotal">—</div>
    <div id="stripCost">—</div>
    <div id="barPrompt"></div>
    <div id="barCompletion"></div>
    <div id="cntPrompt">—</div>
    <div id="cntCompletion">—</div>
    <div id="iArch">—</div>
    <div id="iQuant">—</div>
    <div id="iCtx">—</div>
    <div id="iStop">—</div>
    <div id="statsExpandPreview"></div>
  `;
}

describe('metrics strip last-turn parity', { concurrency: false }, () => {
  afterEach(async () => {
    setSessionStateForTests(null);
    if (win) {
      await teardownHappyDomAsync(win);
      win = undefined;
    }
  });

  test('hydrates prompt-only lastStats from the last assistant chip usage', () => {
    setupStripDom();
    seedMinimalSession();
    const chat = getActiveChat();
    chat.lastStats = buildLastStatsSnapshot({}, { prompt_tokens: 61_692 });
    chat.history = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'ok',
        stats: {
          tokens_per_second: 21.4,
          time_to_first_token: 0.469,
          generation_time: 8.12,
        },
        usage: { prompt_tokens: 61_692, completion_tokens: 5_794, total_tokens: 67_486 },
      },
    ];

    refreshMetricsStripForChat(chat);

    assert.equal(document.getElementById('stripTotal')?.textContent, formatStatCount(67_486).display);
    assert.equal(document.getElementById('cntPrompt')?.textContent, formatStatCount(61_692).display);
    assert.equal(document.getElementById('cntCompletion')?.textContent, formatStatCount(5_794).display);
    assert.equal(document.getElementById('stripTPS')?.textContent, '21.4');
    assert.equal(chat.lastStats?.total_tokens, 67_486);
  });

  test('showCachedModelInfo does not blank last-turn tokens', () => {
    setupStripDom();
    seedMinimalSession();
    const chat = getActiveChat();
    chat.modelId = 'local/qwen';
    chat.lastStats = buildLastStatsSnapshot(
      { tokens_per_second: 40, time_to_first_token: 0.2, generation_time: 3 },
      { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
    );

    refreshMetricsStripForChat(chat);
    showCachedModelInfo();

    assert.equal(document.getElementById('stripTotal')?.textContent, formatStatCount(1050).display);
    assert.equal(document.getElementById('stripTPS')?.textContent, '40.0');
    assert.equal(document.getElementById('cntPrompt')?.textContent, formatStatCount(1000).display);
  });

  /**
   * A tool-loop turn used to leave three different numbers on screen: the chip
   * showed the final round, the strip showed latest-prompt + summed completions,
   * and the ring inherited the strip's rollup. All three are context occupancy
   * now — the final round's prompt + reply.
   */
  test('chip, strip and context ring agree after a multi-round tool turn', async () => {
    setupStripDom();
    seedMinimalSession();
    const chat = getActiveChat();
    chat.modelId = 'local/qwen';
    chat.historyLoaded = true;

    const rounds = [
      { prompt_tokens: 10_000, completion_tokens: 500, total_tokens: 10_500 },
      { prompt_tokens: 11_200, completion_tokens: 400, total_tokens: 11_600 },
      { prompt_tokens: 12_400, completion_tokens: 800, total_tokens: 13_200 },
    ];
    const finalRound = rounds[rounds.length - 1];

    chat.history = [
      { role: 'user', content: 'go' },
      ...rounds.map((usage, i) => ({
        role: 'assistant' as const,
        content: i === rounds.length - 1 ? 'done' : '',
        stats: { tokens_per_second: 20 },
        usage,
      })),
    ];
    // What run-turn-chat now persists at turn end: the final round, not the rollup.
    chat.lastStats = buildLastStatsSnapshot({ tokens_per_second: 20 }, finalRound);
    const { emptyLedger } = await import('../../src/usage/token-ledger.ts');
    chat.tokenLedger = emptyLedger();
    chat.tokenLedger.totals = {
      promptTokens: 33_600, completionTokens: 1700, totalTokens: 35_300,
      completionCount: 3, costUsd: 0,
    };

    refreshMetricsStripForChat(chat);

    const chipRow = document.createElement('div');
    appendStats(chipRow, { tokens_per_second: 20 }, finalRound);
    const chipTokens = chipRow.querySelector('.stat-chip.r span')?.textContent;

    const budget = await getContextBudget({ chat, modelId: chat.modelId });

    assert.equal(
      document.getElementById('stripTotal')?.textContent,
      formatStatCount(finalRound.total_tokens).display,
    );
    assert.equal(chipTokens, formatStatCount(finalRound.total_tokens).display);
    assert.equal(budget.used, finalRound.total_tokens);
    assert.equal(budget.isEstimate, false);
    assert.equal(budget.sessionUsage?.totalTokens, 35_300);
    assert.equal(budget.sessionUsage?.completionCount, 3);
    const { toggleContextUsageBreakdown, closeContextUsageBreakdown } = await import('../../src/ui/context-usage-breakdown.ts');
    const { listContextUsageSurfaces } = await import('../../src/ui/context-usage-surface.ts');
    const surface = listContextUsageSurfaces()[0];
    const panel = document.createElement('div');
    panel.id = surface.breakdownId;
    document.body.append(panel);
    const ring = document.createElement('button');
    ring.id = surface.ringId;
    document.body.append(ring);
    toggleContextUsageBreakdown(budget, surface);
    assert.match(panel.textContent ?? '', /Session usage · 3 requests/);
    assert.match(panel.textContent ?? '', /35,300 total/);
    assert.match(panel.textContent ?? '', /History sent again counts again/);
    closeContextUsageBreakdown();
  });
});
