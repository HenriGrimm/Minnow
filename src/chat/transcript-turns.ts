import type { Chat, TurnRunRecord } from '../types';
import { isHiddenTranscriptUserMessage, isSubAgentResumeUserMessage } from './hidden-transcript-user-messages';
import { apiMessageContentToText } from '../api/message-content';
import { isToolResultFailure } from '../lib/tool-result-failure';

export interface TranscriptTurn {
  fork: number;
  end: number;
  finalIndex: number | null;
  /** Reply parts from each execution in this work group, in transcript order. */
  finalIndices: number[];
  /** Leading reply parts delivered before an agent handoff. */
  settledReplyCount: number;
  toolCount: number;
  run?: TurnRunRecord;
  workDurationMs?: number;
  executionStatus?: NonNullable<Chat['agentExecution']>['status'];
}

/** These calls record completed work without starting another work step. */
const REPLY_BOOKKEEPING_TOOLS = new Set(['save_memory', 'memory_save', 'todo_write']);

/** Presentation boundaries only: never rewrite or compact the model's history. */
export function collectTranscriptTurns(chat: Chat): TranscriptTurn[] {
  if (chat.historyLoaded === false) return [];
  const turns: TranscriptTurn[] = [];
  const byCommand = new Map<string, TranscriptTurn>();
  const pendingToolIds = new Set<string>();
  let turn: TranscriptTurn | undefined;
  for (let i = 0; i < chat.history.length; i++) {
    const msg = chat.history[i];
    if (msg.role === 'user') {
      const hidden = isHiddenTranscriptUserMessage(msg);
      const delegationResult = msg.provenance?.kind === 'delegation_result';
      const agentHandoff = delegationResult || (hidden && isSubAgentResumeUserMessage(msg))
        || (msg.steer && msg.provenance?.kind === 'peer_message');
      // Steering and automatic agent handoffs extend the original work group.
      if ((!hidden || delegationResult) && (!turn || !msg.steer && !agentHandoff)) {
        turn = { fork: i, end: i, finalIndex: null, finalIndices: [], settledReplyCount: 0, toolCount: 0 };
        turns.push(turn);
        pendingToolIds.clear();
      }
      if (!turn) continue;
      if (msg.provenance?.source === 'factory' && Array.isArray(msg.factoryTools)) turn.toolCount += msg.factoryTools.filter(tool => !tool.failed).length;
      if (msg.commandId) byCommand.set(msg.commandId, turn);
      if (msg.workStatus) turn.executionStatus = msg.workStatus;
      if (typeof msg.workDurationMs === 'number' && Number.isFinite(msg.workDurationMs) && msg.workDurationMs >= 0) {
        turn.workDurationMs = (turn.workDurationMs ?? 0) + msg.workDurationMs;
      }
      if (agentHandoff) {
        turn.settledReplyCount = turn.finalIndices.length;
      } else if (msg.steer) {
        turn.finalIndices.length = turn.settledReplyCount;
        turn.finalIndex = turn.finalIndices.at(-1) ?? null;
      }
    }
    if (!turn) continue;
    turn.end = i;
    if (msg.role === 'tool' && pendingToolIds.delete(msg.tool_call_id) && isToolResultFailure(msg.content)) {
      turn.toolCount--;
    }
    if (msg.role === 'assistant') {
      if ('tool_calls' in msg && msg.tool_calls?.length) {
        turn.toolCount += msg.tool_calls.length;
        for (const call of msg.tool_calls) pendingToolIds.add(call.id);
        if (!msg.tool_calls.every((call) => REPLY_BOOKKEEPING_TOOLS.has(call.function.name))) {
          turn.finalIndices.length = turn.settledReplyCount;
          turn.finalIndex = turn.finalIndices.at(-1) ?? null;
          continue;
        }
      }
      if (apiMessageContentToText(msg.content).trim()) {
        turn.finalIndices.push(i);
        turn.finalIndex = i;
      }
    }
  }
  const byFork = new Map(turns.map((item) => [item.fork, item]));
  for (const run of chat.runs ?? []) {
    const item = byFork.get(run.forkHistoryIndex);
    if (!item || run.status === 'superseded') continue;
    const branch = chat.activeBranchByFork?.[String(item.fork)];
    if (branch && run.branchId !== branch) continue;
    if (!item.run || run.createdAt >= item.run.createdAt) item.run = run;
  }
  const execution = chat.agentExecution;
  if (execution?.commandId) {
    const current = byCommand.get(execution.commandId);
    if (current) current.executionStatus = execution.status;
  }
  return turns;
}

export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
