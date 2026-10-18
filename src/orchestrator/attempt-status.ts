import type { Attempt, BoardState } from '../../server/orchestrator/core/types';

/** Open attempts survive pause; manual attempts can run on an otherwise stopped board. */
export function attemptInterruption(state: BoardState, attempt: Attempt): 'paused' | 'stopped' | null {
  if (attempt.ended) return null;
  if (state.stopReason === 'paused') return 'paused';
  return state.status !== 'running' && !attempt.manual ? 'stopped' : null;
}
