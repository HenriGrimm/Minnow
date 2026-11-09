import type { Chat } from '../types';
import { getWorkAgent } from './work-agent-registry';
import type { WorkAgentDefinition } from './work-agent-types';

export function isPassthroughWorkAgentId(agentId: string | null | undefined): boolean {
  return !agentId || agentId === 'default';
}

export function resolveActiveWorkAgent(chat: Chat): WorkAgentDefinition | null {
  const auto = chat.workAgentAuto !== false;

  if (!auto && chat.workAgentId) {
    const pinned = getWorkAgent(chat.workAgentId);
    return pinned && !pinned.disabled ? pinned : null;
  }

  if (chat.workAgentId && !isPassthroughWorkAgentId(chat.workAgentId)) {
    const pinned = getWorkAgent(chat.workAgentId);
    if (pinned && !pinned.disabled) return pinned;
  }

  // One agent: chats no longer pick a work agent from their mode. Only an
  // explicitly pinned agent (board lanes, the UI designer) adds a role part.
  return null;
}

export function resolveActiveWorkAgentId(chat: Chat): string | null {
  const agent = resolveActiveWorkAgent(chat);
  if (!agent || isPassthroughWorkAgentId(agent.id)) return null;
  return agent.id;
}
