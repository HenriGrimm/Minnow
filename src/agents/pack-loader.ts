import type { ContextEnforcementPolicy } from '../chat/context-budget';
import { DEFAULT_CONTEXT_ENFORCEMENT_POLICY, normalizeContextEnforcementPolicy } from '../chat/context-budget';
import type {
  AgentPackManifest,
  PackAgentEntry,
  PackAgentSource,
  PackContextStrategy,
} from './pack-types';
import type { WorkAgentDefinition } from './work-agent-types';

export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

export const PACK_AGENT_KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;

export const PACK_WORK_AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;

export const WORK_AGENT_ID_RE =
  /^[a-z][a-z0-9-]{0,63}$|^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;

export function isValidWorkAgentId(id: string): boolean {
  return typeof id === 'string' && WORK_AGENT_ID_RE.test(id);
}

export function packWorkAgentId(packId: string, agentKey: string): string {
  return `${packId}.${agentKey}`;
}

function parseNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function contextPolicyFromStrategy(
  strategy: PackContextStrategy | undefined,
): ContextEnforcementPolicy | undefined {
  // Packs exported before compaction v2 may say summarize: it reads as compact.
  return strategy?.policy === 'inherit' ? undefined : normalizeContextEnforcementPolicy(strategy?.policy) ?? undefined;
}

function maxInputTokensFromStrategy(strategy: PackContextStrategy | undefined): number | null {
  const raw = strategy?.maxInputTokens;
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export function normalizePackAgentEntry(
  manifest: AgentPackManifest,
  entry: PackAgentEntry,
  packRoot: string,
  builtinIds: ReadonlySet<string>,
): { agent: WorkAgentDefinition; source: PackAgentSource } | { error: string } {
  const packId = manifest.id;
  if (!PACK_ID_RE.test(packId)) {
    return { error: `Invalid pack id "${packId}"` };
  }
  if (!PACK_AGENT_KEY_RE.test(entry.key)) {
    return { error: `Invalid agent key "${entry.key}" in pack ${packId}` };
  }

  const id = packWorkAgentId(packId, entry.key);
  if (builtinIds.has(id) || builtinIds.has(entry.key)) {
    return { error: `Agent id "${id}" collides with a built-in work agent` };
  }

  const defaults = manifest.defaults ?? {};
  const providerId =
    parseNullableString(entry.providerId) ?? parseNullableString(defaults.providerId);
  const modelId = parseNullableString(entry.modelId) ?? parseNullableString(defaults.modelId);
  const allowedTools =
    entry.allowedTools !== undefined && entry.allowedTools !== null
      ? [...entry.allowedTools]
      : defaults.allowedTools !== undefined && defaults.allowedTools !== null
        ? [...defaults.allowedTools]
        : null;

  const policy = contextPolicyFromStrategy(entry.contextStrategy);
  const maxInputTokens = maxInputTokensFromStrategy(entry.contextStrategy);

  const agent: WorkAgentDefinition = {
    id,
    label: entry.label.trim(),
    description: (entry.description ?? '').trim(),
    kind: 'work-agent',
    version: manifest.version,
    providerId,
    modelId,
    allowedTools,
    defaultForModes: entry.defaultForModes?.map(String),
    disabled: entry.disabled === true,
    maxInputTokens,
    contextEnforcementPolicy: policy ?? DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
    source: 'pack',
    packId,
  };

  const source: PackAgentSource = {
    packId,
    agentKey: entry.key,
    packRoot,
    promptPaths: {
      full: entry.prompts.full,
      lite: entry.prompts.lite,
    },
    contextStrategy: entry.contextStrategy,
  };

  return { agent, source };
}

export function agentsFromPackManifest(
  manifest: AgentPackManifest,
  packRoot: string,
  builtinIds: ReadonlySet<string>,
): { agents: WorkAgentDefinition[]; sources: PackAgentSource[]; errors: string[] } {
  const agents: WorkAgentDefinition[] = [];
  const sources: PackAgentSource[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of manifest.agents) {
    const result = normalizePackAgentEntry(manifest, entry, packRoot, builtinIds);
    if ('error' in result) {
      errors.push(result.error);
      continue;
    }
    if (seenIds.has(result.agent.id)) {
      errors.push(`Duplicate agent id "${result.agent.id}" in pack ${manifest.id}`);
      continue;
    }
    seenIds.add(result.agent.id);
    agents.push(result.agent);
    sources.push(result.source);
  }

  return { agents, sources, errors };
}

export function mergePackAgentsIntoMap(
  builtinMap: Map<string, WorkAgentDefinition>,
  packAgents: WorkAgentDefinition[],
): Map<string, WorkAgentDefinition> {
  const out = new Map(builtinMap);
  for (const agent of packAgents) {
    if (!out.has(agent.id)) {
      out.set(agent.id, agent);
    }
  }
  return out;
}
