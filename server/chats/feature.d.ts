import type { AgentConversationsFeature } from './contracts.js';

export const AGENT_CONVERSATIONS_RELEASED: true;
export function getAgentConversationsFeature(
  env?: Readonly<Record<string, string | undefined>>,
): Readonly<AgentConversationsFeature>;
