/**
 * Global + per-agent context policy resolution.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  loadSubAgentConfig,
  mergeSubAgentConfig,
  resetSubAgentConfigCache,
  setRuntimeSubAgentOverrides,
} from '../../src/agents/sub-agent-config.ts';
import {
  initBuiltinWorkAgentRegistry,
  resetWorkAgentRegistry,
  setUserWorkAgentOverrides,
} from '../../src/agents/work-agent-registry.ts';
import {
  resolveContextEnforcementPolicy,
  resolveSubAgentTypeContextPolicy,
  resolveWorkAgentContextPolicy,
  subAgentContextPolicySelectValue,
  workAgentContextPolicySelectValue,
  isContextEnforcementPolicy,
  INHERIT_CONTEXT_POLICY,
} from '../../src/chat/resolve-context-policy.ts';
import DEFAULTS from '../../src/agents/defaults/sub-agents.json';

const BUILDER_PROMPT = `---
id: builder
label: Builder
description: Build agent
kind: work-agent
version: "1"
providerId: null
modelId: null
allowedTools: null
contextEnforcementPolicy: slide
---

# Builder
`;

describe('resolveContextEnforcementPolicy', () => {
  test('accepts compact and the retired policy values', () => {
    assert.equal(isContextEnforcementPolicy('compact'), true);
    assert.equal(isContextEnforcementPolicy('dropMiddle'), true);
  });

  test('user override beats global and shipped', () => {
    assert.equal(
      resolveContextEnforcementPolicy({
        userOverride: 'truncate',
        globalDefault: 'summarize',
        shippedDefault: 'slide',
      }),
      'truncate',
    );
  });

  test('global beats shipped when no user override', () => {
    assert.equal(
      resolveContextEnforcementPolicy({
        globalDefault: 'truncate',
        shippedDefault: 'slide',
      }),
      'truncate',
    );
  });

  test('retired values resolve as compact', () => {
    assert.equal(resolveContextEnforcementPolicy({ globalDefault: 'summarize', shippedDefault: 'slide' }), 'compact');
    assert.equal(resolveContextEnforcementPolicy({ userOverride: 'archive' }), 'compact');
    assert.equal(resolveContextEnforcementPolicy({ userOverride: 'dropMiddle', globalDefault: 'truncate' }), 'compact');
  });

  test('falls back to shipped then default', () => {
    assert.equal(
      resolveContextEnforcementPolicy({ shippedDefault: 'slide' }),
      'slide',
    );
    assert.equal(resolveContextEnforcementPolicy({}), 'compact');
  });
});

describe('work agent context policy', () => {
  beforeEach(() => {
    resetWorkAgentRegistry();
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
    initBuiltinWorkAgentRegistry({
      './src/chat/prompts/work-agents/builder/agent.full.md': BUILDER_PROMPT,
    });
  });

  test('inherits global when user has no override', () => {
    setRuntimeSubAgentOverrides({ defaultContextEnforcementPolicy: 'truncate' });
    assert.equal(resolveWorkAgentContextPolicy('builder'), 'truncate');
  });

  test('per-agent user override wins over global', () => {
    setRuntimeSubAgentOverrides({ defaultContextEnforcementPolicy: 'truncate' });
    setUserWorkAgentOverrides({
      builder: { contextEnforcementPolicy: 'archive' },
    });
    // A stored retired value still wins over global — it just runs as compact.
    assert.equal(resolveWorkAgentContextPolicy('builder'), 'compact');
  });

  test('settings select uses inherit without user override', () => {
    assert.equal(workAgentContextPolicySelectValue('builder'), INHERIT_CONTEXT_POLICY);
    setUserWorkAgentOverrides({ builder: { contextEnforcementPolicy: 'slide' } });
    assert.equal(workAgentContextPolicySelectValue('builder'), 'slide');
    setUserWorkAgentOverrides({ builder: { contextEnforcementPolicy: 'summarize' } });
    assert.equal(workAgentContextPolicySelectValue('builder'), 'compact');
  });
});

describe('sub-agent type context policy', () => {
  beforeEach(() => {
    resetSubAgentConfigCache();
    setRuntimeSubAgentOverrides(null);
  });

  test('inherits global when type has no user override', () => {
    const merged = mergeSubAgentConfig(DEFAULTS as never, {
      defaultContextEnforcementPolicy: 'truncate',
    });
    const type = merged.types.explore;
    assert.equal(
      resolveSubAgentTypeContextPolicy('explore', merged, type),
      'truncate',
    );
  });

  test('per-type user override wins over global', async () => {
    setRuntimeSubAgentOverrides({
      defaultContextEnforcementPolicy: 'truncate',
      types: { explore: { contextEnforcementPolicy: 'summarize' } },
    });
    const merged = await loadSubAgentConfig();
    const type = merged.types.explore;
    assert.equal(
      resolveSubAgentTypeContextPolicy('explore', merged, type),
      'compact',
    );
  });

  test('settings select uses inherit without user override', () => {
    assert.equal(subAgentContextPolicySelectValue('explore'), INHERIT_CONTEXT_POLICY);
    setRuntimeSubAgentOverrides({
      types: { explore: { contextEnforcementPolicy: 'slide' } },
    });
    assert.equal(subAgentContextPolicySelectValue('explore'), 'slide');
  });
});
