import type { CapabilitySource } from '../types';

export type ModelFitProfileId =
  | 'general-coding'
  | 'vision-ui'
  | 'tool-agent'
  | 'long-context'
  | 'fast-local';

export interface ModelFitProfile {
  id: ModelFitProfileId;
  label: string;
  description: string;
}

export interface ModelFitCandidate {
  key: string;
  providerId: string;
  modelId: string;
  label: string;
  local: boolean;
  loaded: boolean;
  capabilities: {
    vision: boolean | null;
    tools: boolean | null;
    reasoning: boolean | null;
    contextLength: number | null;
    sources?: Partial<Record<'vision' | 'tools' | 'reasoning' | 'contextLength', CapabilitySource>>;
  };
  benchmark?: {
    totalScore?: number;
    tokensPerSecond?: number;
    timeToFirstTokenMs?: number;
  };
  pricing?: {
    currency: string;
    inputPerMillion: number;
    outputPerMillion: number;
  };
}

export type ModelFitStatus = 'compatible' | 'unverified' | 'incompatible';

export interface ModelFitResult {
  candidate: ModelFitCandidate;
  score: number;
  status: ModelFitStatus;
  reasons: string[];
  incompatibilities: string[];
  unknowns: string[];
}

export const MODEL_FIT_PROFILES: readonly ModelFitProfile[] = [
  {
    id: 'general-coding',
    label: 'General coding',
    description: 'Prioritizes tool use, reasoning, useful context, and measured quality.',
  },
  {
    id: 'vision-ui',
    label: 'Vision and UI',
    description: 'Requires image understanding and favors tool use for implementation work.',
  },
  {
    id: 'tool-agent',
    label: 'Tool-heavy agent',
    description: 'Requires tool calling and favors reasoning, context, and measured quality.',
  },
  {
    id: 'long-context',
    label: 'Long-context planning',
    description: 'Requires at least 64K context and favors reasoning and measured quality.',
  },
  {
    id: 'fast-local',
    label: 'Fast and local',
    description: 'Requires an on-device provider and favors loaded models with measured speed.',
  },
] as const;

const LONG_CONTEXT_MIN = 65_536;

function formatContextLength(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`;
  return `${tokens.toLocaleString()} token context`;
}

function sourcePhrase(source: CapabilitySource | undefined): string {
  if (source === 'probe') return 'verified by capability probe';
  if (source === 'catalog') return 'listed by provider catalog';
  if (source === 'assumed') return 'inferred from model family';
  return 'reported';
}

function capabilityLabel(capability: 'tools' | 'vision'): string {
  return capability === 'tools' ? 'Tool calling' : 'Vision';
}

function addRequiredCapability(
  candidate: ModelFitCandidate,
  capability: 'tools' | 'vision',
  reasons: string[],
  incompatibilities: string[],
  unknowns: string[],
): number {
  const value = candidate.capabilities[capability];
  const label = capabilityLabel(capability);
  const source = candidate.capabilities.sources?.[capability];
  if (value === true) {
    reasons.push(`${label} ${sourcePhrase(source)}`);
    if (source === 'assumed') {
      unknowns.push(`${label} has not been verified by catalog or probe`);
      return 15;
    }
    return 30;
  }
  if (value === false) {
    incompatibilities.push(
      source === 'probe'
        ? `${label} failed its capability probe`
        : `${label} is not supported`,
    );
    return -100;
  }
  unknowns.push(`${label} has not been verified`);
  return -8;
}

function addContextRequirement(
  candidate: ModelFitCandidate,
  reasons: string[],
  incompatibilities: string[],
  unknowns: string[],
): number {
  const context = candidate.capabilities.contextLength;
  if (context === null) {
    unknowns.push('Context length is not reported');
    return -8;
  }
  if (context < LONG_CONTEXT_MIN) {
    incompatibilities.push(
      `${formatContextLength(context)} is below the 64K planning requirement`,
    );
    return -100;
  }
  reasons.push(`${formatContextLength(context)} meets the planning requirement`);
  return 30 + Math.min(12, Math.log2(context / LONG_CONTEXT_MIN + 1) * 6);
}

function actualNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function scoreCandidate(
  candidate: ModelFitCandidate,
  profile: ModelFitProfileId,
  fastestTokensPerSecond: number,
): ModelFitResult {
  const reasons: string[] = [];
  const incompatibilities: string[] = [];
  const unknowns: string[] = [];
  let score = 50;

  if (profile === 'general-coding' || profile === 'tool-agent') {
    score += addRequiredCapability(candidate, 'tools', reasons, incompatibilities, unknowns);
  }
  if (profile === 'vision-ui') {
    score += addRequiredCapability(candidate, 'vision', reasons, incompatibilities, unknowns);
    if (candidate.capabilities.tools === true) score += 8;
  }
  if (profile === 'long-context') {
    score += addContextRequirement(candidate, reasons, incompatibilities, unknowns);
  }
  if (profile === 'fast-local') {
    if (candidate.local) {
      score += 35;
      reasons.push('Runs on a local provider');
    } else {
      score -= 100;
      incompatibilities.push('Provider is not local');
    }
  }

  if (profile !== 'fast-local' && candidate.capabilities.reasoning === true) {
    score += profile === 'long-context' ? 14 : 8;
    reasons.push(`Reasoning ${sourcePhrase(candidate.capabilities.sources?.reasoning)}`);
  }

  const context = candidate.capabilities.contextLength;
  if (profile !== 'long-context' && context !== null) {
    score += Math.min(10, Math.max(0, Math.log2(context / 8_192 + 1) * 3));
    reasons.push(formatContextLength(context));
  }

  const quality = candidate.benchmark?.totalScore;
  if (typeof quality === 'number' && Number.isFinite(quality) && quality >= 0) {
    score += Math.min(20, Math.max(0, quality * 20));
    reasons.push(`${Math.round(quality * 100)}% measured benchmark score`);
  }

  const tokensPerSecond = actualNumber(candidate.benchmark?.tokensPerSecond);
  if (profile === 'fast-local' && tokensPerSecond !== null && fastestTokensPerSecond > 0) {
    score += Math.min(25, (tokensPerSecond / fastestTokensPerSecond) * 25);
  }
  if (tokensPerSecond !== null) {
    reasons.push(`${tokensPerSecond.toFixed(1)} measured tokens/s`);
  }

  const ttft = actualNumber(candidate.benchmark?.timeToFirstTokenMs);
  if (profile === 'fast-local' && ttft !== null) {
    score += Math.min(10, 10_000 / (1_000 + ttft));
  }
  if (ttft !== null) {
    reasons.push(`${Math.round(ttft)} ms measured time to first token`);
  }

  if (candidate.loaded) {
    score += profile === 'fast-local' ? 15 : 4;
    reasons.push('Currently loaded');
  }

  if (candidate.pricing) {
    reasons.push(
      `${candidate.pricing.currency} ${candidate.pricing.inputPerMillion.toFixed(2)} input / ${candidate.pricing.outputPerMillion.toFixed(2)} output per 1M tokens`,
    );
  }

  const status: ModelFitStatus = incompatibilities.length
    ? 'incompatible'
    : unknowns.length
      ? 'unverified'
      : 'compatible';

  return {
    candidate,
    score: Math.round(score * 10) / 10,
    status,
    reasons,
    incompatibilities,
    unknowns,
  };
}

/** Rank configured models using only reported capabilities and measured data. */
export function recommendModelFits(
  candidates: readonly ModelFitCandidate[],
  profile: ModelFitProfileId,
): ModelFitResult[] {
  const fastestTokensPerSecond = candidates.reduce(
    (max, candidate) => Math.max(max, actualNumber(candidate.benchmark?.tokensPerSecond) ?? 0),
    0,
  );
  const statusRank: Record<ModelFitStatus, number> = {
    compatible: 0,
    unverified: 1,
    incompatible: 2,
  };

  return candidates
    .map((candidate) => scoreCandidate(candidate, profile, fastestTokensPerSecond))
    .sort((a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      b.score - a.score ||
      a.candidate.label.localeCompare(b.candidate.label) ||
      a.candidate.key.localeCompare(b.candidate.key),
    );
}

export function getModelFitProfile(profile: ModelFitProfileId): ModelFitProfile {
  return MODEL_FIT_PROFILES.find((entry) => entry.id === profile) ?? MODEL_FIT_PROFILES[0];
}
