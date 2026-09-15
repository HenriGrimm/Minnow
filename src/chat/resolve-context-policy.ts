import {
  DEFAULT_CONTEXT_ENFORCEMENT_POLICY,
  normalizeContextEnforcementPolicy,
  type ContextEnforcementPolicy,
} from './context-budget';
import {
  getGlobalContextEnforcementPolicySync,
  getSubAgentUserOverridesSync,
} from '../agents/sub-agent-config';
import { getBuiltinWorkAgent, getUserWorkAgentOverride } from '../agents/work-agent-registry';
import type { SubAgentTypeConfig, SubAgentsFile } from '../agents/types';

export type ContextPolicySelectValue = ContextEnforcementPolicy | 'inherit';

/** Sentinel for per-agent selects — inherit the global Agents default. */
export const INHERIT_CONTEXT_POLICY = 'inherit' as const;

export function isContextEnforcementPolicy(
  value: unknown,
): value is ContextEnforcementPolicy {
  return (
    value === 'compact' ||
    value === 'summarize' ||
    value === 'dropMiddle' ||
    value === 'slide' ||
    value === 'truncate' ||
    value === 'archive'
  );
}

/**
 * Merge layers: explicit user override wins, then global, then shipped builtin.
 * Retired values (summarize, dropMiddle, archive) read as compact; an unknown
 * value falls through to the next layer.
 */
export function resolveContextEnforcementPolicy(layers: {
  userOverride?: ContextEnforcementPolicy | null;
  globalDefault?: ContextEnforcementPolicy | null;
  shippedDefault?: ContextEnforcementPolicy | null;
}): ContextEnforcementPolicy {
  return (
    normalizeContextEnforcementPolicy(layers.userOverride) ??
    normalizeContextEnforcementPolicy(layers.globalDefault) ??
    normalizeContextEnforcementPolicy(layers.shippedDefault) ??
    DEFAULT_CONTEXT_ENFORCEMENT_POLICY
  );
}

/** Settings select value for a stored policy: retired values show as compact. */
function selectValueFor(policy: ContextEnforcementPolicy | null | undefined): ContextPolicySelectValue {
  if (policy === undefined || policy === null) return INHERIT_CONTEXT_POLICY;
  return normalizeContextEnforcementPolicy(policy) ?? INHERIT_CONTEXT_POLICY;
}

/** Effective policy for a work agent at send time. */
export function resolveWorkAgentContextPolicy(agentId: string): ContextEnforcementPolicy {
  const userOverride = getUserWorkAgentOverride(agentId)?.contextEnforcementPolicy;
  const shipped = getBuiltinWorkAgent(agentId)?.contextEnforcementPolicy ?? null;
  return resolveContextEnforcementPolicy({
    userOverride,
    globalDefault: getGlobalContextEnforcementPolicySync(),
    shippedDefault: shipped,
  });
}

/** Settings select value for a work agent (inherit when no user override). */
export function workAgentContextPolicySelectValue(agentId: string): ContextPolicySelectValue {
  return selectValueFor(getUserWorkAgentOverride(agentId)?.contextEnforcementPolicy);
}

/** Settings select value for a sub-agent type (inherit when no user override). */
export function subAgentContextPolicySelectValue(typeId: string): ContextPolicySelectValue {
  return selectValueFor(getSubAgentUserOverridesSync()?.types?.[typeId]?.contextEnforcementPolicy);
}

/** Effective policy for a sub-agent type at spawn time. */
export function resolveSubAgentTypeContextPolicy(
  typeId: string,
  mergedConfig: SubAgentsFile,
  typeConfig: SubAgentTypeConfig,
): ContextEnforcementPolicy {
  const userOverride =
    getSubAgentUserOverridesSync()?.types?.[typeId]?.contextEnforcementPolicy;

  return resolveContextEnforcementPolicy({
    userOverride,
    globalDefault: mergedConfig.defaultContextEnforcementPolicy ?? null,
    shippedDefault: typeConfig.contextEnforcementPolicy ?? null,
  });
}
