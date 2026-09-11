/**
 * Wire types for Super Plan. The server owns every run
 * (`server/super-plan/`); the renderer only reads these views and posts
 * commands. Shapes mirror `projectRunView` / `projectChatSummary` in
 * `server/super-plan/projection.js`.
 */

export type SuperPlanStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'halted'
  | 'done'
  | 'cancelled'
  | 'failed'
  | 'legacy';

/** What the run is waiting on the user for, if anything. */
export type SuperPlanNeedsInput = 'question' | 'spec' | 'accept' | 'halted' | null;

/** Pipeline positions: stages plus the two checkpoints. */
export type SuperPlanStepId = 'interview' | 'spec' | 'research' | 'draft' | 'review' | 'polish' | 'accept';

export type SuperPlanStageId = 'interview' | 'research' | 'draft' | 'review' | 'polish';

export type SuperPlanStepState =
  | 'pending'
  | 'active'
  | 'waiting'
  | 'paused'
  | 'failed'
  | 'done'
  | 'earlier'
  | 'skipped'
  | 'off';

export const SUPER_PLAN_STEP_ORDER: readonly SuperPlanStepId[] = [
  'interview',
  'spec',
  'research',
  'draft',
  'review',
  'polish',
  'accept',
];

/** Compact summary stored on `chat.superPlanView` for the sidebar and library. */
export interface SuperPlanChatSummary {
  runId: string;
  title: string;
  slug: string;
  prompt: string;
  status: SuperPlanStatus;
  stage: string;
  stageLabel: string;
  activity: string;
  needsInput: SuperPlanNeedsInput;
  /** Changes once per thing the user is asked; drives one alert per ask. */
  attentionKey?: string;
  finished: boolean;
  planPath?: string;
  specPath?: string;
  atMs: number;
  seq: number;
}

export interface SuperPlanQuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface SuperPlanQuestionItem {
  id: string;
  prompt: string;
  options: SuperPlanQuestionOption[];
  allow_multiple?: boolean;
}

export interface SuperPlanAnswerEntry {
  questionId: string;
  selectedIds: string[];
  otherText: string | null;
}

export interface SuperPlanOpenQuestion {
  questionId: string;
  title: string;
  questions: SuperPlanQuestionItem[];
  askedAt: number | null;
}

export interface SuperPlanAnsweredQuestion extends SuperPlanOpenQuestion {
  status: 'answered' | 'skipped' | 'cancelled';
  answer: { status?: string; answers?: SuperPlanAnswerEntry[] } | null;
  answeredAt: number | null;
}

export type SuperPlanFindingSeverity = 'blocker' | 'warn' | 'info';

export interface SuperPlanFinding {
  id: string;
  severity: SuperPlanFindingSeverity;
  title: string;
  detail: string;
  fix?: string;
  paths: string[];
}

export interface SuperPlanReviewRound {
  round: number;
  cycle: number;
  attemptId: string | null;
  summary: string;
  findings: SuperPlanFinding[];
  at?: number;
}

export interface SuperPlanStep {
  id: SuperPlanStepId;
  label: string;
  state: SuperPlanStepState;
  detail: string;
  startedAt?: number;
  endedAt?: number;
  runs: number;
  reworkable: boolean;
  skippable: boolean;
}

export interface SuperPlanArtifact {
  path: string;
  sha256?: string;
  title?: string;
  empty?: boolean;
  bytes?: number;
  executable?: boolean;
  tasks?: number;
  at?: number;
}

export interface SuperPlanTranscriptRef {
  key: string;
  stage: SuperPlanStageId;
  iteration: number;
  label: string;
  attempts: number;
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  outcome?: string | null;
  messageCount?: number;
}

export interface SuperPlanTimelineRow {
  at: number;
  kind: string;
  label: string;
  detail?: string;
  tone?: 'good' | 'warning' | 'danger';
}

export interface SuperPlanModelBinding {
  providerId: string;
  modelId: string;
  thinking?: 'on' | 'off';
}

/** Everything the page renders for one run. */
export interface SuperPlanRunView {
  runId: string;
  chatId: string | null;
  title: string;
  slug: string;
  prompt: string;
  workspacePath: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  seq: number;
  status: SuperPlanStatus;
  finished: boolean;
  legacy: boolean;
  current: SuperPlanStepId | null;
  currentLabel: string;
  seedKind: string | null;
  activity: string;
  needsInput: SuperPlanNeedsInput;
  attentionKey: string;
  question: SuperPlanOpenQuestion | null;
  checkpoint: { kind: 'spec' | 'accept'; since: number | null } | null;
  halted: { stage: SuperPlanStageId; label: string; summary: string | null; errors: string[] } | null;
  startFailure: { message: string; consecutive: number } | null;
  steps: SuperPlanStep[];
  artifacts: { spec: SuperPlanArtifact | null; research: SuperPlanArtifact | null; plan: SuperPlanArtifact | null };
  reviews: SuperPlanReviewRound[];
  reviewCycle: number;
  reviewExit: { reason: 'clean' | 'round-cap' | 'no-progress' | 'skipped' | 'failed'; cycle: number } | null;
  openFindings: string[];
  resolvedFindings: string[];
  disputedClaims: string[];
  questions: SuperPlanAnsweredQuestion[];
  checkpoints: Array<{ checkpoint: 'spec' | 'accept'; verdict: string; feedback: string | null; at?: number }>;
  feedback: { spec: string | null; plan: string | null };
  timeline: SuperPlanTimelineRow[];
  transcripts: SuperPlanTranscriptRef[];
  research: { researchId: string } | null;
  config: {
    interview: boolean;
    questionBudget: number;
    research: boolean;
    researchScope: string;
    researchDepth: string;
    reviewRounds: number;
    polish: 'auto' | 'always' | 'never';
    granularity: string;
    plannerModel: SuperPlanModelBinding | null;
    reviewerModel: SuperPlanModelBinding | null;
  };
  actions: {
    pause: boolean;
    resume: boolean;
    retry: boolean;
    cancel: boolean;
    skip: SuperPlanStageId | null;
    stopQuestions: boolean;
    revise: boolean;
  };
}

/** One live frame from the run's SSE stream. */
export interface SuperPlanLiveFrame {
  runId: string;
  stage: string;
  attemptId?: string;
  event: Record<string, unknown> & { type: string };
}

/** Row in `GET /api/super-plan/runs`. */
export interface SuperPlanRunSummary extends SuperPlanChatSummary {
  chatId: string | null;
  workspacePath: string | null;
}

/** True for a view the server can still move forward. */
export function isSuperPlanLive(status: SuperPlanStatus | undefined): boolean {
  return status === 'running' || status === 'waiting' || status === 'paused' || status === 'halted' || status === 'created';
}
