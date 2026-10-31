import WORK_AGENT_THINKING_DEFAULTS from './defaults/work-agent-thinking.json';
import SUB_AGENT_DEFAULTS from './defaults/sub-agents.json';
import { getThinkingMetaSync } from '../config/thinking-meta';
import { isPassthroughWorkAgentId } from './resolve-work-agent';
import { getUserWorkAgentOverride } from './work-agent-registry';
import {
  mergeThinkingTriState,
  normalizeThinkingTriState,
  type ThinkingResolvedMode,
  type ThinkingTriState,
} from './thinking-types';
import type { SubAgentTypeConfig } from './types';

export type ThinkingResolveKind = 'work-agent' | 'sub-agent';

export interface ResolveThinkingInput {
  kind: ThinkingResolveKind;
  agentKey: string | null;
  chatThinkingMode?: ThinkingTriState | null;
  subAgentType?: SubAgentTypeConfig | null;
  /** Server composition supplies a persisted snapshot instead of browser state. */
  global?: { defaultMode: ThinkingResolvedMode; thinkingBudgetTokens: number | null };
}

export interface ResolvedThinking {
  mode: ThinkingResolvedMode;
  sourceLabel: string;
}

export interface ResolveThinkingBudgetInput {
  kind: ThinkingResolveKind;
  agentKey: string | null;
  subAgentType?: SubAgentTypeConfig | null;
  global?: { defaultMode: ThinkingResolvedMode; thinkingBudgetTokens: number | null };
}

export interface ResolvedThinkingBudget {
  budgetTokens: number | null;
  sourceLabel: string;
}

function builtinWorkAgentThinking(agentId: string): ThinkingTriState {
  const map = WORK_AGENT_THINKING_DEFAULTS as Record<string, ThinkingTriState>;
  return normalizeThinkingTriState(map[agentId], 'inherit');
}

function builtinSubAgentThinking(typeId: string): ThinkingTriState {
  const types = SUB_AGENT_DEFAULTS.types as Record<string, SubAgentTypeConfig>;
  const row = types[typeId];
  return normalizeThinkingTriState(row?.thinkingMode, 'inherit');
}

function userWorkAgentThinking(agentId: string | null): ThinkingTriState {
  if (!agentId) return 'inherit';
  const override = getUserWorkAgentOverride(agentId)?.thinkingMode;
  return normalizeThinkingTriState(override, 'inherit');
}

function globalDefault(): ThinkingResolvedMode {
  return getThinkingMetaSync().defaultMode;
}

function globalBudget(): number | null {
  return getThinkingMetaSync().thinkingBudgetTokens;
}

function userWorkAgentBudget(agentId: string | null): number | null | undefined {
  if (!agentId) return undefined;
  const raw = getUserWorkAgentOverride(agentId)?.thinkingBudgetTokens;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return raw;
}

function mergeThinkingBudgetLayers(
  ...layers: Array<number | null | undefined>
): number | null {
  let resolved: number | null = null;
  for (const layer of layers) {
    if (layer === 0) return null;
    if (layer != null && layer > 0) resolved = layer;
  }
  return resolved;
}

function sourceForWorkAgentBudget(agentKey: string | null, budget = globalBudget()): string {
  if (!agentKey || isPassthroughWorkAgentId(agentKey)) return 'global default';
  const user = getUserWorkAgentOverride(agentKey)?.thinkingBudgetTokens;
  if (user === 0) return `work agent (${agentKey})`;
  if (user != null && user > 0) return `work agent (${agentKey})`;
  const global = budget;
  if (global != null && global > 0) return 'global default';
  return 'global default';
}

function sourceForSubAgentBudget(
  agentKey: string | null,
  subAgentType?: SubAgentTypeConfig | null,
): string {
  const key = agentKey ?? 'sub-agent';
  const typeBudget = subAgentType?.thinkingBudgetTokens;
  if (typeBudget === 0) return `sub-agent (${key})`;
  if (typeBudget != null && typeBudget > 0) return `sub-agent (${key})`;
  const workAgentId = subAgentType?.workAgentId?.trim();
  if (workAgentId) {
    const wa = getUserWorkAgentOverride(workAgentId)?.thinkingBudgetTokens;
    if (wa === 0) return `work agent (${workAgentId})`;
    if (wa != null && wa > 0) return `work agent (${workAgentId})`;
  }
  return 'global default';
}

function sourceForWorkAgent(agentKey: string | null): string {
  if (!agentKey || isPassthroughWorkAgentId(agentKey)) return 'global default';
  const user = getUserWorkAgentOverride(agentKey)?.thinkingMode;
  if (user === 'on' || user === 'off') return `work agent (${agentKey})`;
  const builtin = builtinWorkAgentThinking(agentKey);
  if (builtin === 'on' || builtin === 'off') return `work agent (${agentKey})`;
  return 'global default';
}

function sourceForSubAgent(agentKey: string | null, subAgentType?: SubAgentTypeConfig | null): string {
  const key = agentKey ?? 'sub-agent';
  const typeMode = normalizeThinkingTriState(subAgentType?.thinkingMode, 'inherit');
  if (typeMode === 'on' || typeMode === 'off') return `sub-agent (${key})`;
  const builtin = agentKey ? builtinSubAgentThinking(agentKey) : 'inherit';
  if (builtin === 'on' || builtin === 'off') return `sub-agent (${key})`;
  return 'global default';
}

export function resolveThinkingMode(input: ResolveThinkingInput): ResolvedThinking {
  const chatMode = normalizeThinkingTriState(input.chatThinkingMode, 'inherit');
  if (chatMode === 'on' || chatMode === 'off') {
    return {
      mode: chatMode,
      sourceLabel: 'chat',
    };
  }

  const global = input.global?.defaultMode ?? globalDefault();

  if (input.kind === 'sub-agent') {
    const key = input.agentKey;
    const typeMode =
      input.subAgentType?.thinkingMode ??
      (key ? builtinSubAgentThinking(key) : 'inherit');
    const mode = mergeThinkingTriState(global, typeMode);
    return {
      mode,
      sourceLabel: sourceForSubAgent(key, input.subAgentType),
    };
  }

  const key = input.agentKey;
  let roleDefault: ThinkingTriState = 'inherit';
  if (key && !isPassthroughWorkAgentId(key)) {
    roleDefault = builtinWorkAgentThinking(key);
  }
  const userOverride = userWorkAgentThinking(key ?? 'default');
  const mode = mergeThinkingTriState(global, roleDefault, userOverride);
  return {
    mode,
    sourceLabel: sourceForWorkAgent(key),
  };
}

export function resolveThinkingBudgetTokens(
  input: ResolveThinkingBudgetInput,
): ResolvedThinkingBudget {
  const global = input.global ? input.global.thinkingBudgetTokens : globalBudget();

  if (input.kind === 'sub-agent') {
    const typeBudget = input.subAgentType?.thinkingBudgetTokens;
    const workAgentId = input.subAgentType?.workAgentId?.trim() || null;
    const workAgentBudget = userWorkAgentBudget(workAgentId);
    const budgetTokens = mergeThinkingBudgetLayers(global, workAgentBudget, typeBudget);
    return {
      budgetTokens,
      sourceLabel: sourceForSubAgentBudget(input.agentKey, input.subAgentType),
    };
  }

  const key = input.agentKey;
  const userBudget = userWorkAgentBudget(key ?? 'default');
  const budgetTokens = mergeThinkingBudgetLayers(global, userBudget);
  return {
    budgetTokens,
    sourceLabel: sourceForWorkAgentBudget(key, global),
  };
}
