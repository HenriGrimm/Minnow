import type { Action, PolicyRow, StageId } from './types';

/**
 * The routing table, as data. Rows are matched top to bottom; the first whose
 * stage, outcome, and attempt bound match wins. `under: n` means
 * `attemptCount < n`; `under: null` is that row's fallback.
 *
 * Routing summary: ok → accept; crashed/timeout < 3 attempts → retry;
 * interview/spec/draft retries exhausted → fail run; research/polish/review
 * retries exhausted → skip; draft rejected by the accept gate < 2 → retry with
 * the errors in the seed; gate expired → stop.
 */
export const POLICY_TABLE: readonly PolicyRow[];

/** What happens next. Total over every stage, outcome, and attempt count. */
export function decide(input: {
  stage: string;
  outcome: string;
  attemptCount: number;
}): Action;

/** Render the table as markdown, so tests compare rather than restate. */
export function formatPolicyTable(): string;

export type { Action, PolicyRow, StageId };
