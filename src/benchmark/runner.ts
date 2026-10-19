/**
 * Benchmark runner: suite orchestration, progress events, aggregation.
 */

import { detectLocalServer } from '../tools/client';
import {
  assertNotAborted,
  benchmarkAbortError,
  isAbortError,
} from './abort.ts';
import { aggregateRunScore } from './scoring.ts';
import { resolveBenchmarkBinding } from './resolve-binding.ts';
import { saveRun } from './persistence.ts';
import { runCapabilitySuite } from './suites/capability.ts';
import { runSpeedSuite } from './suites/speed.ts';
import { runToolsSuite } from './suites/tools.ts';
import { runSkillsSuite } from './suites/skills.ts';
import { runCodingSuite } from './suites/coding.ts';
import { runCapabilityMatrixSuite } from './suites/capability-matrix.ts';
import type {
  BenchmarkPreset,
  BenchmarkProgressEvent,
  BenchmarkRun,
  BenchmarkRunContext,
  RunBenchmarkOptions,
  SuiteId,
  SuiteResult,
} from './types.ts';
import { DEFAULT_PROBE_TIMEOUT_MS } from './types.ts';

const QUICK_SUITES: SuiteId[] = ['capability', 'speed'];
const FULL_SUITES: SuiteId[] = [
  'capability',
  'speed',
  'tools',
  'skills',
  'coding',
];

function suitesForPreset(preset: BenchmarkPreset, override?: SuiteId[]): SuiteId[] {
  if (override !== undefined) return override;
  return preset === 'full' ? FULL_SUITES : QUICK_SUITES;
}

/** Suite order for a preset (used by benchmark UI before a run starts). */
export function resolveBenchmarkSuites(
  preset: BenchmarkPreset,
  override?: SuiteId[],
): SuiteId[] {
  return suitesForPreset(preset, override);
}

function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function headlineSpeedFromPriorSuites(priorSuites: SuiteResult[]): {
  headlineTtftMs: number;
  headlineTokPerSec: number;
} {
  const speed = priorSuites.find((s) => s.id === 'speed');
  if (!speed) return { headlineTtftMs: 0, headlineTokPerSec: 0 };
  const ttfts = speed.tests
    .map((t) => t.ttftMs)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  const tpss = speed.tests
    .map((t) => t.tokPerSec)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  return {
    headlineTtftMs: median(ttfts),
    headlineTokPerSec: median(tpss),
  };
}

function suiteLabel(suiteId: SuiteId): string {
  if (suiteId === 'capability') return 'Capability';
  if (suiteId === 'capability-matrix') return 'Capability matrix';
  if (suiteId === 'speed') return 'Speed';
  if (suiteId === 'tools') return 'Tools';
  if (suiteId === 'skills') return 'Skills';
  return 'Coding';
}

function notifyCancelled(
  onProgress: ((event: BenchmarkProgressEvent) => void) | undefined,
): void {
  onProgress?.({ type: 'run-cancelled' });
}

export async function runBenchmark(options: RunBenchmarkOptions = {}): Promise<BenchmarkRun> {
  const preset = options.preset ?? 'quick';
  const suites = suitesForPreset(preset, options.suites);
  const signal = options.signal ?? new AbortController().signal;
  const onProgress = options.onProgress;
  const priorSuites = options.resume?.priorSuites ?? [];
  const priorSuiteIds = new Set(priorSuites.map((s) => s.id));
  const startedAt = options.resume?.startedAt ?? new Date().toISOString();
  const runId = options.runId ?? options.resume?.runId ?? newRunId();

  if (signal.aborted) {
    notifyCancelled(onProgress);
    throw benchmarkAbortError(signal);
  }
  const binding = options.binding ?? (await resolveBenchmarkBinding());
  const localServer = await detectLocalServer();
  const ctx: BenchmarkRunContext = {
    providerId: binding.providerId,
    modelId: binding.modelId,
    localServer,
    signal,
    perTestTimeoutMs: options.perTestTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    capabilityMatrix: options.capabilityMatrix,
    onTestStart: (meta) => {
      if (signal.aborted) return;
      onProgress?.({
        type: 'test-start',
        suiteId: meta.suite,
        testId: meta.testId,
        label: meta.label,
      });
    },
    onTestDone: (result) => {
      if (signal.aborted) return;
      onProgress?.({ type: 'test-done', result });
    },
  };

  const runT0 = performance.now();
  const suiteResults: SuiteResult[] = [...priorSuites];
  const priorHeadline = headlineSpeedFromPriorSuites(priorSuites);
  let headlineTtftMs = priorHeadline.headlineTtftMs;
  let headlineTokPerSec = priorHeadline.headlineTokPerSec;

  try {
    for (const suiteId of suites) {
      assertNotAborted(signal);

      if (priorSuiteIds.has(suiteId)) {
        continue;
      }

      onProgress?.({ type: 'suite-start', suiteId, label: suiteLabel(suiteId) });

      if (suiteId === 'capability') {
        const suite = await runCapabilitySuite(ctx);
        suiteResults.push(suite);
        if (signal.aborted) break;
        continue;
      }

      if (suiteId === 'capability-matrix') {
        const suite = await runCapabilityMatrixSuite(ctx);
        suiteResults.push(suite);
        if (signal.aborted) break;
        continue;
      }

      if (suiteId === 'speed') {
        const { suite, headlineTtftMs: ttft, headlineTokPerSec: tps } = await runSpeedSuite(ctx);
        headlineTtftMs = ttft;
        headlineTokPerSec = tps;
        suiteResults.push(suite);
        if (signal.aborted) break;
        continue;
      }

      if (suiteId === 'tools') {
        const suite = await runToolsSuite(ctx);
        suiteResults.push(suite);
        if (signal.aborted) break;
        continue;
      }

      if (suiteId === 'skills') {
        const suite = await runSkillsSuite(ctx);
        suiteResults.push(suite);
        if (signal.aborted) break;
        continue;
      }

      if (suiteId === 'coding') {
        const suite = await runCodingSuite(ctx);
        suiteResults.push(suite);
        if (signal.aborted) break;
      }
    }

    if (signal.aborted) {
      throw benchmarkAbortError(signal);
    }

    const toolsSuite = suiteResults.find((s) => s.id === 'tools');
    const skillsSuite = suiteResults.find((s) => s.id === 'skills');

    const run: BenchmarkRun = {
      id: runId,
      startedAt,
      durationMs: Math.round(performance.now() - runT0),
      preset,
      provider: { id: binding.provider.id, baseUrl: binding.provider.baseUrl },
      model: { id: binding.modelId },
      totalScore: aggregateRunScore(suiteResults),
      headlineTtftMs,
      headlineTokPerSec,
      modeMatrixPassed: 0,
      toolsPassed: toolsSuite?.passed ?? 0,
      skillsPassed: skillsSuite?.passed ?? 0,
      suites: suiteResults,
    };

    if (options.saveToHistory !== false) {
      await saveRun(run);
    }
    onProgress?.({ type: 'run-done', run });
    return run;
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      notifyCancelled(onProgress);
      if (isAbortError(err)) throw err;
      throw benchmarkAbortError(signal);
    }
    throw err;
  }
}
