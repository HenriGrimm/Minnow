/**
 * Shared model override for short utility generations.
 *
 * When unset, each caller keeps its existing fallback (composer, top bar, or
 * editor/chat binding). The override is shared by title generation, prompt and
 * issue expansion, and git commit message generation.
 */

import { detectConfigServer, isConfigServerMode } from './storage-mode';

export interface UtilityModelConfig {
  modelId: string;
  providerId: string;
}

const STORAGE_KEY = 'minnow.utilityModelMeta';

export const DEFAULT_UTILITY_MODEL_CONFIG: UtilityModelConfig = {
  modelId: '',
  providerId: '',
};

let cached: UtilityModelConfig | null = null;

export function parseUtilityModelBlock(raw: unknown): UtilityModelConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_UTILITY_MODEL_CONFIG };
  }
  const block = raw as Record<string, unknown>;
  return {
    modelId: typeof block.modelId === 'string' ? block.modelId : '',
    providerId: typeof block.providerId === 'string' ? block.providerId : '',
  };
}

function readLocal(): UtilityModelConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseUtilityModelBlock(JSON.parse(raw)) : { ...DEFAULT_UTILITY_MODEL_CONFIG };
  } catch {
    return { ...DEFAULT_UTILITY_MODEL_CONFIG };
  }
}

function writeLocal(config: UtilityModelConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
  }
}

async function fetchFromServer(): Promise<UtilityModelConfig> {
  const res = await fetch('/api/config/meta', { cache: 'no-store' });
  if (!res.ok) return readLocal();
  const meta = (await res.json()) as Record<string, unknown>;
  return parseUtilityModelBlock(meta.utilityModel);
}

export async function loadUtilityModelConfig(): Promise<UtilityModelConfig> {
  if (cached) return cached;
  const storageMode = await detectConfigServer();
  cached = isConfigServerMode(storageMode) ? await fetchFromServer() : readLocal();
  writeLocal(cached);
  return cached;
}

export function resetUtilityModelConfigCache(): void {
  cached = null;
}

export function setUtilityModelConfigForTests(config: UtilityModelConfig): void {
  cached = config;
}

export async function saveUtilityModelConfig(
  patch: Partial<UtilityModelConfig>,
): Promise<void> {
  const current = await loadUtilityModelConfig();
  const next: UtilityModelConfig = {
    modelId: patch.modelId !== undefined ? patch.modelId : current.modelId,
    providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
  };
  cached = next;
  writeLocal(next);
  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ utilityModel: next }),
  });
}

/** Use the shared override only when it contains a model. */
export function utilityModelOverride(
  config: UtilityModelConfig,
): UtilityModelConfig | null {
  return config.modelId.trim()
    ? { providerId: config.providerId.trim(), modelId: config.modelId.trim() }
    : null;
}
