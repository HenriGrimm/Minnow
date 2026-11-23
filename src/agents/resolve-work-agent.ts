import type { Chat } from '../types';
import { getWorkAgent } from './work-agent-registry';
import type { WorkAgentDefinition } from './work-agent-types';
import { UI_DESIGNER_AGENT_ID } from './ui-designer/constants';

export function isPassthroughWorkAgentId(agentId: string | null | undefined): boolean {
  return !agentId || agentId === 'default';
}

export function pinnedWorkAgentId(chat: Chat): string | null {
  const id = chat.workAgentId;
  if (!id) return null;
  if (chat.workAgentAuto === false) return id;
  // Older ordinary chats stored their mode's role with workAgentAuto enabled.
  if (isPassthroughWorkAgentId(id)) return null;
  return id === UI_DESIGNER_AGENT_ID || chat.boardGroupId?.trim() || chat.boardTaskId?.trim() ? id : null;
}

export function resolveActiveWorkAgent(chat: Chat): WorkAgentDefinition | null {
  const id = pinnedWorkAgentId(chat);
  const pinned = id ? getWorkAgent(id) : null;
  return pinned && !pinned.disabled ? pinned : null;
}

export function resolveActiveWorkAgentId(chat: Chat): string | null {
  const agent = resolveActiveWorkAgent(chat);
  if (!agent || isPassthroughWorkAgentId(agent.id)) return null;
  return agent.id;
}
