import type { BoardState, Desired, StopReason } from './core/types';
import type { ReportComplete } from './report';
import type * as diskJournal from './journal';

export const DEFAULT_TICK_MS: number;
export const DEFAULT_ENGINE_NAMESPACE: 'boards';

export const systemClock: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export interface Effector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string; handle?: unknown }>;
  start(desired: Desired): Promise<{
    attemptId: string;
    worktree?: string;
    discarded?: Record<string, unknown>[];
    gitInitialized?: Record<string, unknown>;
  }>;
  stop(attemptId: string): Promise<void>;
  setPaused?(paused: boolean): void;
  onEnd?(handler: (end: AttemptEnd) => Promise<void> | void): void;
  preflight?(): Promise<{ gitInitialized?: Record<string, unknown> } | void>;
}

export interface AttemptEnd {
  attemptId: string;
  taskId: string | null;
  role: string;
  outcome: string;
  summary?: string;
  evidence?: Record<string, unknown>;
  sha?: string;
  files?: string[];
  beforeSha?: string;
  runInstructions?: string;
  discarded?: Record<string, unknown>;
  usage?: Record<string, number>;
}

/**
 * Fold + scheduler + the predicates a tick calls.
 */
export interface Graph {
  foldInto(state: unknown, events: Iterable<unknown>): unknown;
  plan(
    state: unknown,
  ): Array<{ taskId: string | null; role: string; seedKind?: string; sameWorktree?: boolean }>;
  impliedEvents?(state: unknown): Record<string, unknown>[];
  isRunComplete?(state: unknown): boolean;
  eventsForRunComplete?(state: unknown): Record<string, unknown>[];
  isAgentRole?(role: string): boolean;
  isAlreadyEnded?(state: unknown, attemptId: string): boolean;
  reapVanished?(state: unknown, live: Set<string>, buffered: Set<string>): Record<string, unknown>[];
  eventsForStart?(
    want: Desired,
    handle: {
      attemptId: string;
      worktree?: string;
      discarded?: Record<string, unknown>[];
      gitInitialized?: Record<string, unknown>;
    },
  ): Record<string, unknown>[];
  eventsForPreflight?(
    result: { gitInitialized?: Record<string, unknown> } | void,
  ): Record<string, unknown>[];
  eventsForAttemptEnd?(
    end: AttemptEnd,
    ctx: { id: string; state: unknown },
  ): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  onLoad?(ctx: { id: string; state: unknown }): Promise<Record<string, unknown>[]>;
  writeReport?(ctx: {
    id: string;
    state: unknown;
    events: Record<string, unknown>[];
    complete: ReportComplete;
    signal?: AbortSignal;
  }): Promise<{ relativePath: string; usedFallback: boolean } | null>;
  reportEventType?: string;
  hasReport?(events: Record<string, unknown>[]): boolean;
  complete?: ReportComplete;
  formatReport?(input: Record<string, unknown>): string | Promise<string>;
  manualStart?(
    state: unknown,
    taskId: string,
    running?: ReadonlyArray<{ taskId: string | null; role: string }>,
  ): { kind: string; role?: string; seedKind?: string; sameWorktree?: boolean };
  reopenTargets?(state: unknown, requested?: readonly string[]): Iterable<string>;
  buildIntegrationFixTask?(state: unknown): { task: unknown; wave?: unknown };
  defaultConcurrency?: number;
}

export interface CreateEngineOptions {
  boardId: string;
  effector: Effector;
  graph?: Graph;
  clock?: typeof systemClock;
  tickMs?: number;
  journal?: typeof diskJournal;
  complete?: ReportComplete;
}

export interface Engine {
  load(): Promise<void>;
  reload(): Promise<void>;
  getState(): BoardState;
  getHighestSeq(): number;
  getEvents(): Promise<Record<string, unknown>[]>;
  append(events: Record<string, unknown>[]): Promise<Record<string, unknown>[]>;
  preflight(): Promise<void>;
  getStartFailures(): Array<{
    role: string;
    taskId: string | null;
    consecutive: number;
    message: string;
  }>;
  setModel(model: { providerId: string; id: string; reasoning?: string | null }): Promise<void>;
  rename(name: string): Promise<void>;
  abandonTask(taskId: string, reason?: string): Promise<boolean>;
  /** Skip by hand: dependents treat the card as done. */
  mergeAndSkipTask(taskId: string): Promise<{ ok: boolean; reason?: string }>;
  skipTask(taskId: string): Promise<{ ok: boolean; reason?: string }>;
  startBoard(concurrency: number): Promise<boolean | void>;
  pauseBoard(): Promise<boolean>;
  stopBoard(reason?: StopReason): Promise<void>;
  setConcurrency(concurrency: number): Promise<void>;
  startTask(taskId: string): Promise<boolean>;
  editTask(
    taskId: string,
    changes: import('./core/types').TaskEditChanges,
    reason?: string,
  ): Promise<{ ok: boolean; changed: string[]; reason?: string }>;
  resyncFromPlan(
    planTasks: ReadonlyArray<Record<string, any>>,
    planWaves: ReadonlyArray<{ n: number; name: string }>,
    opts?: { dryRun?: boolean },
  ): Promise<{ applied: boolean; result: import('./core/types').PlanResync }>;
  resetTask(
    taskId: string,
    reason?: string,
  ): Promise<{ ok: boolean; taskIds: string[]; reason?: string }>;
  rewindFrom(
    taskId: string,
    reason?: string,
  ): Promise<{ ok: boolean; taskIds: string[]; reason?: string }>;
  reopen(
    opts?: { taskIds?: string[]; concurrency?: number },
    reason?: string,
  ): Promise<{ ok: boolean; taskIds: string[]; reason?: string }>;
  tick(): Promise<void>;
  subscribe(handler: (event: Record<string, unknown>) => void): () => void;
  dispose(): void;
}

export function createEngine(options: CreateEngineOptions): Engine;

export function getEngine(
  boardId: string,
  makeEffector: () => Effector,
  options?: {
    clock?: typeof systemClock;
    tickMs?: number;
    namespace?: string;
    graph?: Graph;
    journal?: typeof diskJournal;
    complete?: ReportComplete;
  },
): Promise<Engine>;

export function peekEngine(boardId: string, namespace?: string): Engine | undefined;

export function disposeEngines(boardId?: string, namespace?: string): void;

export { isReadyForFinalTest } from './board-graph';
