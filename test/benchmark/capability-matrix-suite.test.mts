/**
 * Capability matrix suite integration (mocked provider + LLM driver).
 */

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import type { OneShotResult } from '../../src/benchmark/llm-driver.ts';
import type { CapabilityRoundTelemetry } from '../../src/benchmark/capabilities/types.ts';
import type { ToolCall } from '../../src/types.ts';
import { CAPABILITY_CATALOG } from '../../src/benchmark/capabilities/catalog.ts';
import { probeWaveForCapabilityId } from '../../src/benchmark/capabilities/probe-wave-ids.ts';

const GET_DATETIME_CALL: ToolCall = {
  id: 'call-dt',
  type: 'function',
  function: { name: 'get_datetime', arguments: '{}' },
};

function baseOneShot(overrides: Partial<OneShotResult> = {}): OneShotResult {
  return {
    text: 'Benchmark answer without preamble.',
    contentText: 'Benchmark answer without preamble.',
    reasoningText: '',
    toolCalls: [],
    finishReason: 'stop',
    timing: {
      ttftMs: 10,
      totalMs: 30,
      tokPerSec: 80,
      usage: {},
      stats: {},
      streamChunkCount: 4,
    },
    messages: [],
    ...overrides,
  };
}

mock.module('../../src/benchmark/llm-driver.ts', {
  namedExports: {
    runOneShot: async () => baseOneShot(),
    runToolLoop: async (input: {
      onRound?: (round: CapabilityRoundTelemetry) => void;
    }) => {
      const round: CapabilityRoundTelemetry = {
        round: 0,
        toolCalls: [{ function: GET_DATETIME_CALL.function }],
      };
      input.onRound?.(round);
      return baseOneShot({ toolCalls: [GET_DATETIME_CALL] });
    },
    preserveLastToolCalls: (prev: ToolCall[], next: ToolCall[]) =>
      next.length > 0 ? next : prev,
  },
});

const { runCapabilityMatrixSuite } = await import('../../src/benchmark/suites/capability-matrix.ts');
const { listExpectedTestsForSuites } = await import('../../src/benchmark/test-catalog.ts');

describe('capability-matrix suite', () => {
  test('emits 52 rows; phase 2b autos run; manual and gated autos are n-a', async () => {
    const expected = listExpectedTestsForSuites(['capability-matrix']);
    assert.equal(expected.length, 52);

    const suite = await runCapabilityMatrixSuite({
      providerId: 'fake-provider',
      modelId: 'fake-model',
      localServer: false,
      signal: new AbortController().signal,
    });

    assert.equal(suite.id, 'capability-matrix');
    assert.equal(suite.tests.length, 52);

    assert.deepEqual(
      suite.tests.map((t) => t.testId),
      expected.map((e) => e.testId),
    );

    // Derive expectations from the specs instead of restating wave membership: with no
    // local server every `requires` is unmet, so a row runs iff its probe declares none.
    const byId = new Map(CAPABILITY_CATALOG.map((c) => [c.id, c]));
    let manualSkipped = 0;
    let ran = 0;
    let gatedSkipped = 0;

    for (const row of suite.tests) {
      const capId = row.testId.replace('cap-matrix/', '');
      const cap = byId.get(capId);
      assert.ok(cap, capId);

      if (cap.scoreMode === 'manual') {
        assert.equal(row.skipped, true, capId);
        assert.equal(row.verdict, 'n-a', capId);
        manualSkipped += 1;
        continue;
      }

      assert.ok(probeWaveForCapabilityId(capId), `${capId}: auto row with no probe wave`);
      if (cap.probe?.requires?.length) {
        assert.equal(row.skipped, true, capId);
        assert.equal(row.verdict, 'n-a', capId);
        gatedSkipped += 1;
        continue;
      }

      assert.equal(row.skipped, false, capId);
      assert.ok(
        row.verdict === 'pass' || row.verdict === 'partial' || row.verdict === 'fail',
        capId,
      );
      ran += 1;
    }

    assert.equal(manualSkipped, 4);
    assert.equal(manualSkipped + ran + gatedSkipped, suite.tests.length);
    assert.ok(ran > 0);
    assert.ok(suite.score > 0);
  });
});
