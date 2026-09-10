// ── Stages ───────────────────────────────────────────────────────────────────

/** Every stage the pipeline can run. Each is also a Desired role. */
export type StageId = 'interview' | 'spec' | 'research' | 'draft' | 'review' | 'polish' | 'gate';

/** How a stage attempt ended. */
export type StageOutcome = 'ok' | 'crashed' | 'timeout' | 'rejected' | 'paused';

/** The two user checkpoints. */
export type GateKind = 'spec' | 'accept' | 'question';

/** What a user can say at a gate. */
export type GateVerdict = 'confirm' | 'revise' | 'accept' | 'reject';

/** How a whole run ended. */
export type RunOutcome = 'pass' | 'fail' | 'skip';

export type RunStatus = 'created' | 'running' | 'stopped';

export type StopReason =
  | 'cancelled'
  | 'gate-expired'
  | 'complete'
  | 'failed'
  | 'skipped'
  /** Non-terminal stop (D8): the run keeps its stage and is resumable. */
  | 'paused'
  | null;

/** Which prompt shape a retry gets. */
export type SeedKind = 'initial' | 'continue' | 'revise' | 'errors' | 'findings';

/** Whether a review finding blocks the draft or is advisory. */
export type FindingSeverity = 'blocking' | 'info';

// ── Config ───────────────────────────────────────────────────────────────────

/** Pipeline switches, journaled on run.created so replay reproduces them. */
export interface RunConfig {
  [key: string]: unknown;
  /** Number of review passes (0 skips review entirely). */
  reviewRounds: number;
  /** Run the Deep Research stage (default true). */
  research: boolean;
  /** Run the interview stage (false starts at the spec). */
  interview: boolean;
  /** Impeccable UI pass; auto uses journaled UI involvement and the prompt. */
  polish: 'auto' | 'always' | 'never';
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Field type vocabulary used by the schema table. */
export type FieldType = 'bool' |
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

/** Event types the fold understands. Anything else is opaque, not invalid. */
export type KnownEventType =
  | 'run.created'
  | 'run.started'
  | 'run.resumed'
  | 'run.cancelled'
  | 'run.stopped'
  | 'run.finished'
  | 'run.renamed'
  | 'stage.started'
  | 'stage.ended'
  | 'spec.written'
  | 'research.written'
  | 'plan.written'
  | 'review.recorded'
  | 'gate.opened'
  | 'gate.answered'
  | 'gate.expired';

export type JournalEventType = KnownEventType | (string & {});

/** Fields every persisted event carries. */
export interface EventEnvelope {
  v: number;
  seq?: number;
  ts?: number;
  type: JournalEventType;
}

// ── Findings ─────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  /**
   * Purely-computed id: `fnv1a(normalize(title) + '|' + sortedPaths.join(','))`.
   * Never journaled — the fold derives it, so the same finding text in two
   * rounds yields the same id and a changed title yields a different one.
   */
  id: string;
  severity: FindingSeverity;
  /** Short issue title; the id's primary input. */
  title: string;
  /** Detailed description of the issue. */
  detail: string;
  /** File paths the finding touches; sorted before hashing for id stability. */
  paths: string[];
}

/** The draft's claim about which review findings it addressed. */
export interface DraftAddressedClaim {
  /** Finding ids the draft says it worked on. */
  findingIds: string[];
  /** Disposition per finding id (fixed, wontfix, duplicate, noted, ...). */
  dispositions: Record<string, string>;
}

export interface ReviewRound {
  /** 1-based pass number, journaled on review.recorded. */
  round: number;
  findings: ReviewFinding[];
}

// ── Derived state ────────────────────────────────────────────────────────────

/** One stage attempt. ended false means it is still running. */
export interface StageAttempt {
  seedKind?: string;
  attemptId: string;
  stage: StageId;
  ended: boolean;
  outcome: StageOutcome | null;
  summary: string | null;
  errors: string[];
}

/** A completed stage fact, in journal order. */
export interface StageRecord {
  stage: StageId;
  outcome: StageOutcome;
  summary: string | null;
  errors: string[];
}

export interface GateState {
  gateId?: string;
  attemptId?: string;
  question?: string;
  choices?: string[];
  kind: GateKind;
  status: 'open' | 'answered' | 'expired';
  verdict: GateVerdict | null;
  errors: string[];
}

/** An answered (or expired) gate, kept for replay and rejection counting. */
export interface GateHistoryEntry {
  gateId?: string;
  attemptId?: string;
  question?: string;
  kind: GateKind;
  verdict: GateVerdict | null;
  errors: string[];
}

/** The whole run, derived. The only state the engine has. */
export interface RunState {
  involvesUi?: boolean;
  retryEpochIndex?: number;
  chatId?: string | null;
  displayTitle?: string;
  planSha256?: string;
  runId: string;
  prompt: string;
  /** Interim identity until the spec title is known; run.renamed finalizes it. */
  slug: string;
  workspacePath: string | null;
  config: RunConfig;
  status: RunStatus;
  finished: boolean;
  stopReason: StopReason;
  runOutcome: RunOutcome | null;
  runSummary: string | null;
  /** The stage due next, or null while a gate is pending or the run is done. */
  stage: StageId | null;
  /** Gate kind awaiting its implied gate.opened. */
  pendingGate: GateKind | null;
  /** Run outcome awaiting its implied run.finished. */
  pendingFinish: RunOutcome | null;
  /** Why the current interview/draft was seeded, when it is a retry. */
  interviewSeed: SeedKind | null;
  draftSeed: SeedKind | null;
  /**
   * The latest draft's claim about the findings it addressed (findingIds +
   * dispositions). The final report flags where a draft claimed a fix that
   * the next review still saw. Null until a draft ends with an `addressed`
   * claim.
   */
  draftAddressed: DraftAddressedClaim | null;
  /** All stage attempts, in start order. */
  attempts: StageAttempt[];
  /** Completed stage facts, in journal order. */
  stageRecords: StageRecord[];
  /** Review rounds, in recording order. */
  reviews: ReviewRound[];
  specPath: string | null;
  researchPath: string | null;
  planPath: string | null;
  /** The open gate, or null. Answered gates are cleared and moved to history. */
  gate: GateState | null;
  gateHistory: GateHistoryEntry[];
}

// ── Plan / policy ────────────────────────────────────────────────────────────

/** One attempt the scheduler wants running right now. */
export interface Desired {
  taskId: string;
  role: StageId;
  seedKind: SeedKind;
}

/** What should happen next after a stage fact. */
export type Action =
  | { kind: 'accept' }
  | { kind: 'retry'; seedKind: SeedKind }
  | { kind: 'skip' }
  | { kind: 'fail' }
  | { kind: 'stop' };

export interface PolicyRow {
  stage: StageId | 'gate' | '*';
  outcome: StageOutcome | 'expired' | '*';
  /** Applies while attemptCount < under. null is the unbounded fallback. */
  under: number | null;
  action: Action;
}

/** One attempt the scheduler wants running right now (Graph shape). */
export interface DesiredLike {
  taskId: string | null;
  role: string;
  seedKind?: string;
  sameWorktree?: boolean;
}

// ── Graph ────────────────────────────────────────────────────────────────────

/** The engine-facing surface, mirroring server/sub-agents/graph.js. */
export interface SuperPlanGraph {
  foldInto(state: unknown, events: Iterable<unknown>): unknown;
  plan(state: RunState): Desired[];
  impliedEvents(state: RunState): Record<string, unknown>[];
  isAgentRole(role: string): boolean;
  isAlreadyEnded(state: RunState, attemptId: string): boolean;
  reapVanished(
    state: RunState,
    live: Set<string>,
    buffered: Set<string>,
  ): Record<string, unknown>[];
  eventsForStart(
    want: DesiredLike,
    handle: { attemptId: string; worktree?: string },
  ): Record<string, unknown>[];
  eventsForAttemptEnd(end: {
    attemptId: string;
    taskId: string | null;
    role: string;
    outcome: string;
    summary?: string;
    evidence?: Record<string, unknown> | null;
  }): Record<string, unknown>[];
  defaultConcurrency: number;
}