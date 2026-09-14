import type { ContextEnforcementPolicy } from '../chat/context-budget';
import type { SamplerPreset } from './sampler-types';
import type { ThinkingTriState } from './thinking-types';

export type WorkAgentSource = 'builtin' | 'pack' | 'override';

export interface WorkAgentDefinition {
  id: string;
  label: string;
  description: string;
  source?: WorkAgentSource;
  packId?: string;
  kind: 'work-agent';
  version: string;
  providerId: string | null;
  modelId: string | null;
  allowedTools: string[] | null;
  defaultForModes?: string[];
  disabled?: boolean;
  maxInputTokens?: number | null;
  contextEnforcementPolicy?: ContextEnforcementPolicy;
  minRecentTurns?: number;
  summaryReserveTokens?: number;
  sampler?: SamplerPreset;
}

export interface WorkAgentUserOverride {
  providerId?: string | null;
  modelId?: string | null;
  promptOverride?: string | null;
  disabled?: boolean;
  maxInputTokens?: number | null;
  contextEnforcementPolicy?: ContextEnforcementPolicy;
  minRecentTurns?: number;
  summaryReserveTokens?: number;
  sampler?: SamplerPreset | null;
  thinkingMode?: ThinkingTriState | null;
  /** Per-session thinking token budget; null = inherit, 0 = off. */
  thinkingBudgetTokens?: number | null;
}

export interface WorkAgentRegistrySnapshot {
  agents: WorkAgentDefinition[];
  overrides: Record<string, WorkAgentUserOverride>;
}

export interface WorkAgentBinding {
  agentId: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  headers: Record<string, string>;
}

export class WorkAgentConfigError extends Error {
  readonly code = 'WORK_AGENT_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'WorkAgentConfigError';
  }
}
