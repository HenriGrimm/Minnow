import { resolveActiveWorkAgent } from '../../agents/resolve-work-agent';
import {
  getGlobalContextCompactionSync,
  getGlobalContextEnforcementPolicySync,
} from '../../agents/sub-agent-config';
import {
  agentContextBudgetFromWorkAgent,
  withCompactionDefaults,
  type AgentContextBudgetConfig,
} from '../context-budget';
import { resolveContextEnforcementPolicy, resolveWorkAgentContextPolicy } from '../resolve-context-policy';
import type { Chat } from '../../types';

/**
 * The context budget a main-chat send runs with: the active work agent's
 * resolved policy (user override → global → shipped) plus the global compaction
 * knobs. The send, `/compact` and the context ring all read this one function,
 * so the ring predicts the trim the send takes.
 */
export function resolveChatContextBudget(chat: Chat): AgentContextBudgetConfig {
  const workAgent = resolveActiveWorkAgent(chat);
  const base = workAgent
    ? agentContextBudgetFromWorkAgent(workAgent, resolveWorkAgentContextPolicy(workAgent.id))
    : { enforcementPolicy: resolveContextEnforcementPolicy({ globalDefault: getGlobalContextEnforcementPolicySync() }) };
  return withCompactionDefaults(base, getGlobalContextCompactionSync());
}
