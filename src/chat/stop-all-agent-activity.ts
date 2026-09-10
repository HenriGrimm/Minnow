import { abortByChatId, streamingChatIds } from '../app-state';
import { cancelSubAgent, listActiveSubAgentRuns } from '../agents/orchestrator';
import { listMainTurnActivity } from './main-turn-activity';
import { isChatStreaming } from './streaming-state';
import { isSuperPlanAdvancing, pauseSuperPlan } from './super-plan/client';
import { flushStoppedChatPresentation } from './flush-stopped-chat-presentation';
import { stopGeneration } from './stop-generation';
import {
  abortChatTitleGeneration,
  listTitleJobInflightChatIds,
} from './titles/inflight';
import { getPlannerChatForGroup, isLeftoverBoardRunning } from '../state/chat-groups';
import { buildAgentActivitySnapshot } from '../state/agent-activity-registry';
import { getChatItemDotContext } from '../ui/chat-item-dot';
import { sessionState } from '../state/sessions';
import {
  cancelResearchRunForShell,
  isResearchRunningForShell,
} from '../research/panel';
import type { ChatGroup, LeftoverBoardTask } from '../types';
import { forceCloseAskQuestionModal } from '../ui/question-cards-modal';

function leftoverBoardHasLiveWork(group: ChatGroup): boolean {
  if (isLeftoverBoardRunning(group)) return true;
  const board = group.orchestrateBoard;
  if (!board) return false;
  return board.tasks.some(
    (t: LeftoverBoardTask) =>
      Boolean(t.chatId?.trim()) &&
      (t.status === 'in_progress' || t.status === 'testing' || t.status === 'merging'),
  );
}

function hasRunningBoardWork(): boolean {
  if (!sessionState) return false;
  for (const group of sessionState.groups ?? []) {
    if (leftoverBoardHasLiveWork(group)) return true;
  }
  return false;
}

function hasActiveSuperPlanWork(): boolean {
  if (!sessionState) return false;
  for (const chat of sessionState.chats) {
    const plan = chat.superPlanView;
    if (!plan || plan.cancelled) continue;
    if (isSuperPlanAdvancing(chat.id) || isChatStreaming(chat.id)) return true;
  }
  return false;
}

function hasAgentActivityPanelRows(): boolean {
  if (!sessionState) return false;
  const rows = buildAgentActivitySnapshot({
    nowMs: Date.now(),
    chats: sessionState.chats,
    mainTurns: listMainTurnActivity(),
    subAgents: listActiveSubAgentRuns(),
    titleJobs: listTitleJobInflightChatIds().map((chatId) => ({
      chatId,
      startedAtMs: Date.now(),
    })),
    questionPendingChatIds: getChatItemDotContext(null).inputPendingChatIds,
  });
  return rows.length > 0;
}

/** True when global stop-all would affect any in-flight agent work. */
export function hasStopAllAgentActivityTargets(): boolean {
  if (isResearchRunningForShell()) return true;
  if (!sessionState) return false;
  if (hasAgentActivityPanelRows()) return true;
  if (hasRunningBoardWork()) return true;
  if (hasActiveSuperPlanWork()) return true;
  if (streamingChatIds.size > 0) return true;
  if (abortByChatId.size > 0) return true;
  return false;
}

/** Chat ids whose in-flight UI should be cleared after a global stop. */
function collectPresentationChatIds(extra?: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>(extra ?? []);
  for (const chatId of streamingChatIds) ids.add(chatId);
  for (const chatId of abortByChatId.keys()) ids.add(chatId);
  for (const turn of listMainTurnActivity()) ids.add(turn.chatId);
  if (sessionState) {
    for (const chat of sessionState.chats) {
      if (chat.currentGenerationId?.trim()) ids.add(chat.id);
    }
  }
  return ids;
}

function flushStoppedAgentPresentation(extraChatIds?: ReadonlySet<string>): void {
  flushStoppedChatPresentation(collectPresentationChatIds(extraChatIds), {
    clearGlobalStreaming: true,
  });
}

/** Best-effort halt of all agent activity; does not pause /loop schedules. */
export function stopAllAgentActivity(): void {
  forceCloseAskQuestionModal();

  const handledChatIds = new Set<string>();

  if (sessionState) {
    for (const group of sessionState.groups ?? []) {
      if (!leftoverBoardHasLiveWork(group)) continue;
      const planner = getPlannerChatForGroup(group);
      if (planner) {
        stopGeneration(planner.id, 'user');
        handledChatIds.add(planner.id);
      }
      for (const task of group.orchestrateBoard?.tasks ?? []) {
        const chatId = task.chatId?.trim();
        if (!chatId) continue;
        stopGeneration(chatId, 'user');
        handledChatIds.add(chatId);
      }
    }

    for (const chat of sessionState.chats) {
      const plan = chat.superPlanView;
      if (!plan || plan.cancelled) continue;
      if (!isSuperPlanAdvancing(chat.id) && !isChatStreaming(chat.id)) continue;
      void pauseSuperPlan(chat).catch((error) => { console.error('[super-plan] Could not pause run:', error); });
      handledChatIds.add(chat.id);
    }
  }

  for (const chatId of streamingChatIds) {
    if (handledChatIds.has(chatId)) continue;
    stopGeneration(chatId, 'user');
  }
  for (const chatId of abortByChatId.keys()) {
    if (handledChatIds.has(chatId)) continue;
    stopGeneration(chatId, 'user');
  }

  for (const run of listActiveSubAgentRuns()) {
    cancelSubAgent(run.runId, 'user_cancel');
  }

  for (const chatId of listTitleJobInflightChatIds()) {
    abortChatTitleGeneration(chatId);
  }

  void cancelResearchRunForShell();

  flushStoppedAgentPresentation(handledChatIds);
}
