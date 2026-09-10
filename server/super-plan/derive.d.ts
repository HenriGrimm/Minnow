import type {
  DraftAddressedClaim,
  ReviewRound,
  RunConfig,
  RunState,
  StageId,
  StageRecord,
} from './types';

/** Pipeline defaults when run.created omits config. */
export const DEFAULT_CONFIG: Readonly<RunConfig>;

/** Fold a journal into run state. Total: never throws, whatever the input. */
export function derive(events: Iterable<unknown>): RunState;

/** The state of a run with no journal at all. */
export function emptyState(): RunState;

/** Fold events into an existing state, in place. */
export function foldInto(state: RunState, events: Iterable<unknown>): RunState;

/** Hand-rolled FNV-1a 32-bit hash (`node:crypto` is banned in the graph core). */
export function fnv1a(input: string): string;

/**
 * Purely-computed finding id:
 * `fnv1a(normalize(title) + '|' + sortedPaths.join(','))`. The id is derived,
 * never journaled, so identical finding text in two rounds yields the same id.
 */
export function findingId(title: string, paths?: readonly unknown[]): string;

/** Normalise one review round's raw findings into the derived shape (computed ids). */
export function normalizeFindings(raw: unknown): ReviewRound['findings'];

/** Ids of the blocking findings in one review round. */
export function blockingFindingIds(round: ReviewRound): string[];

/** Finding ids still open after the latest review round (`open = lastReview.findings`). */
export function openFindingIds(state: RunState): string[];

/** Finding ids resolved by the latest round (`resolved = union(previousRounds) − open`). */
export function resolvedFindingIds(state: RunState): string[];

/**
 * Open/blocking/resolved summary for the latest review round: `blocking` is
 * `open` filtered by severity, `resolved` is the union of previous rounds
 * minus `open`. No counters.
 */
export function currentFindings(state: RunState): { blocking: string[]; resolved: string[] };

/** Normalise a draft's `addressed` claim (findingIds + dispositions). */
export function normalizeAddressed(raw: unknown): DraftAddressedClaim | null;

/** How many ended stage facts a stage has recorded. */
export function stageCount(state: RunState, stage: StageId): number;

/** The most recent ended stage fact for a stage, or undefined. */
export function lastEndedStage(state: RunState, stage: StageId): StageRecord | undefined;

/** How many times the accept gate has rejected the draft. */
export function acceptGateRejections(state: RunState): number;

/** True once the run can do no more work. */
export function isStopped(state: RunState): boolean;
export function polishEnabled(state: import('./types').RunState): boolean;
