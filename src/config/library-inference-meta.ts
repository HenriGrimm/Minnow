/**
 * Per-library-model sampler overrides (Models inspector → config.json models.inference).
 */

import {
  clampSamplerPreset,
  mergeSamplerLayers,
  type SamplerPreset,
} from '../agents/sampler-types';
import { detectConfigServer } from './storage-mode';
import type { GlobalSamplerForSend } from './sampler-meta';

export interface LibraryInferencePrefs {
  byLibraryId: Record<string, SamplerPreset>;
  /** Chat model id / served label → library row id. */
  chatModelAliases: Record<string, string>;
}

const STORAGE_KEY = 'minnow.libraryInference';

let cached: LibraryInferencePrefs | null = null;
let pendingSave: Promise<unknown> = Promise.resolve();

function emptyPrefs(): LibraryInferencePrefs {
  return { byLibraryId: {}, chatModelAliases: {} };
}

function normalizePrefs(raw: unknown): LibraryInferencePrefs {
  if (!raw || typeof raw !== 'object') return emptyPrefs();
  const block = raw as Record<string, unknown>;
  const byLibraryId =
    block.byLibraryId && typeof block.byLibraryId === 'object'
      ? { ...(block.byLibraryId as Record<string, SamplerPreset>) }
      : {};
  const chatModelAliases =
    block.chatModelAliases && typeof block.chatModelAliases === 'object'
      ? { ...(block.chatModelAliases as Record<string, string>) }
      : {};
  return { byLibraryId, chatModelAliases };
}

function readLocal(): LibraryInferencePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPrefs();
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return emptyPrefs();
  }
}

function writeLocal(prefs: LibraryInferencePrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

async function fetchFromServer(): Promise<LibraryInferencePrefs> {
  const res = await fetch('/api/models/inference', { cache: 'no-store' });
  if (!res.ok) return readLocal();
  return normalizePrefs(await res.json());
}

/** Load inference prefs (cached until reset). */
export async function loadLibraryInferencePrefs(): Promise<LibraryInferencePrefs> {
  if (cached) return normalizePrefs(cached);
  const serverUp = await detectConfigServer();
  cached = serverUp ? await fetchFromServer() : readLocal();
  writeLocal(cached);
  return cached;
}

export function getLibraryInferencePrefsSync(): LibraryInferencePrefs {
  return normalizePrefs(cached ?? readLocal());
}

export function resetLibraryInferencePrefsCache(): void {
  cached = null;
}

export function setLibraryInferencePrefsForTests(prefs: LibraryInferencePrefs): void {
  cached = prefs;
}

/** Sampler override for a library row, if any. */
export function getLibrarySamplerForId(libraryId: string): SamplerPreset | null {
  const id = libraryId.trim();
  if (!id) return null;
  const row = getLibraryInferencePrefsSync().byLibraryId[id];
  return row ? { ...row } : null;
}

/** Resolve override for the active chat model id (provider model string). */
export function resolveLibrarySamplerForChatModel(modelId: string): SamplerPreset | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;
  const prefs = getLibraryInferencePrefsSync();
  const libraryId = prefs.chatModelAliases[trimmed];
  if (!libraryId) return null;
  const row = prefs.byLibraryId[libraryId];
  return row ? { ...row } : null;
}

/**
 * Merge global main-chat sampler with a per-model override from the library.
 */
export function mergeGlobalSamplerWithLibraryModel(
  global: GlobalSamplerForSend,
  modelId: string,
): GlobalSamplerForSend {
  const layer = resolveLibrarySamplerForChatModel(modelId);
  if (!layer) return global;

  const merged = clampSamplerPreset(mergeSamplerLayers(global.preset, layer));
  const maxTokens =
    layer.maxTokens !== undefined && Number.isFinite(layer.maxTokens)
      ? Math.floor(layer.maxTokens)
      : global.maxTokens;
  const { maxTokens: _drop, ...preset } = merged;
  return { maxTokens, preset };
}

export function saveLibraryInferenceSampler(payload: {
  libraryId: string;
  sampler: SamplerPreset | null;
  aliases?: string[];
}): Promise<LibraryInferencePrefs> {
  // Each response contains the whole prefs block. Order writes across inspector rebuilds.
  const saved = pendingSave.then(() => persistLibraryInferenceSampler(payload));
  pendingSave = saved.catch(() => undefined);
  return saved;
}

async function persistLibraryInferenceSampler(payload: {
  libraryId: string;
  sampler: SamplerPreset | null;
  aliases?: string[];
}): Promise<LibraryInferencePrefs> {
  const res = await fetch('/api/models/inference', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Save failed (${res.status})`);
  }
  const data = normalizePrefs(await res.json());
  cached = data;
  writeLocal(data);
  return data;
}
