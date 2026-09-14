/** Journal envelope version this build writes. */
export const CORE_VERSION: number;

export type {
  Role,
  AgentRole,
  AttemptResult,
  SeedKind,
  TaskPhase,
  BoardStatus,
  StopReason,
  EventEnvelope,
  JournalEvent,
  JournalEventType,
  ValidationResult,
  PlanTask,
  TaskGraph,
  ParseError,
  Attempt,
  TaskState,
  BoardState,
  Desired,
  Action,
  Snapshot,
} from './types';

export {
  ATTEMPT_OUTCOMES,
  ENVELOPE_VERSION,
  EVENT_SCHEMAS,
  EVENT_TYPES,
  isKnownEventType,
  makeEvent,
  ROLES,
  STOP_REASONS,
  validateEvent,
} from './events';

export {
  attemptCount,
  builderSentBackBy,
  deadEnded,
  DEFAULT_BOARD_CONCURRENCY,
  derive,
  emptyState,
  foldInto,
  lastEndedAttempt,
  readyTasks,
} from './derive';
export {
  abandonmentEvidenceIsComplete,
  attemptHistoryRecord,
  bundleAbandonmentEvidence,
  capDiffPayload,
  capDiffText,
  MAX_DIFF_CHARS,
  queryAbandonments,
} from './evidence';
export type { Attempt, TouchesOverflow, FinalTestState, WaveRef, Evidence } from './types';

export {
  decide,
  formatPolicyTable,
  POLICY_TABLE,
  SAME_WORKTREE_SEED_KINDS,
  wantsSameWorktree,
} from './policy';
export type { PolicyOutcome, PolicyRow, RetryAction, AdvanceAction, AbandonAction } from './types';

export {
  expandTouches,
  expandedFilesOverlap,
  footprintsClash,
  globsIntersect,
  isReadyForFinalTest,
  manualStart,
  nextAction,
  normalizeRepoPath,
  orderedTaskIds,
  overflowPaths,
  pathMatchesGlob,
  pendingAbandonments,
  pendingEnqueues,
  pendingSkips,
  plan,
  reopenTargets,
  buildIntegrationFixTask,
  touchesOverlap,
} from './plan';
export type { NextAction } from './types';
export {
  beforeShaForMerge,
  hasRunDebris,
  resetTargets,
  rewindCascade,
  withSkippedDependents,
} from './rewind';
export { summarizeTouchesOverflow } from './overflow-report';
export type {
  OverflowFileRow,
  OverflowTaskRow,
  TouchesOverflowReport,
} from './overflow-report';

export { formatParseErrors, isParseErrors, parsePlan } from './parse-plan';

export {
  canonicalise,
  decanonicalise,
  deriveFrom,
  hashSnapshot,
  hashState,
  isSnapshotUsable,
  makeSnapshot,
  SNAPSHOT_INTERVAL,
  SNAPSHOT_VERSION,
  shouldSnapshot,
  stateFromJSON,
  stateToJSON,
} from './snapshot';
