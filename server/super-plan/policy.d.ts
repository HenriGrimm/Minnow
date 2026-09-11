import type { Action } from './types';

/** Failed attempts a stage gets before the policy stops retrying it. */
export const RETRY_LIMIT: number;

/** The routing table, as data. */
export const POLICY_TABLE: ReadonlyArray<{
  stages: 'any' | 'optional' | 'required';
  under: number | null;
  action: Action;
}>;

/** Retry below the limit, then skip optional stages and halt on required ones. */
export function decide(input: { stage: string; outcome: string; attemptCount: number }): Action;

/** Render the table as markdown, so tests compare rather than restate. */
export function formatPolicyTable(): string;

export type { Action };
