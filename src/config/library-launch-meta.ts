import type { EngineId } from '../models/engine-ids.mjs';
import type { MtplxServeSettings } from '../models/mtplx-settings';
/**
 * Per-library-model llama.cpp launch prefs (Models inspector → config.json models.launch).
 *
 * Mirrors library-inference-meta.ts: tool-server GET/PUT with a localStorage
 * fallback when the server is down, plus a sync cache so Load can read the last
 * saved row without awaiting. The inspector session Map is not enough — it
 * died on reload (Phase 1d).
 */

import { detectConfigServer } from './storage-mode';
import type { LlamaServeSettings } from '../models/api-client';

/** Spawn settings plus the optional time-based load-progress prior. */
export interface LibraryLaunchSettings extends LlamaServeSettings {
  engine?: EngineId;
  mtplx?: MtplxServeSettings;
  /** Wall-clock ms of the last successful llama.cpp load for this row. */
  lastLoadMs?: number;
  /** Weight bytes observed for that load — used to scale duration by file size. */
  lastWeightsBytes?: number;
}

export interface LibraryLaunchPrefs {
  byLibraryId: Record<string, LibraryLaunchSettings>;
}

const STORAGE_KEY = 'minnow.libraryLaunch';

let cached: LibraryLaunchPrefs | null = null;

function emptyPrefs(): LibraryLaunchPrefs {
  return { byLibraryId: {} };
}

/** Progress fields are not spawn flags — drop them before loadModel / argv. */
const PROGRESS_KEYS = new Set(['lastLoadMs', 'lastWeightsBytes', 'engine', 'mtplx']);

/**
 * Spawn-only slice of a saved row. Empty when the row is progress-only.
 */
export function llamaSettingsFromLaunchPrefs(
  row: LibraryLaunchSettings | null | undefined,
): LlamaServeSettings | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const out: LlamaServeSettings = {};
  for (const [key, value] of Object.entries(row)) {
    if (PROGRESS_KEYS.has(key) || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePrefs(raw: unknown): LibraryLaunchPrefs {
  if (!raw || typeof raw !== 'object') return emptyPrefs();
  const block = raw as Record<string, unknown>;
  const byLibraryId =
    block.byLibraryId && typeof block.byLibraryId === 'object'
      ? { ...(block.byLibraryId as Record<string, LibraryLaunchSettings>) }
      : {};
  return { byLibraryId };
}

function readLocal(): LibraryLaunchPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyPrefs();
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return emptyPrefs();
  }
}

function writeLocal(prefs: LibraryLaunchPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

async function fetchFromServer(): Promise<LibraryLaunchPrefs> {
  const res = await fetch('/api/models/launch', { cache: 'no-store' });
  if (!res.ok) return readLocal();
  return normalizePrefs(await res.json());
}

/** Load launch prefs (cached until reset). */
export async function loadLibraryLaunchPrefs(): Promise<LibraryLaunchPrefs> {
  if (cached) return normalizePrefs(cached);
  const serverUp = await detectConfigServer();
  cached = serverUp ? await fetchFromServer() : readLocal();
  writeLocal(cached);
  return cached;
}

export function getLibraryLaunchPrefsSync(): LibraryLaunchPrefs {
  return normalizePrefs(cached ?? readLocal());
}

export function resetLibraryLaunchPrefsCache(): void {
  cached = null;
}

export function setLibraryLaunchPrefsForTests(prefs: LibraryLaunchPrefs): void {
  cached = prefs;
}

/** Saved launch row for a library id, including lastLoadMs when present. */
export function getLibraryLaunchSettingsForId(libraryId: string): LibraryLaunchSettings | null {
  const id = libraryId.trim();
  if (!id) return null;
  const row = getLibraryLaunchPrefsSync().byLibraryId[id];
  return row ? { ...row } : null;
}

/**
 * Scale the last observed load duration by current / last weights size.
 * Honest and monotonic in file size — not a fake percent of "loading".
 */
export function estimateLoadDurationMs(
  weightsBytes: number,
  lastLoadMs: number,
  lastWeightsBytes: number,
): number | null {
  if (!(weightsBytes > 0) || !(lastLoadMs > 0) || !(lastWeightsBytes > 0)) return null;
  return Math.max(1, Math.round(lastLoadMs * (weightsBytes / lastWeightsBytes)));
}

/**
 * Apply a PUT locally so sliders / picker see the new row before the server round-trip.
 * Keeps lastLoadMs when the payload omitted it (slider save must not wipe the prior).
 */
function applyLocalSave(
  prefs: LibraryLaunchPrefs,
  libraryId: string,
  settings: LibraryLaunchSettings | null,
): LibraryLaunchPrefs {
  const byLibraryId = { ...prefs.byLibraryId };
  if (settings === null || Object.keys(settings).length === 0) {
    delete byLibraryId[libraryId];
    return { byLibraryId };
  }
  const prev = byLibraryId[libraryId];
  const next: LibraryLaunchSettings = { ...settings };
  if (next.lastLoadMs == null && prev?.lastLoadMs != null) next.lastLoadMs = prev.lastLoadMs;
  if (next.lastWeightsBytes == null && prev?.lastWeightsBytes != null) {
    next.lastWeightsBytes = prev.lastWeightsBytes;
  }
  byLibraryId[libraryId] = next;
  return { byLibraryId };
}

let saveQueue: Promise<unknown> = Promise.resolve();
let saveRevision = 0;

export async function saveLibraryLaunchSettings(payload: {
  libraryId: string;
  settings: LibraryLaunchSettings | null;
}): Promise<LibraryLaunchPrefs> {
  const id = payload.libraryId.trim();
  const optimistic = applyLocalSave(cached ?? readLocal(), id, payload.settings);
  cached = optimistic;
  writeLocal(optimistic);
  const revision = ++saveRevision;
  const body = JSON.stringify({ libraryId: id, settings: payload.settings });

  const save = async () => {
    try {
      const res = await fetch('/api/models/launch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) return optimistic;
      const data = normalizePrefs(await res.json());
      if (revision === saveRevision) {
        cached = data;
        writeLocal(data);
      }
      return data;
    } catch {
      return optimistic;
    }
  };
  const pending = saveQueue.then(save, save);
  saveQueue = pending;
  return pending;
}
