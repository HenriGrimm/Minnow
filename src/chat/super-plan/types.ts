/** Historical transcript stamp order used only for display. */
export const SUPER_PLAN_DISPLAY_ORDER = [
  'grill',
  'spec_confirm',
  'research',
  'draft1',
  'review1',
  'draft2',
  'review2',
  'impeccable',
  'finalize',
  'present',
] as const;

export type SuperPlanStageId = (typeof SUPER_PLAN_DISPLAY_ORDER)[number];

/** Human-readable stage names for progress and error surfaces. */
export const SUPER_PLAN_STAGE_LABELS: Record<SuperPlanStageId, string> = {
  grill: 'Interview',
  spec_confirm: 'Build spec',
  research: 'Research',
  draft1: 'Draft',
  review1: 'Review',
  draft2: 'Draft 2',
  review2: 'Review 2',
  impeccable: 'Polish',
  finalize: 'Finalize',
  present: 'Present',
};

export type SuperPlanStageStatus =
  | 'pending'
  | 'running'
  | 'blocked_user'
  | 'done'
  | 'error';

/** Per-stage record with status, timestamps, and optional artifact pointer. */
export interface SuperPlanStageRecord {
  status: SuperPlanStageStatus;
  startedAt?: number;
  finishedAt?: number;
  /** Workspace-relative path written during this stage. */
  artifactPath?: string;
  error?: string;
}

/** User actions at the two pipeline checkpoints. */
export type SuperPlanCheckpointAction = 'confirm' | 'revise';

/** Persisted Super Plan controller state on a chat. */
export interface SuperPlanState {
  /** Kebab-case basename shared by spec, research, and plan artifacts. */
  slug: string;
  /**
   * Epoch ms when this pipeline instance was created.
   * Stable across slug reconcile so Activity persist cannot write a prior
   * run's ledger onto a replacement `superPlan` on the same chat id.
   */
  runStartedAt?: number;
  /** Human title from the build spec (or plan) after slug reconciliation. */
  displayTitle?: string;
  /** Original user prompt that started the pipeline. */
  prompt: string;
  /** Stage currently executing or awaiting user input. */
  activeStage: SuperPlanStageId;
  stages: Record<SuperPlanStageId, SuperPlanStageRecord>;
  /** Whether the plan involves UI surfaces (gates impeccable stage). */
  uiInvolved?: boolean;
  /** Set when the user or controller cancels the pipeline. */
  cancelled?: boolean;
  /** Set when the user pauses the pipeline (Stop button / manual stop); resumable. */
  paused?: boolean;
  /** Final plan path under documentation/plans/<slug>.md */
  planPath?: string;
  /** Build spec path under documentation/plans/references/<slug>-spec.md */
  specPath?: string;
  /** Research report path under documentation/plans/references/<slug>-research.md */
  researchPath?: string;
  /** Active Deep Research run id while the research stage is in flight. */
  researchId?: string;
  /** Transient plan-reviewer sub-agent run id while a review stage is in flight (not resumed across reloads). */
  reviewRunId?: string;
  /** Pass 1 plan-reviewer structured critique (for pass 2 and draft2). */
  review1Critique?: string;
  /** Pass 2 plan-reviewer structured critique (optional audit trail). */
  review2Critique?: string;
  activityLog?: import('../../research/activity-log').ActivityLogEntry[];
}

export function isSuperPlanStageId(value: string): value is SuperPlanStageId {
  return (SUPER_PLAN_DISPLAY_ORDER as readonly string[]).includes(value);
}
