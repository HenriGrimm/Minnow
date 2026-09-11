/**
 * The Super Plan summary a chat row keeps survives session normalization, and
 * a summary from the retired v2 projection becomes a legacy row instead of
 * being dropped.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';
import { superPlanSummary } from '../helpers/super-plan-fixture.ts';

function row(extra: Record<string, unknown>): Record<string, unknown> {
  return { id: 'chat-1', name: 'Plan', modeId: 'super-plan', history: [], updatedAt: 1, ...extra };
}

describe('super plan chat summary normalization', () => {
  test('a current summary round-trips unchanged', () => {
    const summary = superPlanSummary('accept', { runId: 'run-1' });
    const out = normalizeChatRow(row({ superPlanRunId: 'run-1', superPlanView: summary })) as Record<string, any>;
    assert.equal(out.superPlanRunId, 'run-1');
    assert.deepEqual(out.superPlanView, summary);
  });

  test('unknown fields are dropped and bad values coerced', () => {
    const out = normalizeChatRow(
      row({
        superPlanRunId: 'run-2',
        superPlanView: { ...superPlanSummary('drafting', { runId: 'run-2' }), needsInput: 'bogus', seq: 'x', extra: { big: true } },
      }),
    ) as Record<string, any>;
    assert.equal(out.superPlanView.needsInput, null);
    assert.equal(out.superPlanView.seq, 0);
    assert.equal('extra' in out.superPlanView, false);
  });

  test('a v2 view becomes a legacy summary the background poll can replace', () => {
    const out = normalizeChatRow(
      row({
        superPlanView: {
          runId: 'run-old',
          slug: 'oauth',
          prompt: 'Add OAuth login',
          activeStage: 'draft1',
          stages: { grill: { status: 'done' } },
          state: 'running',
          finished: false,
          planPath: 'documentation/plans/oauth.md',
          atMs: 42,
        },
      }),
    ) as Record<string, any>;
    assert.equal(out.superPlanView.status, 'legacy');
    assert.equal(out.superPlanView.finished, false, 'still polled, so the server says what it really is');
    assert.equal(out.superPlanView.planPath, 'documentation/plans/oauth.md');
    assert.equal(out.superPlanRunId, 'run-old', 'the run id comes back from the summary');
  });

  test('a row without a summary keeps its old pipeline blob untouched', () => {
    const legacy = { slug: 'x', prompt: 'p', activeStage: 'grill', stages: {} };
    const out = normalizeChatRow(row({ superPlan: legacy })) as Record<string, any>;
    assert.deepEqual(out.superPlan, legacy);
    assert.equal(out.superPlanView, undefined);
  });
});
