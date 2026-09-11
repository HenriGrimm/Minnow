import type {
  DraftAddressedClaim,
  FindingSeverity,
  QuestionRecord,
  ReviewFinding,
  ReviewRound,
  RunConfig,
  RunState,
  StageAttempt,
  StageId,
  StageRecord,
} from './types';

/** Journals written by this engine carry `config.engine: 3` on `run.created`. */
export const ENGINE_VERSION: number;

/** Pipeline defaults when run.created omits config. */
export const DEFAULT_CONFIG: Readonly<RunConfig>;

/** Consecutive failures a stage gets before it is skipped or halts the run. */
export const MAX_STAGE_FAILURES: number;

/** Fold a journal into run state. Total: never throws, whatever the input. */
export function derive(events: Iterable<unknown>): RunState;

/** The state of a run with no journal at all. */
export function emptyState(): RunState;

/** Fold events into an existing state, in place. */
export function foldInto(state: RunState, events: Iterable<unknown>): RunState;

/** Review rounds the current cycle may run. */
export function reviewCycleLimit(state: RunState): number;

/** Review rounds recorded in the current cycle. */
export function reviewsInCycle(state: RunState): ReviewRound[];

/** Failed attempts of a stage since its budget last reset. */
export function consecutiveFailures(state: RunState, stage: StageId): number;

/** Hand-rolled FNV-1a 32-bit hash (`node:crypto` is banned in the pure core). */
export function fnv1a(input: string): string;

/** Id for a finding the reviewer did not name. */
export function findingId(title: string, paths?: readonly unknown[]): string;

export function normalizeSeverity(severity: unknown): FindingSeverity;

/** Normalise one review round's raw findings, keeping reviewer-given ids. */
export function normalizeFindings(raw: unknown): ReviewFinding[];

/** Blockers and warnings drive another revision. */
export function isActionable(finding: ReviewFinding): boolean;

/** Latest round's findings in the current cycle, and ids earlier rounds saw that it no longer does. */
export function currentFindings(state: RunState): { open: ReviewFinding[]; resolved: string[] };

/** Normalise a draft's `addressed` claim (findingIds + dispositions). */
export function normalizeAddressed(raw: unknown): DraftAddressedClaim | null;

/** The attempt running right now, if any. */
export function liveAttempt(state: RunState): StageAttempt | undefined;

/** The open interview question, if one is waiting. */
export function openQuestion(state: RunState): QuestionRecord | undefined;

/** Records of the current step, oldest first. */
export function stepRecords(state: RunState): StageRecord[];

/** True unless the run is running. */
export function isStopped(state: RunState): boolean;

/** Whether the polish stage runs for this plan. */
export function polishEnabled(state: RunState): boolean;

/** Normalise a run config from v3 keys or the renderer's Settings keys. */
export function readConfig(raw: unknown): RunConfig;
