import type { ContextEnforcementPolicy } from '../context-budget';

type NoticePolicy = ContextEnforcementPolicy;
import { toPersistedCompaction } from '../../../server/runner/compaction/index.js';
import type { TurnCompactionEvent } from '../../../server/runner/run-turn';
import type { Chat, ContextNoticeMessage, Message } from '../../types';

export function contextNoticeLabel(
  policy: NoticePolicy,
  droppedTurns: number,
): string {
  const turnPart =
    droppedTurns > 0
      ? ` · ${droppedTurns} turn${droppedTurns === 1 ? '' : 's'} omitted`
      : '';
  switch (policy) {
    case 'compact':
      return `Context compacted${turnPart}`;
    case 'summarize':
      return `Context summarized${turnPart}`;
    case 'dropMiddle':
      return `Context compressed (extractive)${turnPart}`;
    case 'slide':
      return `Context trimmed (slide)${turnPart}`;
    case 'truncate':
      return `Context trimmed (truncate)${turnPart}`;
    case 'archive':
      return `Context archived${turnPart}`;
    default:
      return `Context trimmed${turnPart}`;
  }
}

/** Primary label for the context trim transcript row (tool-call action column). */
export function contextNoticeAction(policy: NoticePolicy): string {
  switch (policy) {
    case 'compact':
      return 'Context compacted';
    case 'summarize':
      return 'Context summarized';
    case 'dropMiddle':
      return 'Context compressed';
    case 'slide':
      return 'Context trimmed';
    case 'truncate':
      return 'Context truncated';
    case 'archive':
      return 'Context archived';
    default:
      return 'Context trimmed';
  }
}

/** Bench-style outcome text for the context trim transcript row. */
export function contextNoticeOutcome(
  droppedTurns: number,
  summaryText?: string,
  droppedRounds = 0,
): string {
  const omitted: string[] = [];
  if (droppedTurns > 0) omitted.push(`${droppedTurns} turn${droppedTurns === 1 ? '' : 's'}`);
  if (droppedRounds > 0) omitted.push(`${droppedRounds} tool round${droppedRounds === 1 ? '' : 's'}`);
  if (omitted.length > 0) {
    return `${omitted.join(' and ')} omitted`;
  }
  if (summaryText?.trim()) {
    const lines = summaryText.trim().split('\n').length;
    return lines === 1 ? '1 line summary' : `${lines} line summary`;
  }
  return 'Trimmed';
}

/**
 * Append a context notice unless the last row is a duplicate (same policy + dropped count).
 */
export function appendContextNoticeIfNeeded(
  chat: Chat,
  params: {
    policy: NoticePolicy;
    droppedTurns: number;
    droppedRounds?: number;
    summaryText?: string;
  },
): void {
  const droppedRounds = params.droppedRounds ?? 0;
  if (params.droppedTurns <= 0 && droppedRounds <= 0 && !params.summaryText?.trim()) return;

  const last = chat.history[chat.history.length - 1];
  if (
    last &&
    last.role === 'context' &&
    last.policy === params.policy &&
    last.droppedTurns === params.droppedTurns &&
    (last.droppedRounds ?? 0) === droppedRounds
  ) {
    return;
  }

  const notice: ContextNoticeMessage = {
    role: 'context',
    policy: params.policy,
    droppedTurns: params.droppedTurns,
    ...(droppedRounds > 0 ? { droppedRounds } : {}),
    summaryText: params.summaryText,
    createdAt: Date.now(),
  };
  chat.history.push(notice);
}

/**
 * Persist an automatic trim on the chat: a UI-only notice row (never sent to
 * the model) plus `lastContextTrim` for the stats panel. Returns whether the
 * trim was worth recording. The notice is appended to `chat.history` directly;
 * the runner persists by cursor over filtered rows, so it shifts no indices.
 */
export function recordContextTrim(
  chat: Chat,
  result: {
    applied: boolean;
    policy: NoticePolicy;
    droppedTurns: number;
    droppedRounds?: number;
    summaryInjected: boolean;
    summaryText?: string;
  },
): boolean {
  if (!result.applied) return false;
  const droppedRounds = result.droppedRounds ?? 0;
  if (result.droppedTurns <= 0 && droppedRounds <= 0 && !result.summaryInjected) return false;
  appendContextNoticeIfNeeded(chat, {
    policy: result.policy,
    droppedTurns: result.droppedTurns,
    droppedRounds,
    summaryText: result.summaryText,
  });
  chat.lastContextTrim = {
    policy: result.policy,
    droppedTurns: result.droppedTurns,
    summaryPreview: result.summaryText?.slice(0, 200),
    at: Date.now(),
  };
  return true;
}

/**
 * Persist a compaction checkpoint as a `context` row. History is never
 * rewritten: folded rows stay (and render) above it, and the next send projects
 * the transcript through this row's `compaction` payload.
 */
export function recordCompactionCheckpoint(chat: Chat, event: TurnCompactionEvent): ContextNoticeMessage {
  const notice: ContextNoticeMessage = {
    role: 'context',
    policy: 'compact',
    droppedTurns: event.droppedTurns,
    ...(event.droppedRounds > 0 ? { droppedRounds: event.droppedRounds } : {}),
    summaryText: event.checkpoint.summary,
    createdAt: Date.now(),
    compaction: toPersistedCompaction(event.checkpoint),
  };
  chat.history.push(notice);
  chat.lastContextTrim = {
    policy: 'compact',
    droppedTurns: event.droppedTurns,
    summaryPreview: event.checkpoint.summary.slice(0, 200),
    at: notice.createdAt,
  };
  return notice;
}

export function isContextNoticeMessage(msg: Message): msg is ContextNoticeMessage {
  return msg.role === 'context';
}
