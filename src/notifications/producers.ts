/**
 * Wire notification producers to sub-agent and background job events.
 *
 * Board completion toasts come from the V2 journal (`run.finished` and task
 * attempt events on the server), not from leftover `ChatGroup.orchestrateBoard`
 * mutation hooks. MIN-714 deleted those lifecycle producers — a sleeping
 * window is not a correctness problem for the engine.
 *
 * Chat turn alerts are pushed from {@link notifyChatTurnEnded} in `loop.ts` after finalizeRun.
 */

import { isSubAgentRunTerminal } from '../agents/sub-agent-outcome.ts';
import { subscribeSubAgentRuns } from '../agents/sub-agent-events.ts';
import type { SubAgentRun } from '../agents/types.ts';
import { onGenerationQuotaExceeded } from '../api/generations.ts';
import { findChatById } from '../state/sessions.ts';
import { truncatePreview } from './preview.ts';
import { noticeOutOfUsage } from './provider-quota.ts';
import { pushNotification } from './push.ts';

let initialized = false;
const notifiedSubAgentRuns = new Set<string>();

function chatTitle(chat: { name?: string }): string {
  return chat.name?.trim() || 'Chat';
}

function handleSubAgentRun(run: SubAgentRun): void {
  if (!isSubAgentRunTerminal(run.status)) return;
  if (notifiedSubAgentRuns.has(run.runId)) return;
  notifiedSubAgentRuns.add(run.runId);

  const parentChatId = run.parentChatId?.trim();
  const chat = parentChatId ? findChatById(parentChatId) : undefined;
  const title = chat ? chatTitle(chat) : 'Sub-agent';
  const dedupeKey = `subagent:${run.runId}`;

  if (run.status === 'completed') {
    const preview = truncatePreview(run.summary || 'Sub-agent completed');
    pushNotification({
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
    kind: 'sub_agent_failed',
    title,
    preview,
    chatId: parentChatId ?? undefined,
    appId: 'code',
    dedupeKey,
  });
}

/** Register notification event producers (call once from main.ts). */
export function initNotificationProducers(): void {
  if (initialized) return;
  initialized = true;
  subscribeSubAgentRuns(handleSubAgentRun);
  onGenerationQuotaExceeded((event) => noticeOutOfUsage(event));
}

/** Reset producer state (tests). */
export function resetNotificationProducersForTests(): void {
  initialized = false;
  notifiedSubAgentRuns.clear();
}

/** Exported for unit tests. */
export const __testHooks = {
  handleSubAgentRun,
};
