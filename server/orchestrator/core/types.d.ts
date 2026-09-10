// ── Roles ────────────────────────────────────────────────────────────────────

/** Who is attempting the work. merge and final are engine-driven, not agents. */
export type Role = 'builder' | 'tester' | 'merge' | 'final';

export type AgentRole = 'builder' | 'tester';

/** How an attempt ended. */
export type AttemptResult =
  | 'pass'
  | 'fail'
  | 'blocked'
  | 'no_report'
  | 'crashed'
  | 'timeout';

/** Which prompt shape a retry gets. */
export type SeedKind =
  | 'initial'
  | 'failure-aware'
  | 'repair'
  | 'continue'
  | 'fix'
  | 'rebase'
  | 'integration-fix';

/** Derived task phase. Never stored — always computed by derive(). */
export type TaskPhase =
  | 'idle'
  | 'building'
  | 'testing'
  | 'merging'
  | 'merged'
  | 'abandoned'
  | 'skipped';

export type BoardStatus = 'created' | 'running' | 'stopped';

export type StopReason = 'user' | 'complete' | 'terminal';

// ── Events ───────────────────────────────────────────────────────────────────

/** Event types the fold understands. Anything else is opaque, not invalid. */
export type KnownEventType =
  | 'board.created'
  | 'board.started'
  | 'board.stopped'
  | 'task.attempt.started'
  | 'task.attempt.ended'
  | 'merge.enqueued'
  | 'merge.succeeded'
  | 'merge.conflicted'
  | 'task.abandoned'
  | 'task.skipped'
  | 'touches.overflow'
  | 'final.test.ended'
  | 'run.finished'
  | 'board.model.set'
  | 'board.renamed'
  | 'board.reopened'
  | 'task.added'
  | 'task.reset'
  | 'board.rewound';

export type JournalEventType = KnownEventType | (string & {});

/** Fields every persisted event carries. */
export interface EventEnvelope {
  v: number;
  seq?: number;
  ts?: number;
  type: JournalEventType;
}

export interface WaveRef {
  n: number;
  name: string;
}

/** Free-form detail for the report. The fold never reads it. */
export type Evidence = Record<string, unknown>;

export type BoardCreatedEvent = EventEnvelope & {
  type: 'board.created';
  boardId: string;
  planPath: string;
  tasks: PlanTask[];
  waves: WaveRef[];
  name?: string;
  /** Workspace at create time. Older journals omit it. */
  workspacePath?: string;
};
export type BoardStartedEvent = EventEnvelope & { type: 'board.started'; concurrency: number };
export type BoardStoppedEvent = EventEnvelope & { type: 'board.stopped'; reason: StopReason };
export type AttemptStartedEvent = EventEnvelope & {
  type: 'task.attempt.started';
  taskId: string;
  attemptId: string;
  role: Role;
  worktree?: string;
  seedKind?: SeedKind;
};
export type AttemptEndedEvent = EventEnvelope & {
  type: 'task.attempt.ended';
  taskId: string;
  attemptId: string;
  role: Role;
  outcome: AttemptResult;
  summary?: string;
  evidence?: Evidence;
};
export type MergeEnqueuedEvent = EventEnvelope & { type: 'merge.enqueued'; taskId: string };
export type MergeSucceededEvent = EventEnvelope & {
  type: 'merge.succeeded';
  taskId: string;
  sha: string;
  /** Integration tip before this merge. */
  beforeSha?: string;
};
export type MergeConflictedEvent = EventEnvelope & {
  type: 'merge.conflicted';
  taskId: string;
  files: string[];
  summary?: string;
  /** Integration tip before this merge. */
  beforeSha?: string;
};
export type TaskAbandonedEvent = EventEnvelope & {
  type: 'task.abandoned';
  taskId: string;
  reason: string;
  evidence?: Evidence;
};
export type TaskSkippedEvent = EventEnvelope & {
  type: 'task.skipped';
  taskId: string;
  blockedBy: string;
};
export type TouchesOverflowEvent = EventEnvelope & {
  type: 'touches.overflow';
  taskId: string;
  attemptId: string;
  declared: string[];
  actual: string[];
};
export type FinalTestEndedEvent = EventEnvelope & {
  type: 'final.test.ended';
  outcome: 'pass' | 'fail';
  runInstructions?: string;
  evidence?: Evidence;
};
export type RunFinishedEvent = EventEnvelope & { type: 'run.finished'; summary: string };
export type BoardModelSetEvent = EventEnvelope & {
  type: 'board.model.set';
  providerId: string;
  id: string;
  reasoning?: string;
};
export type BoardRenamedEvent = EventEnvelope & { type: 'board.renamed'; name: string };
export type BoardReopenedEvent = EventEnvelope & {
  type: 'board.reopened';
  taskIds: string[];
  reason: string;
};
export type TaskAddedEvent = EventEnvelope & {
  type: 'task.added';
  task: PlanTask;
  wave?: WaveRef;
};
/** Wipe listed tasks back to Planned. Does not rewind integration. */
export type TaskResetEvent = EventEnvelope & {
  type: 'task.reset';
  taskIds: string[];
  reason: string;
};
/** Restore integration to beforeSha and wipe listed tasks, including merged ones. */
export type BoardRewoundEvent = EventEnvelope & {
  type: 'board.rewound';
  fromTaskId: string;
  beforeSha: string;
  taskIds: string[];
  reason: string;
};

export type KnownEvent =
  | BoardCreatedEvent
  | BoardStartedEvent
  | BoardStoppedEvent
  | AttemptStartedEvent
  | AttemptEndedEvent
  | MergeEnqueuedEvent
  | MergeSucceededEvent
  | MergeConflictedEvent
  | TaskAbandonedEvent
  | TaskSkippedEvent
  | TouchesOverflowEvent
  | FinalTestEndedEvent
  | RunFinishedEvent
  | BoardModelSetEvent
  | BoardRenamedEvent
  | BoardReopenedEvent
  | TaskAddedEvent
  | TaskResetEvent
  | BoardRewoundEvent;

/** Anything else on the journal: readable, ignorable, never an error. */
export type OpaqueEvent = EventEnvelope & Record<string, unknown>;

export type JournalEvent = KnownEvent | OpaqueEvent;

export type ValidationResult =
  | { ok: true; event: Record<string, unknown>; known: boolean }
  | { ok: false; error: string };

// ── Plan graph ───────────────────────────────────────────────────────────────

export interface PlanTask {
  id: string;
  title: string;
  wave: number;
  dependsOn: string[];
  /** Repo-relative globs this task may write. */
  touches: string[];
  /** Files those globs matched at board creation. */
  touchesExpanded?: string[];
  /** Declared globs that matched no file at board creation. */
  emptyTouchesGlobs?: string[];
  build: string;
  test: string;
  accept: string;
  /** Line of the Task heading. */
  line: number;
}

export interface TaskGraph {
  name: string;
  overview: string;
  isProject: boolean;
  title: string;
  waves: WaveRef[];
  tasks: PlanTask[];
}

export interface ParseError {
  line: number;
  column: number;
  message: string;
  hint: string;
}

// ── Board state ──────────────────────────────────────────────────────────────

/** One recorded attempt. ended false means it is still running. */
export interface Attempt {
  attemptId: string;
  role: Role;
  worktree: string | null;
  seedKind: SeedKind | null;
  ended: boolean;
  outcome: PolicyOutcome | null;
  summary: string | null;
  evidence: Evidence | null;
  /** True when started while the board was stopped. */
  manual: boolean;
  /** Ended attempts from a previous run. */
  retired: boolean;
}

/** A Builder diff that reached outside what the task declared. */
export interface TouchesOverflow {
  attemptId: string;
  declared: string[];
  actual: string[];
}

export interface TaskState {
  id: string;
  title: string;
  wave: number;
  dependsOn: string[];
  touches: string[];
  /** Frozen expansion of touches at board.created. */
  touchesExpanded: string[] | null;
  /** Globs that matched no files when the board was created. */
  emptyTouchesGlobs: string[];
  buildSpec: string | null;
  testSpec: string | null;
  accept: string | null;
  phase: TaskPhase;
  attempts: Attempt[];
  /** Outcome of the most recent finished attempt, of any role. */
  outcome: PolicyOutcome | null;
  abandonedReason: string | null;
  abandonedEvidence: Evidence | null;
  skippedBy: string | null;
  mergedSha: string | null;
  mergeConflicts: string[] | null;
  touchesOverflow: TouchesOverflow[];
  /** Set by board.reopened. */
  reopened: { n: number; from: string | null } | null;
}

export interface BoardModel {
  providerId: string;
  id: string;
  /** Thinking mode, or null for off. */
  reasoning: string | null;
}

export interface FinalTestState {
  outcome: 'pass' | 'fail';
  runInstructions: string | null;
  evidence: Evidence | null;
}

/** The whole board, derived. The only state the engine has. */
export interface BoardState {
  boardId: string;
  name: string;
  planPath: string;
  /** Workspace stamped on board.created. */
  workspacePath: string | null;
  waves: WaveRef[];
  status: BoardStatus;
  concurrency: number;
  /** Insertion-ordered by declared task order. */
  tasks: Map<string, TaskState>;
  taskOrder: string[];
  /** Enqueued and not yet merged or conflicted, in enqueue order. */
  mergeQueue: string[];
  integrationSha: string | null;
  /** Per-board model override. null falls back to Settings. */
  model: BoardModel | null;
  finalTest: FinalTestState | null;
  finished: boolean;
  stopReason: StopReason | null;
  runSummary: string | null;
  /** The most recent board.reopened. */
  rerun: {
    n: number;
    reason: string;
    taskIds: string[];
    previousFinalTest: FinalTestState | null;
  } | null;
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** One attempt the scheduler wants running right now. */
export interface Desired {
  /** null for the board-level Final Tester. */
  taskId: string | null;
  role: Role;
  seedKind: SeedKind;
  /** True when this retry reuses the previous worktree. */
  sameWorktree: boolean;
}

/** What should happen next to a task with nothing in flight. */
export type NextAction =
  | { kind: 'start'; role: Role; seedKind: SeedKind; sameWorktree: boolean }
  | { kind: 'enqueue' }
  | { kind: 'abandon'; reason: string; evidence: Evidence }
  | { kind: 'none' };

/** AttemptResult plus merge-only conflicted. */
export type PolicyOutcome = AttemptResult | 'conflicted';

export interface RetryAction {
  kind: 'retry';
  role: 'builder';
  seedKind: SeedKind;
  /** True for repair, continue, and rebase. */
  sameWorktree: boolean;
}

export interface AdvanceAction {
  kind: 'advance';
  to: 'tester' | 'merge' | 'done';
}

export interface AbandonAction {
  kind: 'abandon';
  reason: string;
  evidence: Evidence;
}

export type Action = RetryAction | AdvanceAction | AbandonAction;

export interface PolicyRow {
  role: Role | '*';
  outcome: PolicyOutcome | '*';
  /** Applies while attemptCount < under. null is the unbounded fallback. */
  under: number | null;
  action: RetryAction | AdvanceAction | { kind: 'abandon'; reason: string };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** Fold cache. Never a source of truth. */
export interface Snapshot {
  v: number;
  boardId: string;
  /** The last event folded in. */
  throughSeq: number;
  stateHash: string;
  state: unknown;
}
