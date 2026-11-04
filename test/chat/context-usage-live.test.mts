import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { Chat } from '../../src/types.ts';

let estimates = 0;
mock.module('../../src/chat/prompts/token-estimate.ts', { namedExports: {
  resolveOutboundPromptEstimate: async () => {
    estimates++;
    return { total: 1000, history: 700, composedSystem: 200, userRules: 0, tools: 100,
      legacyFallback: false, trimAtShare: 0.8 };
  },
} });
const { getContextBudget } = await import('../../src/chat/context-usage.ts');

function nativeChat(): Chat {
  return { id: 'native-meter', providerId: 'codex-cli', modelId: 'fixture', modeId: 'general',
    history: [], lastNativeContext: { providerId: 'codex-cli', modelId: 'fixture',
      used: 42000, limit: 200000, historyLength: 0 } } as unknown as Chat;
}

test('closed native meter updates measured usage and pending input without estimating history', async () => {
  const chat = nativeChat();
  // Latest request metadata remains cheap; older transcript bodies must stay unread.
  const history = new Array(2000);
  history[1999] = { role: 'assistant', content: '', usage: { last_request_usage: null } };
  chat.history = new Proxy(history, { get(target, key, receiver) {
    if (key !== 'length' && key !== '1999') throw new Error(`Live meter read history.${String(key)}`);
    return Reflect.get(target, key, receiver);
  } });
  const before = estimates;
  const first = await getContextBudget({ chat, includeBreakdown: false, pendingComposerText: 'x'.repeat(360),
    pendingAttachmentTokens: 50, inFlight: { pendingToolCallsJson: 'x'.repeat(36) } });
  assert.equal(first.used, 42162);
  assert.equal(first.limit, 200000);
  assert.equal(first.isEstimate, false);
  assert.equal(first.compressAtTokens, 160000);
  chat.lastNativeContext!.used = 43000;
  const next = await getContextBudget({ chat, includeBreakdown: false });
  assert.equal(next.used, 43000);
  assert.equal(estimates, before);
});

test('opening native context details estimates the section breakdown', async () => {
  const before = estimates;
  const budget = await getContextBudget({ chat: nativeChat(), includeBreakdown: true });
  assert.equal(estimates, before + 1);
  assert.equal(budget.used, 42000);
  assert.ok(budget.breakdown.find(section => section.key === 'system')!.tokens > 0);
});

test('missing, mismatched or rewound native usage retains the estimate fallback', async () => {
  const chat = nativeChat();
  const before = estimates;
  await getContextBudget({ chat, modelId: 'other-model', includeBreakdown: false });
  chat.lastNativeContext!.historyLength = 1;
  await getContextBudget({ chat, includeBreakdown: false });
  delete chat.lastNativeContext;
  await getContextBudget({ chat, includeBreakdown: false });
  assert.equal(estimates, before + 3);
});
