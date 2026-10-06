/**
 * Global sampler defaults in ~/.minnow/config.json (`sampler` block).
 * Per-agent overrides stay in work-agents.json and sub-agents.json.
 */

import {
  clampSamplerPreset,
  SAMPLER_NEUTRAL,
  type SamplerPreset,
} from '../agents/sampler-types';
import { detectConfigServer } from './storage-mode';

/** Persisted global sampler defaults (main chat baseline). */
export interface SamplerGlobalMeta extends SamplerPreset {
  maxTokens?: number;
}

export const DEFAULT_SAMPLER_GLOBAL: SamplerGlobalMeta = {
  temperature: 1.0,
  topP: 0.95,
  topK: 20,
  minP: SAMPLER_NEUTRAL.minP,
  repetitionPenalty: SAMPLER_NEUTRAL.repetitionPenalty,
  presencePenalty: SAMPLER_NEUTRAL.presencePenalty,
  maxTokens: 131072, // keep in sync with DEFAULT_AGENT_MAX_TOKENS
};

const SAMPLER_META_STORAGE_KEY = 'minnow.samplerMeta';

let cachedSampler: SamplerGlobalMeta | null = null;

function readDrawerTemperature(): number | undefined {
  if (typeof document === 'undefined') return undefined;
  const el = document.getElementById('temperature') as HTMLInputElement | null;
  if (!el) return undefined;
  const n = parseFloat(el.value);
  return Number.isFinite(n) ? n : undefined;
}

function readDrawerMaxTokens(): number | undefined {
  if (typeof document === 'undefined') return undefined;
  const el = document.getElementById('maxTokens') as HTMLInputElement | null;
  if (!el) return undefined;
  const n = parseInt(el.value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Merge persisted `sampler` with shipped defaults so Settings inputs stay populated. */
export function parseSamplerGlobalBlock(raw: unknown): SamplerGlobalMeta {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_SAMPLER_GLOBAL };
  }
  const clamped = clampSamplerPreset(raw as SamplerPreset);
  const block = raw as Record<string, unknown>;
  const maxRaw =
    typeof block.maxTokens === 'number' ? block.maxTokens : Number(block.maxTokens);
  const maxTokens =
    Number.isFinite(maxRaw) && maxRaw >= 1
      ? Math.min(131072, Math.floor(maxRaw))
      : DEFAULT_SAMPLER_GLOBAL.maxTokens;
  return {
    ...DEFAULT_SAMPLER_GLOBAL,
    ...clamped,
    maxTokens,
    temperature:
      clamped.temperature ?? DEFAULT_SAMPLER_GLOBAL.temperature,
  };
}

function readLocalSamplerMeta(): SamplerGlobalMeta {
  try {
    const raw = localStorage.getItem(SAMPLER_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SAMPLER_GLOBAL };
    return parseSamplerGlobalBlock(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SAMPLER_GLOBAL };
  }
}

function writeLocalSamplerMeta(config: SamplerGlobalMeta): void {
  localStorage.setItem(SAMPLER_META_STORAGE_KEY, JSON.stringify(config));
}

async function fetchSamplerFromServer(): Promise<SamplerGlobalMeta> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocalSamplerMeta();
  const meta = (await res.json()) as Record<string, unknown>;
  return parseSamplerGlobalBlock(meta.sampler);
}

/** Load global sampler meta (cached until reset). */
export async function loadSamplerMeta(): Promise<SamplerGlobalMeta> {
  if (cachedSampler) {
    return parseSamplerGlobalBlock(cachedSampler);
  }

  const serverUp = await detectConfigServer();
  cachedSampler = serverUp ? await fetchSamplerFromServer() : readLocalSamplerMeta();
  writeLocalSamplerMeta(cachedSampler);
  return cachedSampler;
}

/** Last loaded value or localStorage fallback before first async load. */
export function getSamplerMetaSync(): SamplerGlobalMeta {
  return parseSamplerGlobalBlock(cachedSampler ?? readLocalSamplerMeta());
}

/** Clear cache (tests). */
export function resetSamplerMetaCache(): void {
  cachedSampler = null;
}

/** Override cache for tests (no localStorage). */
export function setSamplerMetaForTests(config: SamplerGlobalMeta): void {
  cachedSampler = config;
}

/** Mirror saved temperature / max tokens into the composer drawer inputs. */
export function applySamplerMetaToDrawer(meta: SamplerGlobalMeta): void {
  const tempEl = document.getElementById('temperature') as HTMLInputElement | null;
  const maxEl = document.getElementById('maxTokens') as HTMLInputElement | null;
  if (tempEl && meta.temperature !== undefined) {
    tempEl.value = String(meta.temperature);
  }
  if (maxEl && meta.maxTokens !== undefined) {
    maxEl.value = String(meta.maxTokens);
  }
}

export interface GlobalSamplerForSend {
  maxTokens: number;
  preset: SamplerPreset;
}

/**
 * Baseline for main-chat sampler merge: persisted defaults, with drawer
 * temperature / max tokens overriding when set (quick composer tweaks).
 */
export function readGlobalSamplerForSend(overrides?: {
  temperature?: number;
  maxTokens?: number;
}): GlobalSamplerForSend {
  const meta = getSamplerMetaSync();
  const drawerTemp = readDrawerTemperature();
  const drawerMax = readDrawerMaxTokens();

  const temperature =
    overrides?.temperature ??
    drawerTemp ??
    meta.temperature ??
    DEFAULT_SAMPLER_GLOBAL.temperature ??
    0.7;
  const maxTokens =
    overrides?.maxTokens ??
    drawerMax ??
    meta.maxTokens ??
    DEFAULT_SAMPLER_GLOBAL.maxTokens ??
    131072;

  const preset = clampSamplerPreset({
    temperature,
    topP: meta.topP ?? DEFAULT_SAMPLER_GLOBAL.topP,
    topK: meta.topK ?? DEFAULT_SAMPLER_GLOBAL.topK,
    minP: meta.minP ?? DEFAULT_SAMPLER_GLOBAL.minP,
    repetitionPenalty:
      meta.repetitionPenalty ?? DEFAULT_SAMPLER_GLOBAL.repetitionPenalty,
    presencePenalty:
      meta.presencePenalty ?? DEFAULT_SAMPLER_GLOBAL.presencePenalty,
  });

  return { maxTokens, preset };
}

/** Persist partial global sampler via PUT /api/config/meta and mirror locally. */
export async function saveSamplerMeta(
  patch: Partial<SamplerGlobalMeta>,
): Promise<SamplerGlobalMeta> {
  const current = await loadSamplerMeta();
  const merged: SamplerGlobalMeta = {
    ...current,
    ...clampSamplerPreset(patch),
  };
  if (patch.maxTokens !== undefined) {
    const n = Number(patch.maxTokens);
    if (Number.isFinite(n) && n >= 1) {
      merged.maxTokens = Math.min(131072, Math.floor(n));
    }
  }
  if (patch.temperature !== undefined) {
    merged.temperature =
      clampSamplerPreset({ temperature: patch.temperature }).temperature ??
      merged.temperature;
  }

  cachedSampler = merged;
  writeLocalSamplerMeta(merged);
  applySamplerMetaToDrawer(merged);

  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sampler: merged }),
  });

  return merged;
}
