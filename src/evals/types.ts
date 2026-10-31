/**
 * Local eval harness types (task packs, suite runs, grading).
 */

import type { ApiMessage, Stats, Usage } from '../types';

/** Single eval task inside a pack. */
export interface EvalTask {
  id: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools: string[];
  deniedTools: string[];
  rubricPrompt: string;
  /** Explicit simulation: every tool response comes from this bounded script. */
  toolFixtures?: import('../../server/evals/tool-fixtures').EvalToolFixtures;
}

/** Task pack (built-in or user under ~/.minnow/evals/packs/). */
export interface EvalPack {
  id: string;
  label: string;
  version: number;
  tasks: EvalTask[];
  /** Where the pack was loaded from. */
  source?: 'builtin' | 'user';
}

/** Pack list entry for settings UI. */
export interface EvalPackListItem {
  id: string;
  label: string;
  version: number;
  taskCount: number;
  source: 'builtin' | 'user';
}

/** Model target in a suite matrix. */
export interface EvalModelTarget {
  providerId: string;
  modelId: string;
  label?: string;
}

/** Request to start a suite run. */
export interface EvalSuiteRequest {
  packId: string;
  targets: EvalModelTarget[];
  workspacePath?: string;
  modeId?: string;
  maxConcurrency?: number;
}

export type EvalSuiteStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Suite run manifest persisted under ~/.minnow/evals/runs/<id>/manifest.json */
export interface EvalSuiteRun {
  suiteRunId: string;
  packId: string;
  packLabel: string;
  status: EvalSuiteStatus;
  targets: EvalModelTarget[];
  workspacePath: string;
  modeId: string;
  totalCells: number;
  completedCells: number;
  startedAt: string;
  endedAt: string | null;
  error?: string;
}

/** Grader output for one cell. */
export interface EvalGraderResult {
  score: number;
  pass: boolean;
  rationale: string;
  tags?: string[];
  rawResponse?: string;
}

/** One task×model cell result. */
export interface EvalCellResult {
  cellId: string;
  taskId: string;
  modelKey: string;
  providerId: string;
  modelId: string;
  modelLabel: string;
  status: 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  summary: string;
  toolTurns: number;
  grader?: EvalGraderResult;
  usage?: Usage;
  stats?: Stats;
  error?: string;
  transcriptExcerpt?: string;
  messages?: ApiMessage[];
  fixtureReport?: { pass: boolean; completedSteps: number; expectedSteps: number; actualCalls: number; violations: string[] };
}

/** Aggregated leaderboard row per model target. */
export interface LeaderboardRow {
  modelKey: string;
  label: string;
  providerId: string;
  modelId: string;
  meanScore: number;
  passRate: number;
  medianDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  failedCells: number;
  completedCells: number;
}

/** Eval harness config (~/.minnow/evals/config.json). */
export interface EvalConfig {
  version: number;
  maxConcurrency: number;
  graderProviderId: string;
  graderModelId: string;
  graderTimeoutMs: number;
  saveFullTranscripts: boolean;
  skipApprovalDuringEval: boolean;
}
