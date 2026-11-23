import SUB_AGENT_DEFAULTS from './defaults/sub-agents.json';
import { getUserWorkAgentOverride } from './work-agent-registry';
import {
  clampSamplerPreset,
  DEFAULT_AGENT_MAX_TOKENS,
  mergeSamplerLayers,
  type SamplerPreset,
} from './sampler-types';
import type { GlobalSamplerForSend } from '../config/sampler-meta';
import type { SubAgentTypeConfig } from './types';

export type SamplerResolveKind = 'work-agent' | 'sub-agent';

export interface ResolveSamplerInput {
  agentKey: string | null;
  kind: SamplerResolveKind;
  global: GlobalSamplerForSend;
  /** Sub-agent runs: unused when global.maxTokens is set; last-ditch only. */
  subAgentMaxTokensFallback?: number;
  subAgentType?: SubAgentTypeConfig | null;
}

export interface ResolvedSampler {
  preset: SamplerPreset;
  maxTokens: number;
}

/** Last-resort when type, global, and fallback all omit a usable max. */
const DEFAULT_SUB_AGENT_MAX_TOKENS = DEFAULT_AGENT_MAX_TOKENS;

function builtinSubAgentSampler(typeId: string): SamplerPreset {
  const types = SUB_AGENT_DEFAULTS.types as Record<string, SubAgentTypeConfig>;
  const row = types[typeId];
  return row?.sampler ? { ...row.sampler } : {};
}

function globalLayer(input: ResolveSamplerInput): SamplerPreset {
  return { ...input.global.preset };
}

function userWorkAgentSampler(agentId: string | null): SamplerPreset {
  if (!agentId) return {};
  const override = getUserWorkAgentOverride(agentId)?.sampler;
  return override ? { ...override } : {};
}

export function resolveSamplerPreset(input: ResolveSamplerInput): ResolvedSampler {
  let merged: SamplerPreset;

  if (input.kind === 'sub-agent') {
    const key = input.agentKey;
    const typeSampler =
      input.subAgentType?.sampler ??
      (key ? builtinSubAgentSampler(key) : {});
    merged = clampSamplerPreset(typeSampler);
  } else {
    const userOverride = userWorkAgentSampler(input.agentKey ?? 'default');
    merged = clampSamplerPreset(
      mergeSamplerLayers(globalLayer(input), userOverride),
    );
  }

  const globalMax =
    Number.isFinite(input.global.maxTokens) && input.global.maxTokens >= 1
      ? input.global.maxTokens
      : undefined;
  let maxTokens =
    input.kind === 'sub-agent'
      ? merged.maxTokens ??
        globalMax ??
        input.subAgentMaxTokensFallback ??
        DEFAULT_SUB_AGENT_MAX_TOKENS
      : input.global.maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    maxTokens =
      input.kind === 'sub-agent'
        ? DEFAULT_SUB_AGENT_MAX_TOKENS
        : DEFAULT_AGENT_MAX_TOKENS;
  }

  const { maxTokens: _drop, ...preset } = merged;
  return { preset, maxTokens: Math.floor(maxTokens) };
}
