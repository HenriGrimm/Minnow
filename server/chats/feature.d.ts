import type { AgentConversationsFeature, OrdinaryChatExecutionFeature } from './contracts.js';

export const AGENT_CONVERSATIONS_RELEASED: true;
export function getOrdinaryChatExecutionFeature(env?: Readonly<Record<string, string | undefined>>): Readonly<OrdinaryChatExecutionFeature>;
export function getAgentConversationsFeature(
  env?: Readonly<Record<string, string | undefined>>,
): Readonly<AgentConversationsFeature>;
