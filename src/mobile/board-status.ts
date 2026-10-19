/** Plain-language board and attempt status, shared by the board list and board screen. */

import type { BoardSummary } from '../orchestrator/client';

export type BoardTone = 'live' | 'good' | 'warn' | 'bad' | 'neutral';

/** One status word and tone for a board, shared by the list and the detail header. */
export function boardStatus(summary: Pick<BoardSummary, 'status' | 'stopReason' | 'finished' | 'finalTestFailed' | 'attentionCount'>): {
  label: string;
  tone: BoardTone;
} {
  if (summary.status === 'running') return { label: 'Running', tone: 'live' };
  if (summary.finished) {
    if (summary.finalTestFailed) return { label: 'Final test failed', tone: 'bad' };
    if ((summary.attentionCount ?? 0) > 0) return { label: 'Needs attention', tone: 'warn' };
    return { label: 'Done', tone: 'good' };
  }
  if (summary.status === 'created') return { label: 'Not started', tone: 'neutral' };
  switch (summary.stopReason) {
    case 'paused':
      return { label: 'Paused', tone: 'warn' };
    case 'quota':
      return { label: 'Out of usage', tone: 'bad' };
    case 'terminal':
      return { label: 'Stuck', tone: 'bad' };
    case 'complete':
      return { label: 'Done', tone: 'good' };
    default:
      return { label: 'Stopped', tone: 'neutral' };
  }
}

const OUTCOME_TEXT: Record<string, string> = {
  pass: 'Passed',
  fail: 'Failed',
  blocked: 'Blocked',
  no_report: 'No report',
  crashed: 'Crashed',
  timeout: 'Timed out',
  conflicted: 'Conflicts',
};

export const PHASE_TEXT: Record<string, string> = {
  idle: 'Planned',
  waiting: 'Waiting',
  blocked: 'Blocked',
  building: 'Building',
  testing: 'Testing',
  merging: 'Merging',
  merged: 'Merged',
  abandoned: 'Abandoned',
  skipped: 'Skipped',
  paused: 'Paused',
  stopped: 'Stopped',
};

export function outcomeText(outcome: string | null | undefined): string {
  if (!outcome) return 'Ended';
  return OUTCOME_TEXT[outcome] ?? outcome.replace(/_/g, ' ');
}
