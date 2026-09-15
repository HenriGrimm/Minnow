/**
 * Context budget assembly (MIN-13) — static breakdown expectations.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  estimateInFlightOverlayTokens,
  getContextInFlightOverlay,
  resetContextOverlayWriteCountForTests,
  getContextOverlayWriteCountForTests,
  setContextInFlightOverlay,
  syncTurnContextUsage,
} from '../../src/chat/context-in-flight.ts';
import {
  assembleContextBudget,
  buildContextUsageBreakdown,
  computeContextUsagePercent,
  estimateAttachmentTokens,
  resolveCompressAtTokens,
  resolveContextLimit,
} from '../../src/chat/context-usage.ts';
import {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  resolveContextBudget,
} from '../../src/chat/context-budget.ts';
import {
  recordContextEstimateBias,
  resetContextEstimateCalibrationForTests,
} from '../../src/chat/context/estimate-calibration.ts';
import { contextLengthFromModelRow } from '../../src/lib/context-length.ts';
import type { Chat } from '../../src/types.ts';
import {
  computeOutboundPromptEstimateFromParts,
  ESTIMATE_IMAGE_URL_TOKENS,
} from '../../src/chat/prompts/token-estimate-core.ts';
import type { Attachment, Message } from '../../src/types.ts';

describe('estimateAttachmentTokens', () => {
  test('sums text attachment bodies', () => {
    const attachments: Attachment[] = [
      {
        id: 'a1',
        name: 'notes.txt',
        kind: 'text',
        mimeType: 'text/plain',
        size: 16,
        text: 'abcd',
      },
    ];
    assert.equal(estimateAttachmentTokens(attachments), 1);
  });

  test('skips error chips', () => {
    const attachments: Attachment[] = [
      {
        id: 'e1',
        name: 'big.bin',
        kind: 'error',
        mimeType: '',
        size: 0,
        error: 'Too large',
      },
    ];
    assert.equal(estimateAttachmentTokens(attachments), 0);
  });

  test('uses the bounded fallback image budget for undecodable data URLs', () => {
    const attachments: Attachment[] = [
      {
        id: 'img1',
        name: 'photo.png',
        kind: 'image',
        mimeType: 'image/png',
        size: 1_000_000,
        dataUrl: `data:image/png;base64,${'A'.repeat(40_000)}`,
      },
    ];
    assert.equal(estimateAttachmentTokens(attachments), ESTIMATE_IMAGE_URL_TOKENS);
  });
});

describe('estimateInFlightOverlayTokens', () => {
  test('counts only pending tool-call JSON (not streaming completion)', () => {
    const tokens = estimateInFlightOverlayTokens({
      partialAssistantText: 'abcd',
      thinkingText: 'efgh',
      pendingToolCallsJson: '{"name":"read_file"}',
    });
    // 20 chars of tool-call JSON, priced at the payload rate.
    assert.equal(tokens, 7);
  });

  test('returns zero when only streaming prose or reasoning is present', () => {
    assert.equal(
      estimateInFlightOverlayTokens({
        partialAssistantText: 'abcd',
        thinkingText: 'efgh',
      }),
      0,
    );
  });
});

describe('P10-I syncTurnContextUsage overlay (MIN-774)', () => {
  test('writes overlay once per helper call and clears', () => {
    resetContextOverlayWriteCountForTests();
    syncTurnContextUsage({
      chatId: 'c-overlay',
      partialAssistantText: 'hello',
      thinkingText: 'hmm',
      pendingToolCallsJson: '{"name":"read_file"}',
    });
    assert.equal(getContextOverlayWriteCountForTests(), 1);
    const overlay = getContextInFlightOverlay('c-overlay');
    assert.equal(overlay?.pendingToolCallsJson, '{"name":"read_file"}');
    assert.equal(overlay?.partialAssistantText, 'hello');
    setContextInFlightOverlay(null);
    assert.equal(getContextInFlightOverlay('c-overlay'), undefined);
    assert.equal(getContextOverlayWriteCountForTests(), 2);
  });

  test('concurrent chats keep separate overlays (MIN-584)', () => {
    resetContextOverlayWriteCountForTests();
    syncTurnContextUsage({ chatId: 'chat-a', partialAssistantText: 'A' });
    syncTurnContextUsage({ chatId: 'chat-b', partialAssistantText: 'B' });
    assert.equal(getContextInFlightOverlay('chat-a')?.partialAssistantText, 'A');
    assert.equal(getContextInFlightOverlay('chat-b')?.partialAssistantText, 'B');
  });

  test('token burst through one paint-tick helper is one write', () => {
    resetContextOverlayWriteCountForTests();
    // Mimic coalesced paint: many deltas, one overlay write.
    const last = 'x'.repeat(20);
    syncTurnContextUsage({
      chatId: 'c-burst',
      partialAssistantText: last,
    });
    assert.equal(getContextOverlayWriteCountForTests(), 1);
    assert.equal(getContextInFlightOverlay('c-burst')?.partialAssistantText, last);
    resetContextOverlayWriteCountForTests();
  });
});

describe('buildContextUsageBreakdown', () => {
  test('includes in-flight row when non-zero', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'sys',
      history: [],
      tools: [],
    });
    const rows = buildContextUsageBreakdown(estimate, 0, 0, 12);
    assert.equal(rows.find((r) => r.key === 'inFlight')?.tokens, 12);
    assert.equal(rows.find((r) => r.key === 'inFlight')?.label, 'In progress (estimate)');
  });

  test('includes composer and attachments when non-zero', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'sys',
      history: [{ role: 'user', content: 'hi' }],
      tools: [],
      userRulesText: 'rule',
    });
    const rows = buildContextUsageBreakdown(estimate, 8, 4);
    const keys = rows.map((r) => r.key);
    assert.deepEqual(keys, ['system', 'rules', 'tools', 'history', 'composer', 'attachments']);
    assert.equal(rows.find((r) => r.key === 'composer')?.tokens, 8);
    assert.equal(rows.find((r) => r.key === 'attachments')?.tokens, 4);
  });

  test('splits code map from system and shows loading row when injection is on', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'sys',
      history: [],
      tools: [],
    });
    estimate.composedSystem = 1000;
    estimate.codeMapSystem = 400;
    estimate.codeMapInjectionEnabled = true;
    const rows = buildContextUsageBreakdown(estimate, 0, 0);
    assert.equal(rows.find((r) => r.key === 'system')?.tokens, 600);
    assert.equal(rows.find((r) => r.key === 'codeMap')?.tokens, 400);

    const loadingEstimate = computeOutboundPromptEstimateFromParts({
      systemText: 'sys',
      history: [],
      tools: [],
    });
    loadingEstimate.codeMapInjectionEnabled = true;
    const loadingRows = buildContextUsageBreakdown(loadingEstimate, 0, 0);
    assert.equal(loadingRows.find((r) => r.key === 'codeMap')?.label, 'Code map (loading)');
    assert.equal(loadingRows.find((r) => r.key === 'codeMap')?.tokens, 0);
  });

  test('splits Brain notes from system', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'sys',
      history: [],
      tools: [],
    });
    estimate.composedSystem = 1000;
    estimate.brainNotesSystem = 250;
    estimate.brainNotesInjectionEnabled = true;
    const rows = buildContextUsageBreakdown(estimate, 0, 0);
    assert.equal(rows.find((r) => r.key === 'system')?.tokens, 750);
    assert.equal(rows.find((r) => r.key === 'brainNotes')?.tokens, 250);
  });
});

describe('computeContextUsagePercent', () => {
  test('caps at 100', () => {
    assert.equal(computeContextUsagePercent(9000, 8000), 100);
  });

  test('returns null when limit unknown', () => {
    assert.equal(computeContextUsagePercent(100, null), null);
  });
});

describe('contextLengthFromModelRow', () => {
  test('prefers loaded_context_length over capabilities.contextLength when loaded', () => {
    assert.equal(
      contextLengthFromModelRow({
        state: 'loaded',
        loaded_context_length: 32_768,
        max_context_length: 262_144,
        capabilities: { contextLength: 262_144 },
      }),
      32_768,
    );
  });

  test('uses capabilities.contextLength when the model is not loaded', () => {
    assert.equal(
      contextLengthFromModelRow({
        state: 'not-loaded',
        loaded_context_length: 32_768,
        max_context_length: 131_072,
        capabilities: { contextLength: 262_144 },
      }),
      262_144,
    );
  });

  test('uses loaded_context_length when model is loaded', () => {
    assert.equal(
      contextLengthFromModelRow({
        state: 'loaded',
        max_context_length: 262_144,
        loaded_context_length: 62_000,
      }),
      62_000,
    );
  });

  test('ignores loaded_context_length when model is not loaded', () => {
    assert.equal(
      contextLengthFromModelRow({
        state: 'not-loaded',
        max_context_length: 131_072,
        loaded_context_length: 62_000,
      }),
      131_072,
    );
  });

  test('falls back to known table when row has id but no context fields', () => {
    assert.equal(
      contextLengthFromModelRow({
        id: 'gpt-4o-mini',
        state: 'loaded',
      }),
      128_000,
    );
  });
});

describe('resolveContextLimit', () => {
  test('prefers configured loaded_context_length over catalog max', async () => {
    const { modelCache } = await import('../../src/app-state.ts');
    modelCache.set('vendor/model', {
      id: 'vendor/model',
      state: 'loaded',
      max_context_length: 262_144,
      loaded_context_length: 62_000,
    });
    const chat = { modelInfo: {} } as Chat;
    assert.equal(resolveContextLimit('vendor/model', chat), 62_000);
    modelCache.delete('vendor/model');
  });

  test('prefers live cache over persisted modelInfo when they differ (MIN-183)', async () => {
    const { modelCache } = await import('../../src/app-state.ts');
    modelCache.set('vendor/model', {
      id: 'vendor/model',
      state: 'loaded',
      max_context_length: 262_144,
      loaded_context_length: 62_000,
    });
    const chat = { modelInfo: { context_length: 48_000 } } as Chat;
    assert.equal(resolveContextLimit('vendor/model', chat), 62_000);
    modelCache.delete('vendor/model');
  });

  test('falls back to last-turn model_info when cache has no context length', async () => {
    const { modelCache } = await import('../../src/app-state.ts');
    const { setSessionStateForTests } = await import('../../src/state/sessions.ts');
    modelCache.clear();
    const chat = { id: 'c-min-183', modelInfo: { context_length: 48_000 } } as Chat;
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });
    assert.equal(resolveContextLimit('vendor/model', chat), 48_000);
    setSessionStateForTests(null);
  });

  test('falls back to max when model is not loaded', async () => {
    const { modelCache } = await import('../../src/app-state.ts');
    modelCache.set('vendor/model', {
      id: 'vendor/model',
      state: 'not-loaded',
      max_context_length: 131_072,
      loaded_context_length: 62_000,
    });
    const chat = { modelInfo: {} } as Chat;
    assert.equal(resolveContextLimit('vendor/model', chat), 131_072);
    modelCache.delete('vendor/model');
  });

  test('uses known table for openai-v1 model without row context fields', async () => {
    const { modelCache } = await import('../../src/app-state.ts');
    modelCache.set('gpt-4o', {
      id: 'gpt-4o',
      state: 'loaded',
    });
    const chat = { modelInfo: {} } as Chat;
    assert.equal(resolveContextLimit('gpt-4o', chat), 128_000);
    modelCache.delete('gpt-4o');
  });
});

describe('assembleContextBudget', () => {
  test('static fixture totals match bucket sum', () => {
    const history: Message[] = [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'reply text here' },
    ];
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'System prompt body',
      history,
      tools: [],
      userRulesText: 'Always be concise',
    });
    const budget = assembleContextBudget({
      modelId: 'test/model',
      modelDisplayName: 'Test Model',
      limit: 32_768,
      estimate,
      composerTokens: 10,
      attachmentTokens: 5,
      inFlightTokens: 7,
      lastTurnPromptTokens: null,
    });

    const bucketSum = budget.breakdown.reduce((sum, row) => sum + row.tokens, 0);
    assert.equal(budget.used, bucketSum);
    assert.equal(budget.used, estimate.total + 10 + 5 + 7);
    assert.equal(budget.remaining, 32_768 - budget.used);
    assert.equal(budget.percent, Math.round((budget.used / 32_768) * 100));
    assert.equal(budget.isEstimate, true);
    assert.equal(budget.lastTurnPromptTokens, null);
    assert.equal(budget.lastTurnCompletionTokens, null);
    assert.equal(budget.lastTurnTotalTokens, null);
  });

  test('marks non-estimate when API prompt tokens exist', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'x',
      history: [],
      tools: [],
    });
    const budget = assembleContextBudget({
      modelId: 'm',
      modelDisplayName: 'M',
      limit: null,
      estimate,
      composerTokens: 0,
      attachmentTokens: 0,
      lastTurnPromptTokens: 1200,
    });
    assert.equal(budget.isEstimate, false);
    assert.equal(budget.used, 1200);
    assert.equal(budget.limit, null);
    assert.equal(budget.percent, null);
    assert.equal(budget.remaining, null);
  });

  test('USED matches last-turn API total and keeps pending extras on top', () => {
    const estimate = computeOutboundPromptEstimateFromParts({
      systemText: 'System prompt body',
      history: [{ role: 'user', content: 'hello world' }],
      tools: [],
    });
    const budget = assembleContextBudget({
      modelId: 'm',
      modelDisplayName: 'M',
      limit: 68_608,
      estimate,
      composerTokens: 10,
      attachmentTokens: 0,
      lastTurnPromptTokens: 61_692,
      lastTurnCompletionTokens: 5_794,
      lastTurnTotalTokens: 67_486,
    });
    const core = budget.breakdown
      .filter((row) => row.key !== 'composer' && row.key !== 'attachments' && row.key !== 'inFlight')
      .reduce((sum, row) => sum + row.tokens, 0);
    assert.equal(core, 67_486);
    assert.equal(budget.used, 67_496);
    assert.equal(budget.isEstimate, false);
    assert.equal(budget.lastTurnTotalTokens, 67_486);
  });
});


/**
 * The ring must trip on the same line the runner trims on. Anything that reads
 * the model window raw promises room the next request will never get, because
 * `applyContextBudget` starts dropping turns below it.
 */
describe('context trim ceiling', () => {
  const estimate = computeOutboundPromptEstimateFromParts({
    systemText: 'System prompt body',
    history: [],
    tools: [],
    userRulesText: '',
  });

  function budgetAt(used: number, limit: number | null) {
    return assembleContextBudget({
      modelId: 'test/model',
      modelDisplayName: 'Test Model',
      limit,
      estimate,
      composerTokens: 0,
      attachmentTokens: 0,
      lastTurnPromptTokens: used,
      lastTurnCompletionTokens: 0,
      lastTurnTotalTokens: used,
    });
  }

  test('matches the enforcement module rather than restating its margin', () => {
    for (const limit of [8_192, 32_768, 128_000, 200_000]) {
      const enforcement = resolveContextBudget({
        agentConfig: { enforcementPolicy: DEFAULT_CONTEXT_ENFORCEMENT_POLICY },
        modelLimit: limit,
        reservedTokens: 0,
      });
      assert.equal(resolveCompressAtTokens(limit), enforcement.effectiveLimit);
      assert.equal(budgetAt(1_000, limit).compressAtTokens, enforcement.effectiveLimit);
    }
  });

  test('sits below the window, so the ring warns before 100%', () => {
    const budget = budgetAt(1_000, 100_000);
    assert.ok(budget.compressAtTokens != null);
    assert.ok(budget.compressAtTokens! < 100_000);
    assert.equal(budget.willCompress, false);
  });

  test('willCompress flips exactly at the ceiling', () => {
    const limit = 100_000;
    const ceiling = resolveCompressAtTokens(limit)!;
    assert.equal(budgetAt(ceiling - 1, limit).willCompress, false);
    assert.equal(budgetAt(ceiling, limit).willCompress, true);
    // Still below the raw window: this is the gap that used to confuse.
    assert.ok(budgetAt(ceiling, limit).percent! < 100);
  });

  test('compact draws the line at its high-water share of the ceiling', () => {
    const limit = 100_000;
    const ceiling = resolveCompressAtTokens(limit)!;
    assert.equal(resolveCompressAtTokens(limit, 0.8), Math.floor(ceiling * 0.8));
    const budget = assembleContextBudget({
      modelId: 'test/model',
      modelDisplayName: 'Test Model',
      limit,
      estimate: { ...estimate, trimAtShare: 0.8 },
      composerTokens: 0,
      attachmentTokens: 0,
      lastTurnPromptTokens: Math.floor(ceiling * 0.8),
      lastTurnCompletionTokens: 0,
      lastTurnTotalTokens: Math.floor(ceiling * 0.8),
    });
    assert.equal(budget.compressAtTokens, Math.floor(ceiling * 0.8));
    assert.equal(budget.willCompress, true);
  });

  test('an existing checkpoint alone is not a pending compaction', () => {
    const budget = assembleContextBudget({
      modelId: 'test/model',
      modelDisplayName: 'Test Model',
      limit: 100_000,
      estimate: { ...estimate, historyCompacted: true, historyCompressed: false, compressedContextEstimate: 900 },
      composerTokens: 0,
      attachmentTokens: 0,
    });
    assert.equal(budget.willCompress, false);
    const rows = budget.breakdown.map((row) => row.label);
    assert.ok(rows.includes('History (after compaction)'));
    assert.ok(rows.includes('Compaction summary'));
  });

  test('an outbound estimate that already trims counts as compressing', () => {
    const budget = assembleContextBudget({
      modelId: 'test/model',
      modelDisplayName: 'Test Model',
      limit: 100_000,
      estimate: { ...estimate, historyCompressed: true },
      composerTokens: 0,
      attachmentTokens: 0,
      lastTurnPromptTokens: 1_000,
      lastTurnCompletionTokens: 0,
      lastTurnTotalTokens: 1_000,
    });
    assert.equal(budget.willCompress, true);
  });

  test('overflow calibration does not shrink the ceiling a second time', () => {
    // The runner divides its ceiling by the observed bias because it measures
    // characters. `used` here is provider tokens, which is what the bias exists
    // to recover — discounting it again would double-count the same correction.
    const limit = 100_000;
    const before = resolveCompressAtTokens(limit);
    try {
      recordContextEstimateBias('test/model', 104_264, 52_000, 0);
      assert.equal(resolveCompressAtTokens(limit), before);
      assert.equal(budgetAt(1_000, limit).compressAtTokens, before);
    } finally {
      resetContextEstimateCalibrationForTests();
    }
  });

  test('an unknown window has no ceiling and never claims compression', () => {
    assert.equal(resolveCompressAtTokens(null), null);
    assert.equal(resolveCompressAtTokens(0), null);
    const budget = budgetAt(500_000, null);
    assert.equal(budget.compressAtTokens, null);
    assert.equal(budget.willCompress, false);
  });
});
