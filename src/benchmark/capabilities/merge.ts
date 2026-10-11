import { isLocalServeProviderId } from '../../models/engine-ids.mjs';
/**
 * Merge manual verdicts with auto results from benchmark campaigns (pure).
 */

import type { BenchmarkCampaign } from '../campaign-types.ts';
import { targetKeyFromTarget } from '../model-key.ts';
import type { BenchmarkRun, TestResult } from '../types.ts';
import { CAPABILITY_CATALOG } from './catalog.ts';
import type { ManualVerdictStore, ManualCapabilityVerdict } from './manual-verdicts.ts';
import { manualVerdictKey } from './manual-verdicts.ts';
import type { CapabilityVerdict } from './types.ts';

/** Must match {@link capabilityMatrixTestId} prefix in test-catalog. */
const CAPABILITY_TEST_ID_PREFIX = 'cap-matrix/';

export type CapabilityCellSource = 'manual' | 'auto' | 'none';

export interface AutoCapabilityVerdict {
  targetKey: string;
  capabilityId: string;
  verdict: CapabilityVerdict;
  ranAt: string;
  campaignId: string;
}

export interface MergedCapabilityCell {
  targetKey: string;
  capabilityId: string;
  verdict: CapabilityVerdict;
  source: CapabilityCellSource;
  overridesAuto?: boolean;
  autoVerdict?: CapabilityVerdict;
  manualVerdict?: CapabilityVerdict;
  autoRanAt?: string;
}

export function parseCapabilityIdFromTestId(testId: string): string | null {
  if (!testId.startsWith(CAPABILITY_TEST_ID_PREFIX)) return null;
  const id = testId.slice(CAPABILITY_TEST_ID_PREFIX.length).trim();
  return id || null;
}

/** Parse `${targetKey}::${capabilityId}` keys stored on active matrix runs. */
export function parseCapabilityProbeKey(
  probeKey: string,
): { targetKey: string; capabilityId: string } | null {
  for (const cap of CAPABILITY_CATALOG) {
    const suffix = `::${cap.id}`;
    if (!probeKey.endsWith(suffix)) continue;
    const targetKey = probeKey.slice(0, -suffix.length);
    if (!targetKey) return null;
    return { targetKey, capabilityId: cap.id };
  }
  return null;
}

/** Map a persisted run back to the roster target key (library effective-binding aware). */
export function resolveRunTargetKey(
  campaign: BenchmarkCampaign,
  run: BenchmarkRun,
): string {
  const stamped = run.targetKey?.trim();
  if (stamped) return stamped;
  for (const target of campaign.targets) {
    if (target.modelId !== run.model.id) continue;
    if (target.providerId === run.provider.id) {
      return targetKeyFromTarget(target);
    }
    if (
      target.providerId === 'minnow-library' &&
      isLocalServeProviderId(run.provider.id)
    ) {
      return targetKeyFromTarget(target);
    }
  }
  return `${run.provider.id}::${run.model.id}`;
}

function scoredVerdictFromTest(test: TestResult): CapabilityVerdict | null {
  if (test.verdict) return test.verdict;
  if (test.skipped) return 'n-a';
  if (test.passed) return 'pass';
  return 'fail';
}

/** Extract auto verdicts from campaign runs (not from campaign.cells). */
export function extractAutoVerdictsFromCampaign(
  campaign: BenchmarkCampaign,
): AutoCapabilityVerdict[] {
  const out: AutoCapabilityVerdict[] = [];
  for (const run of campaign.runs ?? []) {
    const targetKey = resolveRunTargetKey(campaign, run);
    const ranAt = run.startedAt;
    for (const suite of run.suites) {
      if (suite.id !== 'capability-matrix') continue;
      for (const test of suite.tests) {
        const capabilityId = parseCapabilityIdFromTestId(test.testId);
        if (!capabilityId) continue;
        const verdict = scoredVerdictFromTest(test);
        if (!verdict || verdict === 'untested') continue;
        out.push({
          targetKey,
          capabilityId,
          verdict,
          ranAt,
          campaignId: campaign.id,
        });
      }
    }
  }
  return out;
}

/** Map in-flight probe results (before campaign persistence) to auto verdicts. */
export function extractAutoVerdictsFromProbeResults(
  probes: ReadonlyArray<{
    targetKey: string;
    result: TestResult;
    campaignId?: string;
    ranAt?: string;
  }>,
): AutoCapabilityVerdict[] {
  const out: AutoCapabilityVerdict[] = [];
  for (const probe of probes) {
    const { targetKey, result, campaignId = 'in-flight', ranAt } = probe;
    if (result.suite !== 'capability-matrix') continue;
    const capabilityId = parseCapabilityIdFromTestId(result.testId);
    if (!capabilityId) continue;
    const verdict = scoredVerdictFromTest(result);
    if (!verdict || verdict === 'untested') continue;
    out.push({
      targetKey,
      capabilityId,
      verdict,
      ranAt: ranAt ?? new Date().toISOString(),
      campaignId,
    });
  }
  return out;
}

function pickLatestAuto(
  autos: AutoCapabilityVerdict[],
): AutoCapabilityVerdict | undefined {
  if (!autos.length) return undefined;
  return [...autos].sort((a, b) => String(b.ranAt).localeCompare(String(a.ranAt)))[0];
}

function manualFromStore(
  store: ManualVerdictStore,
  targetKey: string,
  capabilityId: string,
): ManualCapabilityVerdict | undefined {
  return store[manualVerdictKey(targetKey, capabilityId)];
}

/** Merge one cell: manual wins; else latest auto by ranAt; else untested. */
export function mergeCapabilityCell(input: {
  targetKey: string;
  capabilityId: string;
  manual?: ManualCapabilityVerdict | null;
  autos?: AutoCapabilityVerdict[];
}): MergedCapabilityCell {
  const { targetKey, capabilityId } = input;
  const manual = input.manual ?? null;
  const latestAuto = pickLatestAuto(input.autos ?? []);

  if (manual?.verdict && manual.verdict !== 'untested') {
    const cell: MergedCapabilityCell = {
      targetKey,
      capabilityId,
      verdict: manual.verdict,
      source: 'manual',
      manualVerdict: manual.verdict,
    };
    if (latestAuto) {
      cell.autoVerdict = latestAuto.verdict;
      cell.autoRanAt = latestAuto.ranAt;
      if (latestAuto.verdict !== manual.verdict) {
        cell.overridesAuto = true;
      }
    }
    return cell;
  }

  if (latestAuto) {
    return {
      targetKey,
      capabilityId,
      verdict: latestAuto.verdict,
      source: 'auto',
      autoVerdict: latestAuto.verdict,
      autoRanAt: latestAuto.ranAt,
    };
  }

  return {
    targetKey,
    capabilityId,
    verdict: 'untested',
    source: 'none',
  };
}

/** Build merged grid cells for target keys × capability ids. */
export function mergeCapabilityMatrix(input: {
  targetKeys: string[];
  capabilityIds: string[];
  manualStore: ManualVerdictStore;
  campaigns: BenchmarkCampaign[];
  /** Probes finished during an active run (not yet in campaign history). */
  extraAutos?: AutoCapabilityVerdict[];
}): MergedCapabilityCell[] {
  const autoByCell = new Map<string, AutoCapabilityVerdict[]>();
  for (const campaign of input.campaigns) {
    for (const auto of extractAutoVerdictsFromCampaign(campaign)) {
      const key = manualVerdictKey(auto.targetKey, auto.capabilityId);
      const list = autoByCell.get(key) ?? [];
      list.push(auto);
      autoByCell.set(key, list);
    }
  }
  for (const auto of input.extraAutos ?? []) {
    const key = manualVerdictKey(auto.targetKey, auto.capabilityId);
    const list = autoByCell.get(key) ?? [];
    list.push(auto);
    autoByCell.set(key, list);
  }

  const cells: MergedCapabilityCell[] = [];
  for (const targetKey of input.targetKeys) {
    for (const capabilityId of input.capabilityIds) {
      const key = manualVerdictKey(targetKey, capabilityId);
      cells.push(
        mergeCapabilityCell({
          targetKey,
          capabilityId,
          manual: manualFromStore(input.manualStore, targetKey, capabilityId),
          autos: autoByCell.get(key),
        }),
      );
    }
  }
  return cells;
}
