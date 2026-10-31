import type { Chat } from '../types';
import { getChatLastMessageAt } from './session-workspace-scope';

export const AGENT_CHILD_PAGE_SIZE = 8;
export const AGENT_VISUAL_DEPTH_LIMIT = 3;

export interface ChatRelationships {
  roots: Chat[];
  children: ReadonlyMap<string, readonly Chat[]>;
  parentById: ReadonlyMap<string, string>;
  byId: ReadonlyMap<string, Chat>;
  ancestors(chatId: string): Chat[];
}

/** Navigation is a projection of lightweight shells, never their transcripts. */
export function projectChatRelationships(chats: readonly Chat[]): ChatRelationships {
  const byId = new Map(chats.map(chat => [chat.id, chat]));
  const parentById = new Map<string, string>();
  for (const chat of byId.values()) {
    const relation = chat.agentConversation;
    const parentId = relation?.parentChatId;
    if (relation?.version === 1 && relation.childChatId === chat.id && parentId && parentId !== chat.id && byId.has(parentId)) parentById.set(chat.id, parentId);
  }
  // Imported cycles are displayed once by promoting one deterministic member.
  const visited = new Set<string>();
  for (const chat of byId.values()) {
    const path: string[] = [], indexes = new Map<string, number>();
    let id: string | undefined = chat.id;
    while (id && !visited.has(id)) {
      const cycleAt = indexes.get(id);
      if (cycleAt !== undefined) { parentById.delete(path.slice(cycleAt).sort()[0]!); break; }
      indexes.set(id, path.length); path.push(id); id = parentById.get(id);
    }
    for (const entry of path) visited.add(entry);
  }
  const roots: Chat[] = [], children = new Map<string, Chat[]>();
  for (const chat of byId.values()) {
    const parentId = parentById.get(chat.id);
    if (!parentId) roots.push(chat);
    else { const siblings = children.get(parentId) ?? []; siblings.push(chat); children.set(parentId, siblings); }
  }
  return { roots, children, parentById, byId, ancestors(chatId) {
    const path: Chat[] = [];
    let id = parentById.get(chatId);
    while (id) { path.push(byId.get(id)!); id = parentById.get(id); }
    return path.reverse();
  } };
}

export function chatReadOnlyReason(chat: Chat): string | null {
  const relation = chat.agentConversation;
  if (!relation) return null;
  if (relation.origin === 'native') return 'This native agent conversation is available for inspection. Continue it in its original host.';
  if (chat.chatCommandVersion !== 1 || relation.capabilities?.canSend !== true) return 'This saved agent conversation is inspect-only. Open its parent to start new work.';
  return null;
}

/** Canonical and imported agent transcripts cannot be rewritten by legacy local branch helpers. */
export function supportsLocalHistoryMutation(chat: Chat): boolean {
  return chat.chatCommandVersion !== 1 && !chat.agentConversation;
}

export const CANONICAL_HISTORY_HINT = 'This conversation keeps its saved history. Send a new message to continue.';

const unsettled = new Set(['accepted', 'queued', 'running', 'loading_model', 'waiting', 'waiting_for_host', 'waiting_for_model', 'waiting_for_capacity', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_question', 'waiting_for_approval', 'stopping', 'recovery_required']);

export function hasUnsettledAgentWork(chat: Chat, isRunning: (chatId: string) => boolean = () => false): boolean {
  const requests = chat.agentRequestSummary ?? chat.agentRequests?.filter(request => request.state === 'pending');
  return isRunning(chat.id) || unsettled.has(chat.agentExecution?.status ?? '') || Boolean(chat.agentPendingCommand) || Boolean(requests?.length) || Boolean(chat.pendingMessageQueue?.length);
}

/** Waiting and queued work remain visible without claiming to be generating. */
export function isAgentChatActive(chat: Chat, isRunning: (chatId: string) => boolean = () => false): boolean {
  return hasUnsettledAgentWork(chat, isRunning) || chat.turnError === true || chat.unread === true;
}

export function agentChatStatusLabel(chat: Chat, isRunning: (chatId: string) => boolean = () => false): string {
  if (chatReadOnlyReason(chat)) return 'Inspect only';
  const requests = chat.agentRequestSummary ?? chat.agentRequests?.filter(request => request.state === 'pending');
  if (requests?.some(request => request.kind === 'approval')) return 'Needs approval';
  if (requests?.length) return 'Needs your answer';
  if (chat.agentPendingCommand?.errorCode === 'capability_unavailable') return 'Waiting for host';
  if (chat.agentPendingCommand?.held) return 'Queued · paused';
  const status = chat.agentExecution?.status;
  if (status === 'recovery_required') return 'Needs recovery';
  if (status === 'failed' || chat.turnError) return 'Failed';
  if (status === 'waiting_for_host') return 'Waiting for host';
  if (status === 'waiting_for_model' || status === 'waiting_for_capacity') return 'Waiting for model';
  if (status === 'waiting_for_agents') return 'Waiting for agents';
  if (status === 'waiting_for_question' || status === 'waiting_for_input') return 'Needs your answer';
  if (status === 'waiting_for_approval') return 'Needs approval';
  if (status === 'waiting') return 'Waiting';
  if (status === 'loading_model') return 'Loading model';
  if (status === 'stopping') return 'Stopping';
  if (isRunning(chat.id) || status === 'running') return 'Working';
  if (chat.agentPendingCommand || chat.pendingMessageQueue?.length || status === 'queued' || status === 'accepted') return 'Queued';
  if (status === 'stopped' || status === 'cancelled') return 'Stopped';
  if (status === 'completed' || status === 'settled') return 'Complete';
  return 'Ready';
}

export function sortAgentChats(chats: readonly Chat[], priorityIds: ReadonlySet<string> = new Set()): Chat[] {
  return [...chats].sort((a, b) => Number(priorityIds.has(b.id)) - Number(priorityIds.has(a.id)) ||
    getChatLastMessageAt(b) - getChatLastMessageAt(a) || a.id.localeCompare(b.id));
}

export function chatLink(chatId: string): string { return `#/app/code/chat?chatId=${encodeURIComponent(chatId)}`; }

/** Reject ambiguous duplicate ids instead of navigating to a different conversation. */
export function chatIdFromLink(hash: string): string | null {
  const match = hash.match(/^#\/app\/code\/chat\?([^#]*)$/);
  if (!match) return null;
  const ids = new URLSearchParams(match[1]).getAll('chatId');
  return ids.length === 1 && /^[A-Za-z0-9_-]{1,160}$/.test(ids[0]!) ? ids[0]! : null;
}
