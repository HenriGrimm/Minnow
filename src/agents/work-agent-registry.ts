import { parsePromptMarkdown } from '../chat/prompts/parse-front-matter';
import { parseWorkAgentMetaFromMarkdown } from './work-agent-meta-parse';
import type {
  WorkAgentDefinition,
  WorkAgentUserOverride,
} from './work-agent-types';

const SKIP_PREFIXES = ['_template', '_example'];

export const DEFAULT_REGISTRY_IDS = [
  'general',
  'builder',
  'planner',
  'reviewer',
  'researcher',
  'ui-designer',
  'tester',
] as const;

export interface WorkAgentRegistryIndex {
  ids: string[];
}

let registryIndex: WorkAgentRegistryIndex = { ids: [...DEFAULT_REGISTRY_IDS] };
let builtinAgents = new Map<string, WorkAgentDefinition>();
let userOverrides: Record<string, WorkAgentUserOverride> = {};

function shouldSkipAgentId(id: string): boolean {
  if (!id || id.startsWith('_')) return true;
  return SKIP_PREFIXES.some((p) => id === p || id.startsWith(`${p}/`));
}

function agentIdFromPath(relativePath: string): string | null {
  const norm = relativePath.replace(/\\/g, '/');
  const match = norm.match(/work-agents\/([^/]+)\/agent\.(full|lite)\.md$/);
  return match?.[1] ?? null;
}

interface AgentAccumulator {
  meta?: WorkAgentDefinition;
  fullBody?: string;
  liteBody?: string;
}

function mergeRawFile(
  accMap: Map<string, AgentAccumulator>,
  agentId: string,
  suffix: 'full' | 'lite',
  raw: string,
  relativePath: string,
): void {
  if (shouldSkipAgentId(agentId)) return;

  let acc = accMap.get(agentId);
  if (!acc) {
    acc = {};
    accMap.set(agentId, acc);
  }

  if (suffix === 'full') {
    const meta = parseWorkAgentMetaFromMarkdown(raw, relativePath);
    if (meta) acc.meta = meta;
    try {
      const { markdownBody } = parsePromptMarkdown(raw, relativePath);
      acc.fullBody = markdownBody.trim();
    } catch {}
  } else {
    try {
      const { markdownBody } = parsePromptMarkdown(raw, relativePath);
      acc.liteBody = markdownBody.trim();
    } catch {}
  }
}

function buildAgentsFromRaw(rawMap: Record<string, string>): Map<string, WorkAgentDefinition> {
  const accMap = new Map<string, AgentAccumulator>();

  for (const [globPath, raw] of Object.entries(rawMap)) {
    const relativePath = globPath
      .replace(/^\.\//, '')
      .replace(/^.*?prompts[\\/]/, '');
    if (!relativePath.includes('work-agents/')) continue;

    const agentId = agentIdFromPath(relativePath);
    if (!agentId) continue;

    const suffix = relativePath.endsWith('.lite.md') ? 'lite' : 'full';
    mergeRawFile(accMap, agentId, suffix, raw, relativePath);
  }

  const out = new Map<string, WorkAgentDefinition>();
  for (const [id, acc] of accMap) {
    if (!acc.meta) continue;
    out.set(id, { ...acc.meta });
  }
  return out;
}

export function mergeWorkAgentDefinition(
  builtin: WorkAgentDefinition,
  override: WorkAgentUserOverride | undefined,
): WorkAgentDefinition {
  if (!override) return { ...builtin };

  return {
    ...builtin,
    providerId:
      override.providerId !== undefined ? override.providerId : builtin.providerId,
    modelId: override.modelId !== undefined ? override.modelId : builtin.modelId,
    disabled: override.disabled !== undefined ? override.disabled : builtin.disabled,
    maxInputTokens:
      override.maxInputTokens !== undefined
        ? override.maxInputTokens
        : builtin.maxInputTokens,
    contextEnforcementPolicy:
      override.contextEnforcementPolicy !== undefined
        ? override.contextEnforcementPolicy
        : builtin.contextEnforcementPolicy,
    minRecentTurns:
      override.minRecentTurns !== undefined
        ? override.minRecentTurns
        : builtin.minRecentTurns,
    summaryReserveTokens:
      override.summaryReserveTokens !== undefined
        ? override.summaryReserveTokens
        : builtin.summaryReserveTokens,
  };
}

function orderedAgents(map: Map<string, WorkAgentDefinition>): WorkAgentDefinition[] {
  const seen = new Set<string>();
  const list: WorkAgentDefinition[] = [];

  for (const id of registryIndex.ids) {
    const agent = map.get(id);
    if (agent && !seen.has(id)) {
      list.push(mergeWorkAgentDefinition(agent, userOverrides[id]));
      seen.add(id);
    }
  }

  for (const [id, agent] of map) {
    if (!seen.has(id)) {
      list.push(mergeWorkAgentDefinition(agent, userOverrides[id]));
    }
  }

  return list;
}

export function setWorkAgentRegistryIndex(index: WorkAgentRegistryIndex): void {
  registryIndex = { ids: [...index.ids] };
}

export function setUserWorkAgentOverrides(
  overrides: Record<string, WorkAgentUserOverride>,
): void {
  userOverrides = { ...overrides };
}

export function mergeUserWorkAgentOverride(
  agentId: string,
  patch: WorkAgentUserOverride,
): void {
  const prev = userOverrides[agentId] ?? {};
  const next: WorkAgentUserOverride = { ...prev, ...patch };
  if (patch.contextEnforcementPolicy === null) {
    delete next.contextEnforcementPolicy;
  }
  userOverrides[agentId] = next;
}

export function initBuiltinWorkAgentRegistry(raw: Record<string, string> = {}): void {
  builtinAgents = buildAgentsFromRaw(raw);
}

export function registerWorkAgentFilesFromRaw(rawMap: Record<string, string>): void {
  const built = buildAgentsFromRaw(rawMap);
  for (const [id, agent] of built) {
    builtinAgents.set(id, agent);
  }
}

export function registerPackAgentsFromApi(agents: WorkAgentDefinition[]): void {
  for (const agent of agents) {
    if (agent.source === 'pack' && agent.id) {
      builtinAgents.set(agent.id, { ...agent, kind: 'work-agent' });
    }
  }
}

export function registerWorkAgentsFromServerSnapshot(agents: WorkAgentDefinition[]): void {
  for (const agent of agents) {
    if (!agent?.id) continue;
    builtinAgents.set(agent.id, { ...agent, kind: agent.kind ?? 'work-agent' });
  }
}

export function resetWorkAgentRegistry(): void {
  builtinAgents.clear();
  userOverrides = {};
  registryIndex = { ids: [...DEFAULT_REGISTRY_IDS] };
}

export function listWorkAgents(includeDisabled = false): WorkAgentDefinition[] {
  const agents = orderedAgents(builtinAgents);
  if (includeDisabled) return agents;
  return agents.filter((a) => !a.disabled);
}

export function getBuiltinWorkAgent(id: string): WorkAgentDefinition | null {
  const agent = builtinAgents.get(id);
  return agent ? { ...agent } : null;
}

export function getWorkAgent(id: string): WorkAgentDefinition | null {
  const agent = builtinAgents.get(id);
  if (!agent) return null;
  return mergeWorkAgentDefinition(agent, userOverrides[id]);
}

export function getDefaultWorkAgentForMode(modeId: string): WorkAgentDefinition | null {
  const mode = modeId.trim();
  if (!mode) return null;

  for (const id of registryIndex.ids) {
    const agent = getWorkAgent(id);
    if (!agent || agent.disabled || agent.id === 'default') continue;
    if (agent.defaultForModes?.includes(mode)) return agent;
  }

  return null;
}

export function getUserWorkAgentOverride(agentId: string): WorkAgentUserOverride | undefined {
  return userOverrides[agentId];
}

export function getWorkAgentPromptOverride(agentId: string): string | null {
  const override = userOverrides[agentId]?.promptOverride;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return null;
}
