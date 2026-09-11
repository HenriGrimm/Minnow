// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Every stage the engine can run. Each is also a Desired role. */
export type StageId = 'interview' | 'research' | 'draft' | 'review' | 'polish';

/**
 * How a stage attempt ended. `interrupted` is a reaped attempt (restart);
 * `paused`, `cancelled` and `superseded` are decided by the fold when the
 * user intervenes. Only `crashed`, `timeout` and `rejected` count as failures.
 */
export type StageOutcome =
  | 'ok'
  | 'crashed'
  | 'timeout'
  | 'rejected'
  | 'interrupted'
  | 'paused'
  | 'cancelled'
  | 'superseded';

/** The two user checkpoints. */
export type CheckpointKind = 'spec' | 'accept';

export type ArtifactKind = 'spec' | 'research' | 'plan';

export type RunStatus = 'created' | 'running' | 'stopped';

/** `paused` and `halted` are resumable; the rest are terminal. */
export type StopReason = 'paused' | 'halted' | 'cancelled' | 'complete' | 'failed' | null;

export type RunOutcome = 'pass' | 'fail' | 'cancelled';

/** Which prompt shape an attempt gets. */
export type SeedKind = 'initial' | 'continue' | 'errors' | 'revise' | 'findings' | 'feedback' | 'rework';

/** Blockers and warnings drive another revision; notes do not. */
export type FindingSeverity = 'blocker' | 'warn' | 'info';

// ── Config ───────────────────────────────────────────────────────────────────

export interface ModelBinding {
  providerId: string;
  modelId: string;
  thinking?: 'on' | 'off';
}

/** Pipeline switches, journaled on run.created so replay reproduces them. */
export interface RunConfig {
  [key: string]: unknown;
  interview: boolean;
  /** Questions the interview may ask; 0 writes the spec without asking. */
  questionBudget: number;
  research: boolean;
  researchScope: 'web' | 'codebase' | 'both';
  researchDepth: 'auto' | 'quick' | 'standard' | 'deep';
  researchMaxRounds: number;
  /** Review rounds per cycle (0 skips review). */
  reviewRounds: number;
  reviewTimeoutMs: number;
  polish: 'auto' | 'always' | 'never';
  granularity: 'large' | 'medium' | 'small';
  plannerModel?: ModelBinding;
  reviewerModel?: ModelBinding;
  researchModel?: ModelBinding;
  thinking?: 'on' | 'off';
}

// ── Events ───────────────────────────────────────────────────────────────────

export type FieldType =
  | 'bool'
  | 'id'
  | 'str'
  | 'int'
  | 'posint'
  | 'str[]'
  | 'obj[]'
  | 'obj'
  | { enum: readonly string[] };

export interface EventSchema {
  readonly required: Readonly<Record<string, FieldType>>;
  readonly optional: Readonly<Record<string, FieldType>>;
}

export type ValidationResult =
  | { ok: true; event: Record<string, unknown>; known: boolean }
  | { ok: false; error: string };

// ── Findings ─────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  /** The reviewer's id when it re-reports a prior finding, otherwise derived from title + paths. */
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** The reviewer's suggested edit to the plan. */
  fix?: string;
  paths: string[];
}

export interface DraftAddressedClaim {
  findingIds: string[];
  dispositions: Record<string, string>;
}

export interface ReviewRound {
  /** 1-based round within its cycle. */
  round: number;
  cycle: number;
  attemptId: string | null;
  summary: string;
  findings: ReviewFinding[];
  at?: number;
}

// ── Derived state ────────────────────────────────────────────────────────────

export interface StageAttempt {
  attemptId: string;
  stage: StageId;
  seedKind: string;
  iteration: number;
  transcriptKey: string;
  startedAt?: number;
  endedAt?: number;
  ended: boolean;
  outcome: StageOutcome | null;
  summary: string | null;
  errors: string[];
}

export interface StageRecord {
  attemptId: string;
  stage: StageId;
  outcome: StageOutcome;
  summary: string | null;
  errors: string[];
  at?: number;
}

export type Step =
  | {
      kind: 'stage';
      stage: StageId;
      seedKind: SeedKind;
      /** How many times this stage has been entered, this one included. */
      iteration: number;
      /** `stageRecords` index where this step began. */
      recordsFrom: number;
      since?: number;
    }
  | { kind: 'checkpoint'; checkpoint: CheckpointKind; since?: number };

export interface Artifact {
  path: string;
  sha256?: string;
  attemptId?: string;
  title?: string;
  /** Research that found nothing. */
  empty?: boolean;
  bytes?: number;
  /** The plan parses as a board task graph. */
  executable?: boolean;
  tasks?: number;
  at?: number;
}

export interface QuestionRecord {
  questionId: string;
  attemptId: string | null;
  transcriptKey: string | null;
  title: string;
  questions: Array<Record<string, unknown>>;
  status: 'open' | 'answered' | 'skipped' | 'cancelled';
  answer: Record<string, unknown> | null;
  askedAt?: number;
  answeredAt?: number;
}

export interface CheckpointRecord {
  checkpoint: CheckpointKind;
  verdict: string;
  feedback: string | null;
  at?: number;
}

/** The whole run, derived. The only state the engine has. */
export interface RunState {
  runId: string;
  prompt: string;
  workspacePath: string | null;
  chatId: string | null;
  config: RunConfig;
  /** Engine generation that wrote run.created; below 3 is a read-only v2 journal. */
  engine: number;
  legacy: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  lastSeq: number;
  title: string;
  userTitled: boolean;
  /** Artifact file stem. Interim (the run id) until the first spec lands. */
  slug: string;
  slugFinal: boolean;
  status: RunStatus;
  finished: boolean;
  stopReason: StopReason;
  runOutcome: RunOutcome | null;
  /** Bumped whenever the user replaces running work. Part of the engine task id. */
  epoch: number;
  step: Step | null;
  iterations: Partial<Record<StageId, number>>;
  attempts: StageAttempt[];
  stageRecords: StageRecord[];
  /** `stageRecords` index where each stage's failure budget restarts. */
  failureFrom: Partial<Record<StageId, number>>;
  halted: { stage: StageId; summary: string | null; errors: string[]; at?: number } | null;
  skipped: Array<{ stage: StageId; reason: string; cycle: number; at?: number }>;
  questions: QuestionRecord[];
  /** The user asked the interview to stop asking and write the spec. */
  questionsClosed: boolean;
  checkpoints: CheckpointRecord[];
  /** User notes waiting for the next spec or plan revision. */
  feedback: { spec: string | null; plan: string | null };
  artifacts: { spec: Artifact | null; research: Artifact | null; plan: Artifact | null };
  specPath: string | null;
  researchPath: string | null;
  planPath: string | null;
  researchId: string | null;
  researchSettled: boolean;
  reviews: ReviewRound[];
  reviewCycle: number;
  reviewCycleKind: 'full' | 'extra';
  reviewExit: { reason: 'clean' | 'round-cap' | 'no-progress' | 'skipped' | 'failed'; cycle: number } | null;
  polishedCycle: number;
  draftAddressed: DraftAddressedClaim | null;
  /** Actionable findings the latest draft claimed to fix that the next review still reported. */
  disputedClaims: string[];
  involvesUi: boolean | undefined;
}

// ── Plan / policy ────────────────────────────────────────────────────────────

export interface Desired {
  taskId: string;
  role: StageId;
  seedKind: SeedKind;
}

export type Action = { kind: 'retry' } | { kind: 'skip' } | { kind: 'halt' };

export interface DesiredLike {
  taskId: string | null;
  role: string;
  seedKind?: string;
}

// ── Graph ────────────────────────────────────────────────────────────────────

export interface SuperPlanGraph {
  foldInto(state: unknown, events: Iterable<unknown>): unknown;
  plan(state: RunState): Desired[];
  impliedEvents(state: RunState): Record<string, unknown>[];
  isAgentRole(role: string): boolean;
  isAlreadyEnded(state: RunState, attemptId: string): boolean;
  reapVanished(state: RunState, live: Set<string>, buffered: Set<string>): Record<string, unknown>[];
  eventsForStart(
    want: DesiredLike,
    handle: { attemptId: string; iteration?: number; transcriptKey?: string },
  ): Record<string, unknown>[];
  eventsForAttemptEnd(end: {
    attemptId: string;
    taskId: string | null;
    role: string;
    outcome: string;
    summary?: string;
    evidence?: Record<string, unknown> | null;
    usage?: Record<string, number>;
  }): Record<string, unknown>[];
  defaultConcurrency: number;
}
