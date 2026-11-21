/**
 * Multi-model benchmark campaign orchestration.
 */

import { resolveProvider } from '../providers/store.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import { aggregateFromRun, computeCampaignAggregates } from './aggregates.ts';
import { isAbortError, benchmarkAbortError } from './abort.ts';
import type {
  BenchmarkCampaign,
  BenchmarkCellResult,
  BenchmarkCampaignKind,
  BenchmarkSkippedTarget,
  BenchmarkTarget,
  ModelAggregate,
  RunCampaignOptions,
  SelectedSuite,
} from './campaign-types.ts';
import {
  ensureBenchmarkTargetLoaded,
  isLocalBenchmarkTarget,
} from './model-lifecycle.ts';
import { runMatrix } from './matrix-scheduler.ts';
import { buildTargetKey, targetKeyFromTarget, targetLabel } from './model-key.ts';
import { runBenchmark } from './runner.ts';
import type { SuiteId } from './types.ts';
import { saveCampaign } from './campaign-persistence.ts';

// ── Suites ───────────────────────────────────────────────────────────────────

const QUICK_SUITES: SuiteId[] = ['capability', 'speed'];
const FULL_SUITES: SuiteId[] = [
  'capability',
  'speed',
  'tools',
  'skills',
  'coding',
];

function newCampaignId(): string {
  return `campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function suitesForPreset(
  preset: RunCampaignOptions['preset'],
  override?: SuiteId[],
): SuiteId[] {
  if (override !== undefined) return override;
  return preset === 'full' ? FULL_SUITES : QUICK_SUITES;
}

function campaignKindFromOptions(
  options: RunCampaignOptions,
): BenchmarkCampaignKind | undefined {
  const integration =
    options.integrationSuites ?? suitesForPreset(options.preset ?? 'quick');
  if (
    options.capabilityMatrix ||
    (integration.length === 1 && integration[0] === 'capability-matrix')
  ) {
    return 'capability-matrix';
  }
  return undefined;
}

function buildSelectedSuites(options: RunCampaignOptions): SelectedSuite[] {
  const suites: SelectedSuite[] = [];
  const integration = options.integrationSuites ?? suitesForPreset(options.preset ?? 'quick');
  for (const id of integration) {
    suites.push({ family: 'integration', id });
  }
  return suites;
}

interface TargetWorkResult {
  target: BenchmarkTarget;
  runs: import('./types.ts').BenchmarkRun[];
  cells: BenchmarkCellResult[];
  skipped?: boolean;
  skipReason?: string;
}

function resolveCapabilityMatrixOptions(
  options: RunCampaignOptions,
  target: BenchmarkTarget,
): RunCampaignOptions['capabilityMatrix'] {
  const base = options.capabilityMatrix;
  const extra = options.resolveCapabilityMatrixForTarget?.(target);
  if (!base && !extra) return undefined;
  return { ...base, ...extra };
}

// ── Per target ───────────────────────────────────────────────────────────────

async function runIntegrationForTarget(
  target: BenchmarkTarget,
  suiteIds: SuiteId[],
  preset: RunCampaignOptions['preset'],
  signal: AbortSignal,
  onProgress: RunCampaignOptions['onProgress'],
  capabilityMatrix: RunCampaignOptions['capabilityMatrix'],
  targetKey: string,
): Promise<TargetWorkResult> {
  const provider = await resolveProvider(target.providerId);
  const run = await runBenchmark({
    suites: suiteIds,
    preset: preset ?? 'custom',
    signal,
    saveToHistory: true,
    capabilityMatrix,
    binding: {
      providerId: provider.id,
      modelId: target.modelId,
      provider,
    },
    onProgress: (event) => {
      onProgress?.({ type: 'integration-progress', targetKey, event });
      if (event.type === 'test-done' && event.result.tokPerSec) {
        onProgress?.({
          type: 'metric-sample',
          targetKey,
          tokPerSec: event.result.tokPerSec,
          ttftMs: event.result.ttftMs,
        });
      }
    },
  });
  return { target, runs: [{ ...run, targetKey }], cells: [] };
}

/**
 * Run one target's suites. `target` carries the binding to call (rewritten to the
 * upstream serve for My Models rows); `rosterTarget` stays the roster row every
 * progress event, cell, and per-target option lookup is keyed by.
 */
async function runTargetSuites(
  target: BenchmarkTarget,
  options: RunCampaignOptions,
  workerSignal: AbortSignal,
  rosterTarget: BenchmarkTarget,
): Promise<TargetWorkResult> {
  const integrationSuites = options.integrationSuites ?? suitesForPreset(options.preset ?? 'quick');
  const onProgress = options.onProgress;
  const targetKey = targetKeyFromTarget(rosterTarget);
  const parts: TargetWorkResult[] = [];

  if (integrationSuites.length) {
    parts.push(
      await runIntegrationForTarget(
        target,
        integrationSuites,
        options.preset,
        workerSignal,
        onProgress,
        resolveCapabilityMatrixOptions(options, rosterTarget),
        targetKey,
      ),
    );
  }

  const runs = parts.flatMap((p) => p.runs);
  const cells = parts.flatMap((p) => p.cells);
  return { target, runs, cells };
}

async function runTargetWithOptionalLifecycle(
  target: BenchmarkTarget,
  options: RunCampaignOptions,
  workerSignal: AbortSignal,
): Promise<TargetWorkResult> {
  if (!options.manageModelLifecycle) {
    return runTargetSuites(target, options, workerSignal, target);
  }

  const targetKey = targetKeyFromTarget(target);
  const label = targetLabel(target);
  options.onProgress?.({ type: 'target-load-start', targetKey, label });

  const loadOutcome = await ensureBenchmarkTargetLoaded(target, workerSignal);
  if (!loadOutcome.loaded) {
    const skipReason = loadOutcome.skipReason?.trim() || 'Failed to load model';
    options.onProgress?.({
      type: 'target-load-skipped',
      targetKey,
      label,
      skipReason,
    });
    return {
      target,
      runs: [],
      cells: [],
      skipped: true,
      skipReason,
    };
  }

  options.onProgress?.({ type: 'target-load-done', targetKey });

  const effectiveTarget: BenchmarkTarget = {
    ...target,
    providerId: loadOutcome.effective.providerId,
    modelId: loadOutcome.effective.modelId,
  };

  try {
    const work = await runTargetSuites(effectiveTarget, options, workerSignal, target);
    return { ...work, target };
  } finally {
    if (loadOutcome.unload) {
      try {
        await loadOutcome.unload();
        options.onProgress?.({ type: 'target-unload', targetKey });
      } catch {}
    }
  }
}

// ── Campaign ─────────────────────────────────────────────────────────────────

/** Run a multi-model benchmark campaign. */
export async function runBenchmarkCampaign(
  options: RunCampaignOptions,
): Promise<BenchmarkCampaign> {
  const targets = options.targets;
  if (!targets.length) {
    throw new Error('Select at least one model for the benchmark campaign.');
  }

  const signal = options.signal ?? new AbortController().signal;
  const onProgress = options.onProgress;
  const campaignId = options.campaignId?.trim() || newCampaignId();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const integrationSuites = options.integrationSuites ?? suitesForPreset(options.preset ?? 'quick');
  if (!integrationSuites.length) {
    throw new Error('Select at least one capability suite to run.');
  }
  const selectedSuites = buildSelectedSuites(options);
  const campaignKind = campaignKindFromOptions(options);

  const concurrency = Math.max(
    1,
    Math.min(8, options.maxConcurrency ?? 2),
  );
  const localConcurrency = Math.max(1, options.localConcurrency ?? 1);
  const manageModelLifecycle = options.manageModelLifecycle === true;

  onProgress?.({
    type: 'campaign-start',
    campaignId,
    targetCount: targets.length,
  });
  onProgress?.({ type: 'phase', phase: 'planning', label: 'Planning campaign…' });
  onProgress?.({ type: 'phase', phase: 'warming', label: 'Warming models…' });
  onProgress?.({ type: 'phase', phase: 'running', label: 'Running suites…' });

  const allRuns: import('./types.ts').BenchmarkRun[] = [];
  const allCells: BenchmarkCellResult[] = [];
  const skippedTargets: BenchmarkSkippedTarget[] = [];

  const workItems = targets.map((target) => ({
    id: targetKeyFromTarget(target),
    payload: target,
  }));

  const handleItemDone = (item: { id: string; payload: BenchmarkTarget }, result: TargetWorkResult) => {
    if (result.skipped) {
      skippedTargets.push({
        targetKey: item.id,
        providerId: result.target.providerId,
        modelId: result.target.modelId,
        label: targetLabel(result.target),
        skipReason: result.skipReason?.trim() || 'Failed to load model',
      });
      return;
    }
    allRuns.push(...result.runs);
    allCells.push(...result.cells);
    const agg = aggregateFromTargetWorkResult(result);
    if (!agg) return;
    onProgress?.({
      type: 'target-done',
      targetKey: item.id,
      aggregate: agg,
    });
  };

  const matrixWorker = async ({
    item,
    signal: workerSignal,
  }: {
    item: { id: string; payload: BenchmarkTarget };
    signal: AbortSignal;
  }): Promise<TargetWorkResult> => {
    onProgress?.({
      type: 'target-start',
      targetKey: item.id,
      label: targetLabel(item.payload),
    });
    return runTargetWithOptionalLifecycle(item.payload, options, workerSignal);
  };

  try {
    if (manageModelLifecycle) {
      const localItems = workItems.filter((item) => isLocalBenchmarkTarget(item.payload));
      const remoteItems = workItems.filter((item) => !isLocalBenchmarkTarget(item.payload));

      if (localItems.length) {
        await runMatrix<BenchmarkTarget, TargetWorkResult>({
          items: localItems,
          concurrency: localConcurrency,
          signal,
          worker: matrixWorker,
          onItemDone: handleItemDone,
        });
      }

      if (remoteItems.length) {
        await runMatrix<BenchmarkTarget, TargetWorkResult>({
          items: remoteItems,
          concurrency,
          signal,
          worker: matrixWorker,
          onItemDone: handleItemDone,
        });
      }
    } else {
      await runMatrix<BenchmarkTarget, TargetWorkResult>({
        items: workItems,
        concurrency,
        signal,
        worker: matrixWorker,
        onItemDone: handleItemDone,
      });
    }

    if (signal.aborted) {
      throw benchmarkAbortError(signal);
    }

    onProgress?.({ type: 'phase', phase: 'aggregating', label: 'Aggregating results…' });

    const scoredTargets = targets.filter(
      (t) => !skippedTargets.some((s) => s.targetKey === targetKeyFromTarget(t)),
    );

    const campaign: BenchmarkCampaign = {
      id: campaignId,
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      preset: options.preset ?? 'custom',
      targets,
      suites: selectedSuites,
      status: 'completed',
      cells: allCells,
      runs: allRuns,
      skippedTargets: skippedTargets.length ? skippedTargets : undefined,
      aggregates: computeCampaignAggregates({
        targets: scoredTargets,
        cells: allCells,
        runs: allRuns,
      }),
      ...(campaignKind ? { kind: campaignKind } : {}),
    };

    await saveCampaign(campaign);
    onProgress?.({ type: 'phase', phase: 'done', label: 'Done' });
    onProgress?.({ type: 'campaign-done', campaign });
    return campaign;
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      const partialScored = targets.filter(
        (t) => !skippedTargets.some((s) => s.targetKey === targetKeyFromTarget(t)),
      );
      const partial: BenchmarkCampaign = {
        id: campaignId,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - t0),
        preset: options.preset ?? 'custom',
        targets,
        suites: selectedSuites,
        status: 'cancelled',
        cells: allCells,
        runs: allRuns,
        skippedTargets: skippedTargets.length ? skippedTargets : undefined,
        aggregates: computeCampaignAggregates({
          targets: partialScored,
          cells: allCells,
          runs: allRuns,
        }),
        ...(campaignKind ? { kind: campaignKind } : {}),
      };
      if (options.persistPartialOnCancel) {
        await saveCampaign(partial);
      }
      onProgress?.({ type: 'campaign-cancelled', campaign: partial });
      throw err;
    }
    throw err;
  }
}

export function buildTargetKeyForCampaign(target: BenchmarkTarget): string {
  return buildTargetKey(target.providerId, target.modelId);
}

/** Whether a per-target work result should contribute to campaign aggregates. */
export function campaignTargetProducesAggregate(result: TargetWorkResult): boolean {
  return result.skipped !== true;
}

/** Build aggregate for a completed target work result (null when skipped). */
export function aggregateFromTargetWorkResult(
  result: TargetWorkResult,
): ModelAggregate | null {
  if (!campaignTargetProducesAggregate(result)) return null;
  if (result.runs[0]) {
    return aggregateFromRun(result.target, result.runs[0], result.cells);
  }
  return (
    computeCampaignAggregates({
      targets: [result.target],
      cells: result.cells,
      runs: [],
    })[0] ?? null
  );
}
