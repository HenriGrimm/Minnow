import type { RunState, StageAttempt } from './types';

export const PIPELINE: readonly ['interview', 'spec', 'research', 'draft', 'review', 'polish', 'accept'];

export function attemptLabel(state: RunState, attempt: StageAttempt): string;

export function runStatus(
  state: RunState,
): 'running' | 'waiting' | 'paused' | 'halted' | 'done' | 'cancelled' | 'failed' | 'legacy' | 'created';

export function displayTitle(state: RunState): string;

/** Everything the page renders. The wire shape is `SuperPlanRunView` in `src/chat/super-plan/types.ts`. */
export function projectRunView(
  state: RunState,
  extra?: { seq?: number; startFailure?: { message: string; consecutive: number } | null },
): Record<string, any>;

/** The compact summary stored on the chat row. */
export function projectChatSummary(state: RunState, extra?: { seq?: number }): Record<string, any>;
