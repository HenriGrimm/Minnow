/**
 * Campaign progress identity — a served My Models row keeps its roster target key.
 *
 * The lifecycle path rewrites `minnow-library` rows to the upstream serve binding
 * before running completions. Progress events, cells, and the persisted run must
 * still key off the roster row, or the capability-matrix grid has no column to
 * paint while the sweep runs.
 *
 * Uses mock.module so no provider, serve, or campaign file is touched. Run with
 * --experimental-test-module-mocks (default for .test.mts via test-config).
 *
 * Important: do not statically import campaign-runner — ES import hoisting would
 * load it before mock.module runs and the mocks would never apply.
 * Incomplete namedExports replace the whole module — stub every export importers need.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import type {
  BenchmarkTarget,
  CampaignProgressEvent,
} from '../../src/benchmark/campaign-types.ts';
import type { BenchmarkRun } from '../../src/benchmark/types.ts';

const ROSTER_TARGET: BenchmarkTarget = {
  providerId: 'minnow-library',
  modelId: 'mlx:org/repo',
};
const ROSTER_KEY = 'minnow-library::mlx:org/repo';
/** What the serve rewrites the binding to once the model is loaded. */
const SERVED_BINDING = {
  providerId: 'mlx-lm-local',
  modelId: '/Users/me/.cache/models/snapshots/abc',
};

/** Binding runBenchmark was actually called with (proves completions still hit the serve). */
let observedBinding: { providerId: string; modelId: string } | null = null;



mock.module('../../src/providers/store.ts', {
  namedExports: {
    resolveProvider: async (providerId: string) => ({
      id: providerId,
      baseUrl: 'http://127.0.0.1:8087',
    }),
  },
});

mock.module('../../src/state/workspace.ts', {
  namedExports: {
    getWorkspacePath: () => '/tmp/workspace',
  },
});

mock.module('../../src/benchmark/campaign-persistence.ts', {
  namedExports: {
    saveCampaign: async () => undefined,
  },
});


mock.module('../../src/benchmark/model-lifecycle.ts', {
  namedExports: {
    isLocalBenchmarkTarget: () => true,
    ensureBenchmarkTargetLoaded: async () => ({
      loaded: true,
      kind: 'library',
      effective: SERVED_BINDING,
    }),
  },
});

mock.module('../../src/benchmark/runner.ts', {
  namedExports: {
    runBenchmark: async (options: {
      binding: { providerId: string; modelId: string; provider: { id: string; baseUrl: string } };
      onProgress?: (event: unknown) => void;
    }): Promise<BenchmarkRun> => {
      observedBinding = {
        providerId: options.binding.providerId,
        modelId: options.binding.modelId,
      };
      options.onProgress?.({
        type: 'test-start',
        suiteId: 'capability-matrix',
        testId: 'cap-matrix/core-streaming',
        label: 'Streaming',
      });
      options.onProgress?.({
        type: 'test-done',
        result: {
          testId: 'cap-matrix/core-streaming',
          suite: 'capability-matrix',
          label: 'Streaming',
          passed: true,
          skipped: false,
          durationMs: 1,
          score: 1,
          verdict: 'pass',
        },
      });
      return {
        id: 'run-1',
        startedAt: '2026-06-01T00:00:00.000Z',
        durationMs: 1,
        preset: 'custom',
        provider: { id: options.binding.provider.id, baseUrl: options.binding.provider.baseUrl },
        model: { id: options.binding.modelId },
        totalScore: 1,
        headlineTokPerSec: 10,
        headlineTtftMs: 20,
        modeMatrixPassed: 0,
        toolsPassed: 0,
        skillsPassed: 0,
        suites: [],
      };
    },
  },
});

describe('campaign progress identity for served My Models rows', () => {
  test('progress events and the saved run use the roster target key', async () => {
    const { runBenchmarkCampaign } = await import('../../src/benchmark/campaign-runner.ts');

    const events: CampaignProgressEvent[] = [];
    const resolvedForTargets: string[] = [];

    const campaign = await runBenchmarkCampaign({
      campaignId: 'campaign-test',
      targets: [ROSTER_TARGET],
      integrationSuites: ['capability-matrix'],
      preset: 'custom',
      manageModelLifecycle: true,
      resolveCapabilityMatrixForTarget: (target) => {
        resolvedForTargets.push(`${target.providerId}::${target.modelId}`);
        return {};
      },
      onProgress: (event) => events.push(event),
    });

    // Completions still run against the serve binding.
    assert.deepEqual(observedBinding, SERVED_BINDING);

    // Per-target options are looked up by the roster row, so skip-scored works.
    assert.deepEqual(resolvedForTargets, [ROSTER_KEY]);

    const keyed = events.filter(
      (event): event is Extract<CampaignProgressEvent, { targetKey: string }> =>
        'targetKey' in event,
    );
    assert.ok(keyed.length > 0);
    for (const event of keyed) {
      assert.equal(event.targetKey, ROSTER_KEY, `${event.type} used a non-roster key`);
    }
    assert.ok(keyed.some((event) => event.type === 'integration-progress'));

    assert.equal(campaign.runs[0]?.targetKey, ROSTER_KEY);
    assert.equal(campaign.aggregates[0]?.targetKey, ROSTER_KEY);
    assert.equal(campaign.aggregates[0]?.totalScore, 1);
  });
});
