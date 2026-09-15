import { detectConfigServer, isServerStorageMode } from '../config/storage-mode';
import {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  type ContextCompactionDefaults,
  type ContextEnforcementPolicy,
} from '../chat/context-budget';
import { DEFAULT_SUB_AGENT_SUMMARY_SCHEMA } from './sub-agent-structured-outcome';
import DEFAULTS from './defaults/sub-agents.json';
import { clampSamplerPreset, mergeSamplerLayers } from './sampler-types';
import { clampThinkingBudgetTokens } from './thinking-types';
import type { SubAgentTypeConfig, SubAgentsFile } from './types';

const SUB_AGENTS_STORAGE_KEY = 'minnow.subAgents';

export const LEGACY_SUB_AGENT_DEFAULT_PROVIDER = 'lm-studio-local';

let runtimeUserOverrides: Partial<SubAgentsFile> | null = null;
let cachedMerged: SubAgentsFile | null = null;
let cachedUserOverrides: Partial<SubAgentsFile> | null | undefined;

export function clampSubAgentCheckInNudgeMs(value: unknown, fallback = 120_000): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.min(1_800_000, Math.max(10_000, rounded));
}

function cloneTypeConfig(raw: SubAgentTypeConfig): SubAgentTypeConfig {
  return {
    ...raw,
    allowedTools: raw.allowedTools ? [...raw.allowedTools] : null,
    deniedTools: [...raw.deniedTools],
    sampler: raw.sampler ? { ...raw.sampler } : undefined,
  };
}

export function mergeSubAgentConfig(
  defaults: SubAgentsFile,
  user: Partial<SubAgentsFile> | null | undefined,
): SubAgentsFile {
  const baseTypes: Record<string, SubAgentTypeConfig> = {};
  for (const [id, cfg] of Object.entries(defaults.types)) {
    baseTypes[id] = cloneTypeConfig(cfg);
  }

  const merged: SubAgentsFile = {
    version: user?.version ?? defaults.version,
    enabled: user?.enabled ?? defaults.enabled,
    globalMaxConcurrent: user?.globalMaxConcurrent ?? defaults.globalMaxConcurrent,
    defaultTimeoutMs: user?.defaultTimeoutMs ?? defaults.defaultTimeoutMs,
    checkInNudgeMs: clampSubAgentCheckInNudgeMs(
      user?.checkInNudgeMs ?? defaults.checkInNudgeMs,
      clampSubAgentCheckInNudgeMs(defaults.checkInNudgeMs),
    ),
    defaultMaxInputTokens: user?.defaultMaxInputTokens ?? defaults.defaultMaxInputTokens,
    defaultContextEnforcementPolicy:
      user?.defaultContextEnforcementPolicy ??
      defaults.defaultContextEnforcementPolicy ??
      DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
    defaultContextCompaction:
      user?.defaultContextCompaction ?? defaults.defaultContextCompaction ?? null,
    defaultSummarySchema:
      user?.defaultSummarySchema ?? defaults.defaultSummarySchema ?? DEFAULT_SUB_AGENT_SUMMARY_SCHEMA,
    types: baseTypes,
  };

  if (user?.types) {
    for (const [id, patch] of Object.entries(user.types)) {
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
        patch.sampler !== undefined
          ? clampSamplerPreset(
              mergeSamplerLayers(existing.sampler, patch.sampler),
            )
          : existing.sampler;
      const mergedThinkingBudget =
        patch.thinkingBudgetTokens !== undefined
          ? patch.thinkingBudgetTokens === null
            ? null
            : clampThinkingBudgetTokens(patch.thinkingBudgetTokens)
          : existing.thinkingBudgetTokens;
      merged.types[id] = {
        ...existing,
        ...patch,
        thinkingBudgetTokens: mergedThinkingBudget,
        summarySchema:
          patch.summarySchema ??
          existing.summarySchema ??
          merged.defaultSummarySchema ??
          DEFAULT_SUB_AGENT_SUMMARY_SCHEMA,
        allowedTools:
          patch.allowedTools !== undefined
            ? patch.allowedTools
              ? [...patch.allowedTools]
              : null
            : existing.allowedTools,
        deniedTools: patch.deniedTools
          ? [...patch.deniedTools]
          : [...existing.deniedTools],
        sampler: mergedSampler,
      };
    }
  }

  for (const cfg of Object.values(merged.types)) {
    cfg.providerId = migrateLegacySubAgentProviderId(cfg.providerId, cfg.modelId);
    if (!cfg.summarySchema?.trim()) {
      cfg.summarySchema = merged.defaultSummarySchema ?? DEFAULT_SUB_AGENT_SUMMARY_SCHEMA;
    }
    if (cfg.maxInputTokens != null) {
      const cap = Math.floor(Number(cfg.maxInputTokens));
      cfg.maxInputTokens = Number.isFinite(cap) && cap >= 1000 ? Math.min(cap, 200_000) : null;
    }
  }

  return merged;
}

export function migrateLegacySubAgentProviderId(
  providerId: string | undefined,
  modelId: string | undefined,
): string {
  const pid = providerId?.trim() ?? '';
  const mid = modelId?.trim() ?? '';
  if (pid === LEGACY_SUB_AGENT_DEFAULT_PROVIDER && !mid) {
    return '';
  }
  return pid;
}

function readLocalSubAgents(): Partial<SubAgentsFile> | null {
  try {
    const raw = localStorage.getItem(SUB_AGENTS_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<SubAgentsFile>;
  } catch {
    return null;
  }
}

function writeLocalSubAgents(data: Partial<SubAgentsFile>): void {
  localStorage.setItem(SUB_AGENTS_STORAGE_KEY, JSON.stringify(data));
}

export async function fetchSubAgentConfigFromServer(): Promise<Partial<SubAgentsFile> | null> {
  await detectConfigServer();
  if (!isServerStorageMode()) return null;

  try {
    const res = await fetch('/api/config/sub-agents', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as Partial<SubAgentsFile>;
  } catch {
    return null;
  }
}

export async function saveSubAgentConfigToServer(
  overrides: Partial<SubAgentsFile>,
): Promise<boolean> {
  await detectConfigServer();
  if (isServerStorageMode()) {
    const res = await fetch('/api/config/sub-agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides),
    });
    if (!res.ok) return false;
    runtimeUserOverrides = overrides;
    cachedMerged = null;
    cachedUserOverrides = undefined;
    return true;
  }

  writeLocalSubAgents(overrides);
  runtimeUserOverrides = overrides;
  cachedMerged = null;
  cachedUserOverrides = undefined;
  return true;
}

/**
 * Merge `patch` into the saved user overrides. The config PUT replaces the whole
 * file, so saving one field alone used to erase the rest (a policy change dropped
 * every per-type override).
 */
export async function patchSubAgentUserOverrides(patch: Partial<SubAgentsFile>): Promise<boolean> {
  await loadSubAgentConfig();
  const current = getSubAgentUserOverridesSync() ?? {};
  const next: Partial<SubAgentsFile> = { ...current, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete (next as Record<string, unknown>)[key];
  }
  return saveSubAgentConfigToServer(next);
}

export function setRuntimeSubAgentOverrides(overrides: Partial<SubAgentsFile> | null): void {
  runtimeUserOverrides = overrides;
  cachedMerged = null;
  cachedUserOverrides = undefined;
}

export function resetSubAgentConfigCache(): void {
  cachedMerged = null;
  runtimeUserOverrides = null;
  cachedUserOverrides = undefined;
}

export function getSubAgentUserOverridesSync(): Partial<SubAgentsFile> | null {
  return cachedUserOverrides ?? runtimeUserOverrides;
}

export function getGlobalContextEnforcementPolicySync(): ContextEnforcementPolicy {
  if (cachedMerged?.defaultContextEnforcementPolicy) {
    return cachedMerged.defaultContextEnforcementPolicy;
  }
  const defaults = DEFAULTS as SubAgentsFile;
  return (
    runtimeUserOverrides?.defaultContextEnforcementPolicy ??
    defaults.defaultContextEnforcementPolicy ??
    DEFAULT_CONTEXT_ENFORCEMENT_POLICY
  );
}

/** Global compaction knobs (Settings → Agents → Context policy), or null for shipped defaults. */
export function getGlobalContextCompactionSync(): ContextCompactionDefaults | null {
  if (cachedMerged) return cachedMerged.defaultContextCompaction ?? null;
  return runtimeUserOverrides?.defaultContextCompaction ?? null;
}

export async function loadSubAgentConfig(): Promise<SubAgentsFile> {
  if (cachedMerged) return cachedMerged;

  const defaults = DEFAULTS as SubAgentsFile;
  let user: Partial<SubAgentsFile> | null = runtimeUserOverrides;

  if (!user) {
    const fromServer = await fetchSubAgentConfigFromServer();
    user = fromServer ?? readLocalSubAgents();
  }

  cachedUserOverrides = user ?? null;
  cachedMerged = mergeSubAgentConfig(defaults, user ?? undefined);
  return cachedMerged;
}

export async function getSubAgentTypeConfig(
  typeId: string,
): Promise<SubAgentTypeConfig | null> {
  const config = await loadSubAgentConfig();
  const type = config.types[typeId];
  if (!type || type.enabled === false) return null;
  return type;
}
