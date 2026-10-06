/** Persisted reasoning-level defaults keyed by provider/model picker value. */

import { isComposerReasoningLevel } from '../lib/reasoning-effort';
import type { ReasoningEffortOption } from '../types';
import { isServerStorageMode } from './storage-mode';

export const MODEL_REASONING_DEFAULTS_STORAGE_KEY = 'minnow.modelReasoningDefaults';

export type ModelReasoningDefaults = Record<string, ReasoningEffortOption>;

let cachedDefaults: ModelReasoningDefaults | null = null;
let pendingSave = Promise.resolve();

function parseDefaults(raw: unknown): ModelReasoningDefaults {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const parsed: ModelReasoningDefaults = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 4096 || !isComposerReasoningLevel(value)) continue;
    parsed[trimmed] = value;
  }
  return parsed;
}

function readLocalDefaults(): ModelReasoningDefaults {
  try {
    const raw = localStorage.getItem(MODEL_REASONING_DEFAULTS_STORAGE_KEY);
    return raw ? parseDefaults(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function writeLocalDefaults(defaults: ModelReasoningDefaults): void {
  try {
    localStorage.setItem(MODEL_REASONING_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults));
  } catch {
  }
}

/** Load disk-backed defaults once; browser storage remains the offline fallback. */
export async function loadModelReasoningDefaults(): Promise<ModelReasoningDefaults> {
  if (cachedDefaults) return cachedDefaults;
  if (!isServerStorageMode()) {
    cachedDefaults = readLocalDefaults();
    return cachedDefaults;
  }
  await pendingSave;
  const response = await fetch('/api/config/model-reasoning-defaults', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load model reasoning defaults');
  const body = (await response.json()) as { defaults?: unknown };
  cachedDefaults = parseDefaults(body.defaults);
  writeLocalDefaults(cachedDefaults);
  return cachedDefaults;
}

/** Current override for a picker value, if the user chose one. */
export function getModelReasoningDefault(
  selectValue: string,
): ReasoningEffortOption | undefined {
  const key = selectValue.trim();
  if (!key) return undefined;
  return (cachedDefaults ?? readLocalDefaults())[key];
}

/** Save or clear one per-model reasoning-level override. */
export function saveModelReasoningDefault(
  selectValue: string,
  effort: ReasoningEffortOption | null,
): Promise<void> {
  const key = selectValue.trim();
  if (!key) return Promise.resolve();
  if (effort !== null && !isComposerReasoningLevel(effort)) {
    return Promise.reject(new Error('Expected a reasoning level'));
  }

  const next = { ...(cachedDefaults ?? readLocalDefaults()) };
  if (effort === null) delete next[key];
  else next[key] = effort;
  cachedDefaults = next;
  writeLocalDefaults(next);

  if (!isServerStorageMode()) return Promise.resolve();
  const save = pendingSave.then(async () => {
    const response = await fetch('/api/config/model-reasoning-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaults: next }),
      keepalive: true,
    });
    if (!response.ok) throw new Error('Could not save model reasoning default');
  });
  pendingSave = save.catch(() => {});
  return save;
}

export function resetModelReasoningDefaultsForTests(): void {
  cachedDefaults = null;
  pendingSave = Promise.resolve();
}
