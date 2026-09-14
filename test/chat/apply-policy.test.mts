/**
 * Renderer context policy apply path: every policy is sync, no completion call.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyContextPolicy,
  estimateContextPolicyTrim,
} from '../../src/chat/context/apply-policy.ts';
import { resolveContextBudget } from '../../src/chat/context-budget.ts';
import {
  compactMessages,
  COMPACTION_HEADER_PREFIX,
} from '../../server/runner/compaction/index.js';
import type { ApiMessage } from '../../src/types.ts';

function user(content: string): ApiMessage {
  return { role: 'user', content };
}

function assistant(content: string): ApiMessage {
  return { role: 'assistant', content };
}

function system(content: string): ApiMessage {
  return { role: 'system', content };
}

function conversation(turns: number): ApiMessage[] {
  const rows: ApiMessage[] = [system('sys')];
  for (let t = 0; t < turns; t += 1) {
    rows.push(user(`request ${t} `.repeat(60)));
    rows.push(assistant(`answer ${t} `.repeat(120)));
  }
  return rows;
}

describe('applyContextPolicy', () => {
  test('a 1-user-turn thread over budget truncates instead of staying untouched', async () => {
    const messages: ApiMessage[] = [system('sys'), user('z'.repeat(8000))];
    const statuses: string[] = [];
    const out = await applyContextPolicy({
      messages,
      policy: 'compact',
      modelLimit: 20,
      agentConfig: { enforcementPolicy: 'compact', minRecentTurns: 2 },
      providerId: 'openai',
      modelId: 'gpt-test',
      onStatus: (_level, message) => statuses.push(message),
    });
    assert.equal(out.applied, true);
    assert.ok(out.tokensAfter < out.tokensBefore);
    const lastUser = out.messages.find((m) => m.role === 'user');
    assert.ok(
      typeof lastUser?.content === 'string' &&
        lastUser.content.includes('[… truncated for context budget]'),
    );
    assert.deepEqual(statuses, [], 'no "Summarizing context…" spinner: nothing is summarized by a model');
  });

  for (const providerId of ['llama-cpp-local', 'mlx-lm-local', 'anthropic']) {
    test(`legacy summarize compacts deterministically on ${providerId}`, async () => {
      const out = await applyContextPolicy({
        messages: conversation(6),
        policy: 'summarize',
        modelLimit: 1600,
        agentConfig: { enforcementPolicy: 'summarize', minRecentTurns: 1 },
        providerId,
        modelId: 'model',
      });
      assert.equal(out.applied, true);
      assert.equal(out.policy, 'compact');
      assert.ok(out.tokensAfter <= Math.floor(1600 * 0.9));
      assert.ok(out.summaryText?.startsWith(COMPACTION_HEADER_PREFIX));
    });
  }
});

describe('estimateContextPolicyTrim', () => {
  test('projects through a persisted checkpoint before predicting a new one', () => {
    const rows = conversation(8);
    const resolved = resolveContextBudget({ agentConfig: { enforcementPolicy: 'compact' }, modelLimit: 3000 });
    const first = compactMessages({ messages: rows, limit: resolved.effectiveLimit!, window: 3000 });
    assert.ok(first.checkpoint);
    const ids = rows.map((_, i) => i);
    const withCheckpoint = estimateContextPolicyTrim(rows, resolved, { enforcementPolicy: 'compact' }, {
      ids,
      checkpoint: first.checkpoint,
    });
    assert.equal(withCheckpoint.wouldCompress, true);
    assert.ok(withCheckpoint.historyTokens <= resolved.effectiveLimit!);
    assert.ok(withCheckpoint.compressedEstimateTokens > 0, 'summary tokens are their own segment');
  });

  test('under the high-water mark nothing is predicted', () => {
    const rows = conversation(1);
    const resolved = resolveContextBudget({ agentConfig: { enforcementPolicy: 'compact' }, modelLimit: 100_000 });
    const out = estimateContextPolicyTrim(rows, resolved, { enforcementPolicy: 'compact' });
    assert.equal(out.wouldCompress, false);
    assert.equal(out.compressedEstimateTokens, 0);
  });
});
