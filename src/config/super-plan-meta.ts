/**
 * Super Plan pipeline settings (config.json meta planning.superPlan + localStorage fallback).
 */

import type { ResearchScope } from '../research/types';
import { detectConfigServer } from './storage-mode';

export type SuperPlanImpeccableMode = 'auto' | 'always' | 'never';

export type SuperPlanResearchDepth = 'auto' | 'quick' | 'standard' | 'deep';

export interface SuperPlanStageModelBinding {
  providerId: string;
  modelId: string;
}

export interface SuperPlanConfig {
  /** Number of draft/review cycles (default 2). */
  reviewRounds: number;
  /** Run the grill interview stage (default true). */
  grillEnabled: boolean;
  /** Run the Deep Research stage (default true). */
  researchEnabled: boolean;
  /** Target question count for the grill stage (~20 default). */
  grillQuestionBudget: number;
  /** Impeccable UI stage: auto when UI detected, always, or never. */
  impeccable: SuperPlanImpeccableMode;
  /** Deep Research scope for the research stage. */
  researchScope: ResearchScope;
  /** Explicit max rounds (0 = derive from researchDepth / engine auto). */
  researchMaxRounds: number;
  /** Depth preset when researchMaxRounds is 0. */
  researchDepth: SuperPlanResearchDepth;
  /** Optional model override for Deep Research stage. */
  researchModel: SuperPlanStageModelBinding;
  /** Optional model override for plan-reviewer sub-agent. */
  reviewerModel: SuperPlanStageModelBinding;
  /** Optional model override for planner draft/finalize chat turns. */
  plannerModel: SuperPlanStageModelBinding;
  /** Wall-clock budget for one plan-review pass (spawn timeout + stage wait). */
  reviewTimeoutMs: number;
}

const SUPER_PLAN_META_STORAGE_KEY = 'minnow.superPlanMeta';

export const DEFAULT_SUPER_PLAN_CONFIG: SuperPlanConfig = {
  reviewRounds: 2,
  grillEnabled: true,
  researchEnabled: true,
  grillQuestionBudget: 20,
  impeccable: 'auto',
  researchScope: 'both',
  researchMaxRounds: 0,
  researchDepth: 'auto',
  researchModel: { providerId: '', modelId: '' },
  reviewerModel: { providerId: '', modelId: '' },
  plannerModel: { providerId: '', modelId: '' },
  reviewTimeoutMs: 20 * 60 * 1000,
};

/** Coerce the review budget to [5 min, 120 min]. */
export function clampReviewTimeoutMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SUPER_PLAN_CONFIG.reviewTimeoutMs;
  return Math.min(7_200_000, Math.max(300_000, Math.round(n)));
}

let cachedSuperPlan: SuperPlanConfig | null = null;

function clampReviewRounds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SUPER_PLAN_CONFIG.reviewRounds;
  return Math.min(4, Math.max(0, Math.round(n)));
}

function clampGrillQuestionBudget(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SUPER_PLAN_CONFIG.grillQuestionBudget;
  return Math.min(40, Math.max(5, Math.round(n)));
}

function parseImpeccableMode(value: unknown): SuperPlanImpeccableMode {
  if (value === 'always' || value === 'never') return value;
  return 'auto';
}

function parseResearchScope(value: unknown): ResearchScope {
  if (value === 'web' || value === 'codebase' || value === 'both') return value;
  return DEFAULT_SUPER_PLAN_CONFIG.researchScope;
}

function parseResearchDepth(value: unknown): SuperPlanResearchDepth {
  if (value === 'quick' || value === 'standard' || value === 'deep') return value;
  return 'auto';
}

function clampResearchMaxRounds(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(8, Math.max(0, Math.round(n)));
}

function parseStageModelBinding(raw: unknown): SuperPlanStageModelBinding {
  if (!raw || typeof raw !== 'object') {
    return { providerId: '', modelId: '' };
  }
  const block = raw as Record<string, unknown>;
  return {
    providerId: typeof block.providerId === 'string' ? block.providerId : '',
    modelId: typeof block.modelId === 'string' ? block.modelId : '',
  };
}

function parseSuperPlanBlock(raw: unknown): SuperPlanConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SUPER_PLAN_CONFIG };
  }
  const block = raw as Record<string, unknown>;
  const models =
    block.models && typeof block.models === 'object'
      ? (block.models as Record<string, unknown>)
      : {};
  return {
    reviewRounds: clampReviewRounds(block.reviewRounds),
    grillEnabled: block.grillEnabled !== false,
    researchEnabled: block.researchEnabled !== false,
    grillQuestionBudget: clampGrillQuestionBudget(block.grillQuestionBudget),
    impeccable: parseImpeccableMode(block.impeccable),
    researchScope: parseResearchScope(block.researchScope),
    researchMaxRounds: clampResearchMaxRounds(block.researchMaxRounds),
    researchDepth: parseResearchDepth(block.researchDepth),
    researchModel: parseStageModelBinding(models.research ?? block.researchModel),
    reviewerModel: parseStageModelBinding(models.reviewer ?? block.reviewerModel),
    plannerModel: parseStageModelBinding(models.planner ?? block.plannerModel),
    reviewTimeoutMs: clampReviewTimeoutMs(block.reviewTimeoutMs),
  };
}

function readLocalSuperPlanConfig(): SuperPlanConfig {
  try {
    const raw = localStorage.getItem(SUPER_PLAN_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SUPER_PLAN_CONFIG };
    return parseSuperPlanBlock(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SUPER_PLAN_CONFIG };
  }
}

function writeLocalSuperPlanConfig(config: SuperPlanConfig): void {
  try {
    localStorage.setItem(SUPER_PLAN_META_STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

function extractSuperPlanFromMeta(meta: Record<string, unknown>): SuperPlanConfig {
  const planning =
    meta.planning && typeof meta.planning === 'object'
      ? (meta.planning as Record<string, unknown>)
      : {};
  return parseSuperPlanBlock(planning.superPlan);
}

async function fetchSuperPlanFromServer(): Promise<SuperPlanConfig> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocalSuperPlanConfig();
  const meta = (await res.json()) as Record<string, unknown>;
  return extractSuperPlanFromMeta(meta);
}

/** Load Super Plan config (cached until reset). */
export async function loadSuperPlanConfig(): Promise<SuperPlanConfig> {
  if (cachedSuperPlan) return cachedSuperPlan;

  const serverUp = await detectConfigServer();
  cachedSuperPlan = serverUp ? await fetchSuperPlanFromServer() : readLocalSuperPlanConfig();
  writeLocalSuperPlanConfig(cachedSuperPlan);
  return cachedSuperPlan;
}

/** Synchronous read of last loaded or local fallback. */
export function getSuperPlanConfigSync(): SuperPlanConfig {
  return cachedSuperPlan ?? readLocalSuperPlanConfig();
}

/** Clear cache (tests). */
export function resetSuperPlanConfigCache(): void {
  cachedSuperPlan = null;
}

/** Override cache for tests (no localStorage). */
export function setSuperPlanConfigForTests(config: SuperPlanConfig): void {
  cachedSuperPlan = config;
}

/** Resolve effective research maxRounds for startResearch. */
export function resolveSuperPlanResearchMaxRounds(config: SuperPlanConfig): number {
  if (config.researchMaxRounds > 0) return config.researchMaxRounds;
  switch (config.researchDepth) {
    case 'quick':
      return 2;
    case 'standard':
      return 3;
    case 'deep':
      return 5;
    default:
      return 0;
  }
}

function serializeSuperPlanForMeta(config: SuperPlanConfig): Record<string, unknown> {
  return {
    reviewRounds: config.reviewRounds,
    grillEnabled: config.grillEnabled,
    researchEnabled: config.researchEnabled,
    grillQuestionBudget: config.grillQuestionBudget,
    impeccable: config.impeccable,
    researchScope: config.researchScope,
    researchMaxRounds: config.researchMaxRounds,
    researchDepth: config.researchDepth,
    reviewTimeoutMs: config.reviewTimeoutMs,
    models: {
      research: config.researchModel,
      reviewer: config.reviewerModel,
      planner: config.plannerModel,
    },
  };
}

function mergeSuperPlanPatch(
  current: SuperPlanConfig,
  patch: Partial<SuperPlanConfig>,
): SuperPlanConfig {
  return {
    reviewRounds:
      patch.reviewRounds !== undefined
        ? clampReviewRounds(patch.reviewRounds)
        : current.reviewRounds,
    grillEnabled: patch.grillEnabled !== undefined ? patch.grillEnabled !== false : current.grillEnabled,
    researchEnabled:
      patch.researchEnabled !== undefined ? patch.researchEnabled !== false : current.researchEnabled,
    grillQuestionBudget:
      patch.grillQuestionBudget !== undefined
        ? clampGrillQuestionBudget(patch.grillQuestionBudget)
        : current.grillQuestionBudget,
    impeccable:
      patch.impeccable !== undefined
        ? parseImpeccableMode(patch.impeccable)
        : current.impeccable,
    researchScope:
      patch.researchScope !== undefined
        ? parseResearchScope(patch.researchScope)
        : current.researchScope,
    researchMaxRounds:
      patch.researchMaxRounds !== undefined
        ? clampResearchMaxRounds(patch.researchMaxRounds)
        : current.researchMaxRounds,
    researchDepth:
      patch.researchDepth !== undefined
        ? parseResearchDepth(patch.researchDepth)
        : current.researchDepth,
    researchModel:
      patch.researchModel !== undefined
        ? parseStageModelBinding(patch.researchModel)
        : current.researchModel,
    reviewerModel:
      patch.reviewerModel !== undefined
        ? parseStageModelBinding(patch.reviewerModel)
        : current.reviewerModel,
    plannerModel:
      patch.plannerModel !== undefined
        ? parseStageModelBinding(patch.plannerModel)
        : current.plannerModel,
    reviewTimeoutMs:
      patch.reviewTimeoutMs !== undefined
        ? clampReviewTimeoutMs(patch.reviewTimeoutMs)
        : current.reviewTimeoutMs,
  };
}

/**
 * Persist a partial Super Plan config. Cache and localStorage update before
 * any await so chip labels can read the new values on the same turn.
 */
export async function saveSuperPlanConfig(
  patch: Partial<SuperPlanConfig>,
): Promise<SuperPlanConfig> {
  // Merge into the saved settings, never into defaults: an edit made before
  // they loaded would otherwise overwrite every other saved field.
  const base = cachedSuperPlan ?? (await loadSuperPlanConfig());
  const next = mergeSuperPlanPatch(base, patch);
  cachedSuperPlan = next;
  writeLocalSuperPlanConfig(next);

  const serverUp = await detectConfigServer();
  if (serverUp) {
    const res = await fetch('/api/config/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planning: { superPlan: serializeSuperPlanForMeta(next) },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err && typeof err === 'object' && 'error' in err
          ? String((err as { error: unknown }).error)
          : 'Failed to save Super Plan settings',
      );
    }
  }

  return next;
}
