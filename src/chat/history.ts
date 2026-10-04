import { hasPostToolTail } from '../tools/turn-continuation';
import { normalizeHistoryTail } from './history-truncate-core';
import type { AssistantMessage, Chat, Message } from '../types';

/** Clone session history and drop incomplete tool tails before API serialization. */
export function copyHistoryForOutboundApi(history: Message[]): Message[] {
  const copy = history.map((m) => ({ ...m }));
  normalizeHistoryTail(copy);
  return copy;
}

/**
 * True when the turn appended any assistant/tool row after the forked user message.
 */
export function turnProducedOutput(history: Message[], forkHistoryIndex: number): boolean {
  if (forkHistoryIndex < 0 || forkHistoryIndex >= history.length) {
    return false;
  }
  if (history[forkHistoryIndex]?.role !== 'user') {
    return false;
  }
  return history.length > forkHistoryIndex + 1;
}

export function rollbackFailedTurnHistory(chat: Chat, forkHistoryIndex: number): boolean {
  if (forkHistoryIndex < 0 || forkHistoryIndex >= chat.history.length) {
    return false;
  }
  const userRow = chat.history[forkHistoryIndex];
  if (userRow?.role !== 'user') {
    return false;
  }
  const keepThrough = forkHistoryIndex + 1;
  if (chat.history.length <= keepThrough) {
    return false;
  }
  chat.history = chat.history.slice(0, keepThrough);
  normalizeHistoryTail(chat.history);
  return true;
}

/** True when this row is the partial assistant output a failed turn left behind. */
function isFailedAssistantRow(row: Message | undefined): row is AssistantMessage {
  return row?.role === 'assistant' && (row as AssistantMessage).failed === true;
}

export function indexOfFailedAssistantAfter(
  history: Message[],
  forkHistoryIndex: number,
): number {
  if (forkHistoryIndex < 0 || forkHistoryIndex >= history.length) return -1;
  if (history[forkHistoryIndex]?.role !== 'user') return -1;
  for (let i = forkHistoryIndex + 1; i < history.length; i += 1) {
    if (isFailedAssistantRow(history[i])) return i;
  }
  return -1;
}

export function indexOfLastFailedAssistantAtTail(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row?.role === 'user') return -1;
    if (isFailedAssistantRow(row)) return i;
  }
  return -1;
}

/** Acknowledge a continued turn's failure while preserving all of its output. */
export function acknowledgeFailedAssistantOutput(history: Message[]): boolean {
  let changed = false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row?.role === 'user') break;
    if (isFailedAssistantRow(row)) {
      delete row.failed;
      changed = true;
    }
  }
  return changed;
}

export function clearFailedAssistantOutput(
  chat: Chat,
  forkHistoryIndex: number,
): boolean {
  const failedAt = indexOfFailedAssistantAfter(chat.history, forkHistoryIndex);
  if (failedAt < 0) return false;
  chat.history = chat.history.slice(0, failedAt);
  normalizeHistoryTail(chat.history);
  return true;
}

/**
 * Drop orphan tool tails from persisted history (incomplete tool_call chains).
 *
 * A *paired* tool tail is real turn context — a Stop mid tool batch leaves one —
 * so it survives. Only chains the provider would reject are trimmed.
 */
export function repairSessionHistoryTail(chat: Chat): boolean {
  if (!hasPostToolTail(chat.history)) {
    return false;
  }
  const before = chat.history.length;
  normalizeHistoryTail(chat.history);
  return chat.history.length !== before;
}
