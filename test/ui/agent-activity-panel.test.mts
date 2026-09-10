/**
 * Agent activity panel formatting helpers (no live DOM).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatAgentActivityElapsed,
  formatAgentActivityStatusLine,
  formatAgentActivityToolRounds,
  type AgentActivityRow,
} from '../../src/state/agent-activity-registry.ts';

const ROW_BASE: AgentActivityRow = {
  id: 'sub:1',
  kind: 'sub_agent',
  chatId: '11111111-1111-1111-1111-111111111111',
  chatTitle: 'Test',
  label: 'Explore',
  status: 'running',
  modelDisplay: 'test/model',
  contextPercent: null,
  contextIsEstimate: true,
  startedAtMs: 1710000000000,
  elapsedMs: 30_000,
  elapsedFrozen: false,
  toolTurns: 3,
  maxToolTurns: 12,
};

describe('agent-activity-panel helpers', () => {
  test('formatAgentActivityToolRounds for sub-agents only', () => {
    assert.equal(formatAgentActivityToolRounds(ROW_BASE), '3 rounds');
    assert.equal(
      formatAgentActivityToolRounds({ ...ROW_BASE, kind: 'main_turn' }),
      '',
    );
  });

  test('formatAgentActivityStatusLine covers queued and title', () => {
    assert.equal(
      formatAgentActivityStatusLine({ ...ROW_BASE, status: 'queued' }),
      'Queued',
    );
    assert.equal(
      formatAgentActivityStatusLine({
        ...ROW_BASE,
        kind: 'title_job',
        status: 'running',
      }),
      'Naming chat',
    );
    assert.equal(formatAgentActivityElapsed(0), '0:00');
  });
});
