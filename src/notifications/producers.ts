/**
 * Wire notification producers to sub-agent and background job events.
 *
 * Board completion toasts come from the V2 journal (`run.finished` and task
 * attempt events on the server), not from leftover `ChatGroup.orchestrateBoard`
 * mutation hooks. MIN-714 deleted those lifecycle producers — a sleeping
 * window is not a correctness problem for the engine.
 *
 * Chat turn alerts are pushed from {@link notifyChatTurnEnded} in `run-turn-chat.ts` after finalizeRun.
 */

import { isSubAgentRunTerminal } from '../agents/sub-agent-outcome.ts';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events.ts';
import type { SubAgentRun } from '../agents/types.ts';
import { onGenerationQuotaExceeded } from '../api/generations.ts';
import { findChatById, sessionState } from '../state/sessions.ts';
import { truncatePreview } from './preview.ts';
import { noticeOutOfUsage } from './provider-quota.ts';
import { pushNotification, pushNotificationOrActiveChatSound } from './push.ts';
import { subscribeManagedChatMetadata } from '../chat/managed-chat-view';
import { createManagedChatNotificationProducer } from './managed-chat';

let initialized = false;
const notifiedSubAgentRuns = new Set<string>();
let disposeProducers: (() => void) | undefined;

function chatTitle(chat: { name?: string }): string {
  return chat.name?.trim() || 'Chat';
}

function handleSubAgentRun(run: SubAgentRun): void {
  if (run.childChatId) return;
  if (!isSubAgentRunTerminal(run.status)) return;
  if (notifiedSubAgentRuns.has(run.runId)) return;
  notifiedSubAgentRuns.add(run.runId);

  const parentChatId = run.parentChatId?.trim();
  const chat = parentChatId ? findChatById(parentChatId) : undefined;
  const title = chat ? chatTitle(chat) : 'Sub-agent';
  const dedupeKey = `subagent:${run.runId}`;
  const parent = run.parentTurnId ? chat?.runs?.find((candidate) => candidate.parentTurnId === run.parentTurnId) : undefined;
  const source = {
    activityId: `sub:${run.runId}`,
    parentActivityId: parent ? `turn:${parent.runId}` : undefined,
    workspacePath: chat?.workspacePath,
    silent: parent?.status === 'running' || (!run.parentTurnId && chat?.runs?.some((candidate) => candidate.status === 'running')),
  };

  if (run.status === 'completed') {
    const preview = truncatePreview(run.summary || 'Sub-agent completed');
    pushNotification({
      ...source,
      kind: 'sub_agent_complete',
      title,
      preview,
      chatId: parentChatId ?? undefined,
      appId: 'code',
      dedupeKey,
    });
    return;
  }

  const preview = truncatePreview(run.error || run.summary || `Sub-agent ${run.status}`);
  pushNotification({
    ...source,
    activityStatus: run.status === 'cancelled' ? 'stopped' : 'failed',
    kind: 'sub_agent_failed',
    title,
    preview,
    chatId: parentChatId ?? undefined,
    appId: 'code',
    dedupeKey,
  });
}

/** Register notification event producers (call once from main.ts). */
export function initNotificationProducers(): () => void {
  if (initialized) return disposeNotificationProducers;
  initialized = true;
  const disposers = [subscribeSubAgentRuns(handleSubAgentRun), onGenerationQuotaExceeded((event) => noticeOutOfUsage(event)),
    createManagedChatNotificationProducer({ chats: () => sessionState?.chats ?? [], subscribe: subscribeManagedChatMetadata,
      push: pushNotification, pushOutcome: pushNotificationOrActiveChatSound })];
  disposeProducers = () => disposers.forEach(dispose => dispose());
  return disposeNotificationProducers;
}

export function disposeNotificationProducers(): void { disposeProducers?.(); disposeProducers = undefined; initialized = false; }

/** Reset producer state (tests). */
export function resetNotificationProducersForTests(): void {
  disposeNotificationProducers();
  notifiedSubAgentRuns.clear();
}

/** Exported for unit tests. */
export const __testHooks = {
  handleSubAgentRun,
};
