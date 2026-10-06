import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  ThinkingBudgetTracker,
  buildThinkingPrefillAssistantMessage,
  THINKING_BUDGET_NUDGE_LINE,
} from '../../src/agents/thinking-budget.ts';
import { resolveThinkingBudgetTokens } from '../../src/agents/resolve-thinking.ts';
import { setThinkingMetaForTests, resetThinkingMetaCache } from '../../src/config/thinking-meta.ts';
import {
  mergeUserWorkAgentOverride,
  resetWorkAgentRegistry,
  setUserWorkAgentOverrides,
} from '../../src/agents/work-agent-registry.ts';
import type { SubAgentTypeConfig } from '../../src/agents/types.ts';
import { clampThinkingBudgetTokens } from '../../src/agents/thinking-types.ts';

describe('clampThinkingBudgetTokens', () => {
  test('clamps positive values to [10, 200_000]', () => {
    assert.equal(clampThinkingBudgetTokens(5), 10);
    assert.equal(clampThinkingBudgetTokens(100), 100);
    assert.equal(clampThinkingBudgetTokens(999_999), 200_000);
    assert.equal(clampThinkingBudgetTokens(4096), 4096);
  });

  test('zero stays zero and invalid becomes null', () => {
    assert.equal(clampThinkingBudgetTokens(0), 0);
    assert.equal(clampThinkingBudgetTokens(-1), null);
    assert.equal(clampThinkingBudgetTokens('nope'), null);
  });
});

describe('resolveThinkingBudgetTokens', () => {
  beforeEach(() => {
    resetThinkingMetaCache();
    resetWorkAgentRegistry();
    setUserWorkAgentOverrides({});
  });

  test('global budget applies when layers inherit', () => {
    setThinkingMetaForTests({ defaultMode: 'on', thinkingBudgetTokens: 4096 });
    const r = resolveThinkingBudgetTokens({
      kind: 'work-agent',
      agentKey: 'builder',
    });
    assert.equal(r.budgetTokens, 4096);
  });

  test('work-agent override beats global', () => {
    setThinkingMetaForTests({ defaultMode: 'on', thinkingBudgetTokens: 4096 });
    mergeUserWorkAgentOverride('planner', { thinkingBudgetTokens: 8192 });
    const r = resolveThinkingBudgetTokens({
      kind: 'work-agent',
      agentKey: 'planner',
    });
    assert.equal(r.budgetTokens, 8192);
  });

  test('zero at work-agent tier disables inherited global budget', () => {
    setThinkingMetaForTests({ defaultMode: 'on', thinkingBudgetTokens: 8000 });
    mergeUserWorkAgentOverride('builder', { thinkingBudgetTokens: 0 });
    const r = resolveThinkingBudgetTokens({
      kind: 'work-agent',
      agentKey: 'builder',
    });
    assert.equal(r.budgetTokens, null);
  });

  test('sub-agent type override beats global', () => {
    setThinkingMetaForTests({ defaultMode: 'on', thinkingBudgetTokens: 2000 });
    const type: SubAgentTypeConfig = {
      enabled: true,
      providerId: 'p',
      modelId: 'm',
      maxConcurrent: 1,
      workAgentId: null,
      allowedTools: null,
      deniedTools: [],
      systemPromptPath: null,
      thinkingBudgetTokens: 6000,
    };
    const r = resolveThinkingBudgetTokens({
      kind: 'sub-agent',
      agentKey: 'explore',
      subAgentType: type,
    });
    assert.equal(r.budgetTokens, 6000);
  });
});

describe('ThinkingBudgetTracker', () => {
  test('feed accumulates and exceeded trips at limit', () => {
    const tracker = new ThinkingBudgetTracker(2);
    tracker.feed('a'.repeat(4));
    assert.equal(tracker.exceeded, false);
    tracker.feed('b'.repeat(4));
    assert.equal(tracker.exceeded, true);
    assert.equal(tracker.nudgeCount, 1);
  });

  test('feed replaces cumulative reasoning instead of double-counting', () => {
    const tracker = new ThinkingBudgetTracker(4);
    tracker.feed('abcd');
    assert.equal(tracker.exceeded, false);
    tracker.feed('abcdefgh');
    assert.equal(tracker.exceeded, false);
    tracker.feed('abcdefghijklmnop');
    assert.equal(tracker.exceeded, true);
  });

  test('endSession resets exceeded state', () => {
    const tracker = new ThinkingBudgetTracker(1);
    tracker.feed('abcd');
    assert.equal(tracker.exceeded, true);
    tracker.endSession();
    assert.equal(tracker.exceeded, false);
    assert.equal(tracker.sessionText, '');
  });

  test('prefill builder wraps partial thinking with nudge', () => {
    const msg = buildThinkingPrefillAssistantMessage('line one');
    assert.equal(msg.role, 'assistant');
    assert.match(String(msg.content), /<think>/);
    assert.match(String(msg.content), /line one/);
    assert.ok(String(msg.content).includes(THINKING_BUDGET_NUDGE_LINE));
  });
});
