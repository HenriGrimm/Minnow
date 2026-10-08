import type { Chat, TurnRunRecord } from '../types';
import { isHiddenTranscriptUserMessage } from './hidden-transcript-user-messages';
import { apiMessageContentToText } from '../api/message-content';

export interface TranscriptTurn {
  fork: number;
  end: number;
  finalIndex: number | null;
  /** Reply parts since the last work call, including prose around bookkeeping. */
  finalIndices: number[];
  toolCount: number;
  run?: TurnRunRecord;
}

/** These calls record completed work without starting another work step. */
const REPLY_BOOKKEEPING_TOOLS = new Set(['save_memory', 'todo_write']);

/** Presentation boundaries only: never rewrite or compact the model's history. */
export function collectTranscriptTurns(chat: Chat): TranscriptTurn[] {
  if (chat.historyLoaded === false) return [];
  const turns: TranscriptTurn[] = [];
  let turn: TranscriptTurn | undefined;
  for (let i = 0; i < chat.history.length; i++) {
    const msg = chat.history[i];
    if (msg.role === 'user' && !isHiddenTranscriptUserMessage(msg)) {
      turn = { fork: i, end: i, finalIndex: null, finalIndices: [], toolCount: 0 };
      turns.push(turn);
    }
    if (!turn) continue;
    turn.end = i;
    if (msg.role === 'assistant') {
      if ('tool_calls' in msg && msg.tool_calls?.length) {
        turn.toolCount += msg.tool_calls.length;
        if (!msg.tool_calls.every((call) => REPLY_BOOKKEEPING_TOOLS.has(call.function.name))) {
          turn.finalIndices = [];
          turn.finalIndex = null;
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
  return turns;
}

export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
