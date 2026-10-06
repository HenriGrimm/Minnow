import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveThinkingMode } from '../../src/agents/resolve-thinking.ts';
import { setThinkingMetaForTests, resetThinkingMetaCache } from '../../src/config/thinking-meta.ts';
import type { SubAgentTypeConfig } from '../../src/agents/types.ts';

describe('resolveThinkingMode', () => {
  test('global default on when layers inherit', () => {
    resetThinkingMetaCache();
    setThinkingMetaForTests({ defaultMode: 'on', thinkingBudgetTokens: null });
    const r = resolveThinkingMode({
      kind: 'work-agent',
      agentKey: 'builder',
      chatThinkingMode: 'inherit',
    });
    assert.equal(r.mode, 'on');
  });

  test('work-agent on overrides global off', () => {
    resetThinkingMetaCache();
    setThinkingMetaForTests({ defaultMode: 'off', thinkingBudgetTokens: null });
    const r = resolveThinkingMode({
      kind: 'work-agent',
      agentKey: 'planner',
      chatThinkingMode: 'inherit',
    });
    assert.equal(r.mode, 'on');
  });

  test('chat on overrides sub-agent type off', () => {
    resetThinkingMetaCache();
    setThinkingMetaForTests({ defaultMode: 'off', thinkingBudgetTokens: null });
    const type: SubAgentTypeConfig = {
      enabled: true,
      providerId: 'p',
      modelId: 'm',
      maxConcurrent: 1,
      workAgentId: null,
      allowedTools: null,
      deniedTools: [],
      systemPromptPath: null,
      thinkingMode: 'off',
    };
    const r = resolveThinkingMode({
      kind: 'sub-agent',
      agentKey: 'explore',
      chatThinkingMode: 'on',
      subAgentType: type,
    });
    assert.equal(r.mode, 'on');
  });

  test('chat inherit uses sub-agent type on', () => {
    resetThinkingMetaCache();
    setThinkingMetaForTests({ defaultMode: 'off', thinkingBudgetTokens: null });
    const type: SubAgentTypeConfig = {
      enabled: true,
      providerId: 'p',
      modelId: 'm',
      maxConcurrent: 1,
      workAgentId: null,
      allowedTools: null,
      deniedTools: [],
      systemPromptPath: null,
      thinkingMode: 'on',
    };
    const r = resolveThinkingMode({
      kind: 'sub-agent',
      agentKey: 'generalPurpose',
      chatThinkingMode: 'inherit',
      subAgentType: type,
    });
    assert.equal(r.mode, 'on');
  });
});
