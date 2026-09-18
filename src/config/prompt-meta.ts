/**
 * Active prompt profile settings (config.json meta + localStorage fallback).
 */

import { detectConfigServer } from './storage-mode';
import { bumpPromptConfigEpoch } from '../chat/outbound-estimate-epochs';

export type PromptProfileName = 'full' | 'lite' | 'custom';

export type PlanGranularity = 'large' | 'medium' | 'small';

export interface PromptMetaSettings {
  activePromptProfile: PromptProfileName;
  activePromptConfigId: string | null;
  activeInfoPresetId: string;
  planGranularity: PlanGranularity;
  flaticonIconGuidanceEnabled: boolean;
}

const PROMPT_META_STORAGE_KEY = 'minnow.promptMeta';

const DEFAULT_PROMPT_META: PromptMetaSettings = {
  activePromptProfile: 'full',
  activePromptConfigId: null,
  activeInfoPresetId: 'general-assistant',
  planGranularity: 'medium',
  flaticonIconGuidanceEnabled: true,
};

let cachedMeta: PromptMetaSettings | null = null;

function parsePlanGranularity(value: unknown): PlanGranularity {
  if (value === 'large' || value === 'small') return value;
  return 'medium';
}

function readLocalPromptMeta(): PromptMetaSettings {
  try {
    const raw = localStorage.getItem(PROMPT_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROMPT_META };
    const parsed = JSON.parse(raw) as Partial<PromptMetaSettings>;
    return {
      activePromptProfile:
        parsed.activePromptProfile === 'lite' ||
        parsed.activePromptProfile === 'custom' ||
        parsed.activePromptProfile === 'full'
          ? parsed.activePromptProfile
          : 'full',
      activePromptConfigId:
        typeof parsed.activePromptConfigId === 'string'
          ? parsed.activePromptConfigId
          : null,
      activeInfoPresetId:
        typeof parsed.activeInfoPresetId === 'string'
          ? parsed.activeInfoPresetId
          : DEFAULT_PROMPT_META.activeInfoPresetId,
      planGranularity: parsePlanGranularity(parsed.planGranularity),
      flaticonIconGuidanceEnabled:
        typeof parsed.flaticonIconGuidanceEnabled === 'boolean'
          ? parsed.flaticonIconGuidanceEnabled
          : DEFAULT_PROMPT_META.flaticonIconGuidanceEnabled,
    };
  } catch {
    return { ...DEFAULT_PROMPT_META };
  }
}

function writeLocalPromptMeta(meta: PromptMetaSettings): void {
  localStorage.setItem(PROMPT_META_STORAGE_KEY, JSON.stringify(meta));
}

/** GET /api/config/meta and extract prompt-related keys. */
async function fetchPromptMetaFromServer(): Promise<PromptMetaSettings> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocalPromptMeta();
  const meta = (await res.json()) as Record<string, unknown>;
  const planning = meta.planning && typeof meta.planning === 'object'
    ? (meta.planning as Record<string, unknown>)
    : {};
  return {
    activePromptProfile:
      meta.activePromptProfile === 'lite' ||
      meta.activePromptProfile === 'custom' ||
      meta.activePromptProfile === 'full'
        ? meta.activePromptProfile
        : 'full',
    activePromptConfigId:
      typeof meta.activePromptConfigId === 'string' ? meta.activePromptConfigId : null,
    activeInfoPresetId:
      typeof meta.activeInfoPresetId === 'string'
        ? meta.activeInfoPresetId
        : DEFAULT_PROMPT_META.activeInfoPresetId,
    planGranularity: parsePlanGranularity(planning.granularity),
    flaticonIconGuidanceEnabled:
      typeof meta.flaticonIconGuidanceEnabled === 'boolean'
        ? meta.flaticonIconGuidanceEnabled
        : DEFAULT_PROMPT_META.flaticonIconGuidanceEnabled,
  };
}

/** Load prompt meta (cached until reset). */
export async function loadPromptMetaSettings(): Promise<PromptMetaSettings> {
  if (cachedMeta) return cachedMeta;

  const serverUp = await detectConfigServer();
  cachedMeta = serverUp ? await fetchPromptMetaFromServer() : readLocalPromptMeta();
  return cachedMeta;
}

/** Synchronous read of last loaded or local fallback. */
export function getPromptMetaSettingsSync(): PromptMetaSettings {
  return cachedMeta ?? readLocalPromptMeta();
}

/** Persist prompt meta (server meta merge or localStorage). */
export async function savePromptMetaSettings(
  partial: Partial<PromptMetaSettings>,
): Promise<PromptMetaSettings> {
  const current = await loadPromptMetaSettings();
  const next: PromptMetaSettings = { ...current, ...partial };
  cachedMeta = next;
  writeLocalPromptMeta(next);
  bumpPromptConfigEpoch();

  const serverUp = await detectConfigServer();
  if (serverUp) {
    const res = await fetch('/api/config/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...next,
        planning: { granularity: next.planGranularity },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        err && typeof err === 'object' && 'error' in err
          ? String((err as { error: unknown }).error)
          : 'Failed to save prompt meta',
      );
    }
  }

  return next;
}

/** Clear cache (tests / reload). */
export function resetPromptMetaCache(): void {
  cachedMeta = null;
}

/** Override cache without persisting (headless --profile, tests). */
export function setPromptMetaCacheForTests(settings: PromptMetaSettings): void {
  cachedMeta = settings;
}

export { DEFAULT_PROMPT_META };
