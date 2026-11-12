/**
 * Global thinking default in ~/.minnow/config.json (`thinking` block).
 */

import {
  clampThinkingBudgetTokens,
  normalizeThinkingGlobalDefault,
  type ThinkingGlobalDefault,
} from '../agents/thinking-types';
import { detectConfigServer, readConfigMeta } from './storage-mode';

export interface ThinkingGlobalMeta {
  defaultMode: ThinkingGlobalDefault;
  /** Global thinking budget; null = off (inherit layers resolve to off). */
  thinkingBudgetTokens: number | null;
}

export const DEFAULT_THINKING_GLOBAL: ThinkingGlobalMeta = {
  defaultMode: 'on',
  thinkingBudgetTokens: null,
};

const THINKING_META_STORAGE_KEY = 'minnow.thinkingMeta';

let cachedThinking: ThinkingGlobalMeta | null = null;

function parseThinkingBlock(raw: unknown): ThinkingGlobalMeta {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_THINKING_GLOBAL };
  }
  const block = raw as Record<string, unknown>;
  const budgetRaw = block.thinkingBudgetTokens;
  const thinkingBudgetTokens =
    budgetRaw === null || budgetRaw === undefined
      ? null
      : clampThinkingBudgetTokens(budgetRaw);
  return {
    defaultMode: normalizeThinkingGlobalDefault(block.defaultMode, 'on'),
    thinkingBudgetTokens,
  };
}

function readLocalThinkingMeta(): ThinkingGlobalMeta {
  try {
    const raw = localStorage.getItem(THINKING_META_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THINKING_GLOBAL };
    return parseThinkingBlock(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THINKING_GLOBAL };
  }
}

function writeLocalThinkingMeta(config: ThinkingGlobalMeta): void {
  localStorage.setItem(THINKING_META_STORAGE_KEY, JSON.stringify(config));
}

async function fetchThinkingFromServer(): Promise<ThinkingGlobalMeta> {
  const meta = await readConfigMeta();
  return meta ? parseThinkingBlock(meta.thinking) : readLocalThinkingMeta();
}

/** Load global thinking meta (cached until reset). */
export async function loadThinkingMeta(): Promise<ThinkingGlobalMeta> {
  if (cachedThinking) return cachedThinking;
  const serverUp = await detectConfigServer();
  cachedThinking = serverUp ? await fetchThinkingFromServer() : readLocalThinkingMeta();
  writeLocalThinkingMeta(cachedThinking);
  return cachedThinking;
}

export function getThinkingMetaSync(): ThinkingGlobalMeta {
  return cachedThinking ?? readLocalThinkingMeta();
}

export function resetThinkingMetaCache(): void {
  cachedThinking = null;
}

export function setThinkingMetaForTests(config: ThinkingGlobalMeta): void {
  cachedThinking = config;
}

/** Persist partial global thinking via PUT /api/config/meta. */
export async function saveThinkingMeta(
  patch: Partial<ThinkingGlobalMeta>,
): Promise<ThinkingGlobalMeta> {
  const current = await loadThinkingMeta();
  const merged: ThinkingGlobalMeta = {
    defaultMode: patch.defaultMode
      ? normalizeThinkingGlobalDefault(patch.defaultMode, current.defaultMode)
      : current.defaultMode,
    thinkingBudgetTokens:
      patch.thinkingBudgetTokens !== undefined
        ? patch.thinkingBudgetTokens === null
          ? null
          : clampThinkingBudgetTokens(patch.thinkingBudgetTokens)
        : current.thinkingBudgetTokens,
  };
  cachedThinking = merged;
  writeLocalThinkingMeta(merged);
  await fetch('/api/config/meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinking: merged }),
  });
  return merged;
}
