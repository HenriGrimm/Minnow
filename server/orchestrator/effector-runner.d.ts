import type { BoardState } from './core/types';
import type { RunnerDeps, PostChatCompletions } from '../runner/adapters';
import type { TurnModel, TurnResult, RunTurnOptions } from '../runner/run-turn';
import type * as diskJournal from './journal';

export function cancelOrphanedRunnerGenerations(): number;

/** Accept a dumped report_outcome or findings JSON when the report tool was never called. */
export function recoverBoardReportIfDumped(
  result: TurnResult,
  messages: unknown,
  role: string,
): TurnResult;

export interface RunnerEffector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string; worktree?: string }>;
  start(desired: {
    taskId: string | null;
    role: string;
    seedKind?: string;
    sameWorktree?: boolean;
  }): Promise<{
    attemptId: string;
    worktree?: string;
    discarded?: Record<string, unknown>[];
    gitInitialized?: Record<string, unknown>;
  }>;
  stop(attemptId: string): Promise<void>;
  /**
   * Check the model binding (including My Models remap/auto-load), role prompts, and isolated-worktree git init.
   */
  preflight(): Promise<{ gitInitialized?: Record<string, unknown> } | void>;
  onEnd(
    handler: (end: {
      attemptId: string;
      taskId: string | null;
      role: string;
      outcome: string;
      summary?: string;
      evidence?: Record<string, unknown>;
      sha?: string;
      files?: string[];
      runInstructions?: string;
      discarded?: Record<string, unknown>;
    }) => Promise<void> | void,
  ): void;
  readonly started: Array<{
    taskId: string | null;
    role: string;
    attemptId: string;
    seedKind?: string;
    worktree?: string;
  }>;
  vanishAll(): void;
}

export interface CreateRunnerEffectorOptions {
  boardId?: string;
  journal?: typeof diskJournal;
  getState?: () => BoardState | Promise<BoardState>;
  model?: TurnModel;
  cwd?: string;
  limits?: { maxTurns?: number; wallClockMs?: number };
  promptVariant?: 'full' | 'lite';
  runTurn?: (options: RunTurnOptions) => Promise<TurnResult>;
  /**
   * test seam.
   */
  runFinalLadder?: (input: {
    cwd: string;
    planPath?: string | null;
    signal?: AbortSignal;
    browser?: boolean;
  }) => Promise<{
    outcome: 'pass' | 'fail';
    runInstructions: string;
    summary: string;
    evidence: Record<string, unknown>;
  }>;
  deps?: RunnerDeps;
  postChatCompletions?: PostChatCompletions;
  /** Cancel persist:false generations not owned by a live attempt. Default false. */
  reapOrphans?: boolean;
  worktrees?: boolean;
}

export function createRunnerEffector(
  options?: CreateRunnerEffectorOptions,
): RunnerEffector;
