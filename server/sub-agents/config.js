import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readConfigJson } from '../config/store.js';
import { agentContextBudgetFromWorkAgent, withCompactionDefaults } from '../runner/context-budget.js';

/** Shipped default provider before inherit fix — empty when model is also unset. */
export const LEGACY_SUB_AGENT_DEFAULT_PROVIDER = 'lm-studio-local';

const SHIPPED_PATH = fileURLToPath(
  new URL('../../src/agents/defaults/sub-agents.json', import.meta.url),
);

/** @type {Record<string, unknown> | null} */
let cachedShipped = null;
/** @type {Record<string, unknown> | null} */
let cachedMerged = null;

/**
 * @returns {Record<string, unknown>}
 */
function shippedDefaults() {
  if (cachedShipped) return cachedShipped;
  cachedShipped = JSON.parse(fs.readFileSync(SHIPPED_PATH, 'utf8'));
  return cachedShipped;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampCheckInNudgeMs(value, fallback = 120_000) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.min(1_800_000, Math.max(10_000, rounded));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampMaxInputTokens(value) {
  if (value == null) return null;
  const cap = Math.floor(Number(value));
  return Number.isFinite(cap) && cap >= 1000 ? Math.min(cap, 200_000) : null;
}

/**
 * @param {string | undefined} providerId
 * @param {string | undefined} modelId
 * @returns {string}
 */
export function migrateLegacySubAgentProviderId(providerId, modelId) {
  const pid = providerId?.trim() ?? '';
  const mid = modelId?.trim() ?? '';
  if (pid === LEGACY_SUB_AGENT_DEFAULT_PROVIDER && !mid) return '';
  return pid;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function cloneType(raw) {
  return {
    ...raw,
    allowedTools: Array.isArray(raw.allowedTools) ? [...raw.allowedTools] : null,
    deniedTools: Array.isArray(raw.deniedTools) ? [...raw.deniedTools] : ['spawn_sub_agent', 'cancel_sub_agent'],
    sampler: raw.sampler && typeof raw.sampler === 'object' ? { .../** @type {object} */ (raw.sampler) } : undefined,
  };
}

/**
 * Deep-merge type maps: user overrides win per field. Duplicated from the
 * renderer so a saved Settings row is what `runTurn` sees — not a second,
 * slightly-different merge.
 *
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {Record<string, unknown>}
 */
export function mergeSubAgentFile(defaults, user) {
  /** @type {Record<string, Record<string, unknown>>} */
  const baseTypes = {};
  const defaultTypes =
    defaults.types && typeof defaults.types === 'object'
      ? /** @type {Record<string, Record<string, unknown>>} */ (defaults.types)
      : {};
  for (const [id, cfg] of Object.entries(defaultTypes)) {
    baseTypes[id] = cloneType(cfg);
  }

  const defaultTimeout =
    typeof user?.defaultTimeoutMs === 'number'
      ? user.defaultTimeoutMs
      : defaults.defaultTimeoutMs;

  const merged = {
    version: user?.version ?? defaults.version,
    enabled: user?.enabled ?? defaults.enabled,
    globalMaxConcurrent: user?.globalMaxConcurrent ?? defaults.globalMaxConcurrent,
    defaultTimeoutMs: defaultTimeout,
    checkInNudgeMs: clampCheckInNudgeMs(
      user?.checkInNudgeMs ?? defaults.checkInNudgeMs,
      clampCheckInNudgeMs(defaults.checkInNudgeMs),
    ),
    defaultMaxInputTokens: user?.defaultMaxInputTokens ?? defaults.defaultMaxInputTokens ?? null,
    defaultContextEnforcementPolicy:
      user?.defaultContextEnforcementPolicy ??
      defaults.defaultContextEnforcementPolicy ??
      'compact',
    defaultContextCompaction:
      user?.defaultContextCompaction ?? defaults.defaultContextCompaction ?? null,
    defaultSummarySchema:
      user?.defaultSummarySchema ?? defaults.defaultSummarySchema ?? 'minnow.sub-agent.v1',
    types: baseTypes,
  };

  const userTypes =
    user?.types && typeof user.types === 'object'
      ? /** @type {Record<string, Record<string, unknown>>} */ (user.types)
      : null;
  if (userTypes) {
    for (const [id, patch] of Object.entries(userTypes)) {
      const existing = merged.types[id] ?? {
        enabled: true,
        providerId: '',
        modelId: '',
        maxConcurrent: 1,
        timeoutMs: merged.defaultTimeoutMs,
        workAgentId: null,
        allowedTools: null,
        deniedTools: ['spawn_sub_agent', 'cancel_sub_agent'],
        systemPromptPath: null,
      };
      const mergedSampler =
        patch.sampler && typeof patch.sampler === 'object'
          ? { ...(existing.sampler && typeof existing.sampler === 'object' ? existing.sampler : {}), ...patch.sampler }
          : existing.sampler;
      merged.types[id] = {
        ...existing,
        ...patch,
        summarySchema:
          patch.summarySchema ?? existing.summarySchema ?? merged.defaultSummarySchema,
        allowedTools:
          patch.allowedTools !== undefined
            ? Array.isArray(patch.allowedTools)
              ? [...patch.allowedTools]
              : null
            : existing.allowedTools,
        deniedTools: Array.isArray(patch.deniedTools)
          ? [...patch.deniedTools]
          : Array.isArray(existing.deniedTools)
            ? [...existing.deniedTools]
            : ['spawn_sub_agent', 'cancel_sub_agent'],
        sampler: mergedSampler,
      };
    }
  }

  for (const cfg of Object.values(merged.types)) {
    cfg.providerId = migrateLegacySubAgentProviderId(
      typeof cfg.providerId === 'string' ? cfg.providerId : '',
      typeof cfg.modelId === 'string' ? cfg.modelId : '',
    );
    if (typeof cfg.summarySchema !== 'string' || !cfg.summarySchema.trim()) {
      cfg.summarySchema = merged.defaultSummarySchema;
    }
    cfg.maxInputTokens = clampMaxInputTokens(cfg.maxInputTokens);
  }

  return merged;
}

/** Drop the merge cache (tests that rewrite ~/.minnow/sub-agents.json). */
export function resetSubAgentServerConfigCache() {
  cachedMerged = null;
}

/**
 * Merged config: shipped defaults ← ~/.minnow/sub-agents.json.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadSubAgentFile() {
  if (cachedMerged) return cachedMerged;
  const defaults = shippedDefaults();
  /** @type {Record<string, unknown> | null} */
  let user = null;
  try {
    const raw = await readConfigJson('sub-agents.json');
    if (raw && typeof raw === 'object') user = /** @type {Record<string, unknown>} */ (raw);
  } catch {
    user = null;
  }
  cachedMerged = mergeSubAgentFile(defaults, user);
  return cachedMerged;
}

/**
 * Budget for runners with no agent row of their own (board attempts, Super Plan
 * stages): the global policy and compaction knobs from Settings → Agents.
 *
 * @returns {Promise<import('../runner/context-budget').AgentContextBudgetConfig>}
 */
export async function loadGlobalContextBudget() {
  const file = await loadSubAgentFile();
  return withCompactionDefaults(
    agentContextBudgetFromWorkAgent({
      contextEnforcementPolicy: /** @type {any} */ (file.defaultContextEnforcementPolicy),
    }),
    /** @type {any} */ (file.defaultContextCompaction),
  );
}

/**
 * @param {string} typeId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getSubAgentTypeRow(typeId) {
  const file = await loadSubAgentFile();
  const types = /** @type {Record<string, Record<string, unknown>>} */ (file.types ?? {});
  const row = types[typeId];
  if (!row || row.enabled === false) return null;
  return row;
}
