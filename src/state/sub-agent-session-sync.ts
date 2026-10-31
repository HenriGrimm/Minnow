/**
 * Persists terminal sub-agent transcripts on the parent chat when runs settle,
 * so the drawer can reopen transcripts after session reload (the in-memory
 * orchestrator map may be empty then).
 */

import { subscribeSubAgentRuns } from '../agents/sub-agent-events';
import type { SubAgentRun } from '../agents/types';
import type { PersistedSubAgentRun, PersistedSubAgentStatus } from '../types';
import { findChatById, scheduleSaveSessions, touchChat } from './sessions';

/** Max messages stored per run to keep `state.json` bounded. */
const MAX_PERSISTED_MESSAGES = 50;

let persistenceInitialized = false;

function isTerminalStatus(status: string): status is PersistedSubAgentStatus {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

/** Deep-clone and cap message list for JSON persistence. */
function capMessages(messages: SubAgentRun['messages']): unknown[] {
  const slice =
    messages.length <= MAX_PERSISTED_MESSAGES
      ? messages
      : messages.slice(-MAX_PERSISTED_MESSAGES);
  return JSON.parse(JSON.stringify(slice)) as unknown[];
}

/** Upserts one settled run into the owning chat and schedules a session save. */
export function persistSubAgentRunSnapshot(run: SubAgentRun): void {
  const chatId = run.parentChatId;
  if (!chatId || !isTerminalStatus(run.status)) return;

  const chat = findChatById(chatId);
  if (!chat) return;

  const row: PersistedSubAgentRun = {
    runId: run.runId,
    ...(run.commandId ? { commandId: run.commandId } : {}),
    ...(run.modelOptions ? { modelOptions: run.modelOptions } : {}),
    ...(run.phase ? { phase: run.phase } : {}),
    ...(run.journalOwnerId ? { journalOwnerId: run.journalOwnerId } : {}),
    ...(run.completionPolicy ? { completionPolicy: run.completionPolicy } : {}),
    ...(run.childChatId ? { childChatId: run.childChatId } : {}),
    ...(run.executionId ? { executionId: run.executionId } : {}),
    parentTurnId: run.parentTurnId ?? '',
    ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
    type: run.type,
    modelSource: run.modelSource,
    resolvedModel: run.resolvedModel,
    providerId: run.providerId,
    modelId: run.modelId,
    task: run.task,
    status: run.status,
    summary: run.summary,
    ...(run.structuredOutcome ? { structuredOutcome: run.structuredOutcome } : {}),
    ...(run.budgetEvents?.length ? { budgetEvents: run.budgetEvents } : {}),
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    toolTurns: run.toolTurns,
    messages: run.childChatId ? [] : capMessages(run.messages),
    ...(run.category ? { category: run.category } : {}),
    ...(run.boardTaskId !== undefined ? { boardTaskId: run.boardTaskId } : {}),
  };

  const prev = chat.subAgentRuns ?? [];
  const idx = prev.findIndex((r) => r.runId === run.runId);
  const next = idx >= 0 ? [...prev] : [...prev, row];
  if (idx >= 0) next[idx] = row;
  chat.subAgentRuns = next;
  touchChat(chat);
  scheduleSaveSessions();
}

/** Subscribe once: persist terminal runs onto the parent chat blob. */
export function initSubAgentSessionPersistence(): void {
  if (persistenceInitialized) return;
  persistenceInitialized = true;
  subscribeSubAgentRuns((run) => {
    if (isTerminalStatus(run.status)) {
      persistSubAgentRunSnapshot(run);
    }
  });
}

/** Test helper: allow re-binding the persistence subscriber. */
export function resetSubAgentSessionPersistenceForTests(): void {
  persistenceInitialized = false;
}
