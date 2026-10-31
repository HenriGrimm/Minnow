import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  adoptSubAgentRunForTests,
  buildAggregateResult,
  formatAggregateResult,
  getSubAgentRun,
  resetSubAgentOrchestrator,
} from '../../src/agents/orchestrator.ts';
import { resetSubAgentConfigCache } from '../../src/agents/sub-agent-config.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { FIXED_RUN_ID } from './test-helpers.mts';

const EXPECTED_SHAPE = `{
  "runId": "11111111-1111-1111-1111-111111111111",
  "type": "explore",
  "status": "completed",
  "summary": "FIXED_SUMMARY",
  "outcome": {
    "summary": "FIXED_SUMMARY",
    "findings": [],
    "artifacts": []
  },
  "startedAt": null,
  "endedAt": null,
  "toolTurns": 0,
  "cancelled": false,
  "terminalReason": "success"
}`;

describe('orchestrator aggregate', () => {
  beforeEach(() => {
    resetSubAgentOrchestrator();
    resetSubAgentConfigCache();
  });

  test('seeded run aggregate JSON static shape (timestamps nulled)', () => {
    const run: SubAgentRun = {
      runId: FIXED_RUN_ID,
      type: 'explore',
      task: 'static test',
      status: 'completed',
      parentChatId: null,
      parentToolCallId: null,
      parentTurnId: null,
      summary: 'FIXED_SUMMARY',
      error: null,
      startedAt: null,
      endedAt: null,
      toolTurns: 0,
      cancelled: false,
      messages: [],
      structuredOutcome: {
        summary: 'FIXED_SUMMARY',
        findings: [],
        artifacts: [],
      },
    };
    adoptSubAgentRunForTests(run);
    const live = getSubAgentRun(FIXED_RUN_ID);
    assert.ok(live);
    const result = buildAggregateResult(live);
    const forCompare = { ...result, startedAt: null, endedAt: null };
    const json = formatAggregateResult(forCompare);
    assert.equal(json, EXPECTED_SHAPE);
  });

  test('buildAggregateResult includes error when set', () => {
    const agg = buildAggregateResult({
      runId: FIXED_RUN_ID,
      type: 'explore',
      task: 't',
      status: 'failed',
      parentChatId: null,
      parentToolCallId: null,
      parentTurnId: null,
      summary: '',
      error: 'boom',
      startedAt: '2026-05-19T12:00:00.000Z',
      endedAt: '2026-05-19T12:01:00.000Z',
      toolTurns: 0,
      maxToolTurns: 12,
      cancelled: false,
      messages: [],
    });
    assert.equal(agg.error, 'boom');
    assert.equal(agg.outcome.summary, 'boom');
    assert.notEqual(agg.outcome.summary, 'Sub-agent completed with no text output.');
    assert.deepEqual(agg.outcome.findings, []);
  });

  test('a large terminal result keeps bounded valid JSON and exact task identity for durable inline acknowledgement', () => {
    const text = 'Result 🔍 '.repeat(20000);
    const json = formatAggregateResult({ runId: FIXED_RUN_ID, type: 'explore', status: 'completed',
      summary: text, outcome: { summary: text, findings: [text], artifacts: [] },
      startedAt: null, endedAt: null, toolTurns: 5, cancelled: false });
    assert.ok(Buffer.byteLength(json, 'utf8') <= 32 * 1024);
    const parsed = JSON.parse(json);
    assert.equal(parsed.runId, FIXED_RUN_ID);
    assert.equal(parsed.status, 'completed');
    assert.equal(parsed.truncated, true);
    assert.ok(parsed.summary.length > 0);
    assert.ok(parsed.outcome.summary.length > 0);
  });
});
