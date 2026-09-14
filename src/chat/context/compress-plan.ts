import { partitionTurns } from '../context-budget';
import { isUiOnlyTranscriptRole } from './injection-notice';
import type { ApiMessage, Message } from '../../types';

export interface CompressPlan {
  /** Model-visible history rows (UI-only notice rows removed). */
  transcript: Message[];
  /** Whole turns folded into the summary. */
  droppedTurns: number;
  /** Text of the folded turns, oldest first. */
  droppedText: string;
  /** Rows kept verbatim after the summary, in order. */
  kept: Message[];
}

function historyRowText(row: Message): string {
  if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') return '';
  const content = (row as { content?: unknown }).content;
  if (typeof content === 'string') return content.trim();
  if (content == null) return '';
  return JSON.stringify(content).trim();
}

/**
 * Split history for `/compress`: keep the last `minRecentTurns` turns verbatim,
 * fold the rest. Partitions the history rows themselves — a tool row with
 * screenshots is one history row but two API rows, so partitioning API rows
 * and indexing history rows kept the wrong rows after the first screenshot.
 * Returns null when there is nothing older than the kept turns.
 */
export function planCompress(history: Message[], minRecentTurns: number): CompressPlan | null {
  const transcript = history.filter((m) => !isUiOnlyTranscriptRole(m.role));
  // History rows carry the same role / tool_calls shape the partitioner reads.
  const turns = partitionTurns(transcript as unknown as ApiMessage[], 0);
  const keep = Math.max(1, Math.floor(minRecentTurns));
  if (turns.length <= keep) return null;

  const droppedTurns = turns.length - keep;
  const chunks: string[] = [];
  for (const turn of turns.slice(0, droppedTurns)) {
    const parts = transcript.slice(turn.start, turn.end).map(historyRowText).filter(Boolean);
    if (parts.length) chunks.push(parts.join('\n\n'));
  }
  return {
    transcript,
    droppedTurns,
    droppedText: chunks.join('\n\n'),
    kept: transcript.slice(turns[droppedTurns].start),
  };
}
