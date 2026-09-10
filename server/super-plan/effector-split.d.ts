import type { AttemptEnd, Effector } from '../orchestrator/engine';

/** One scripted-effector rule, mirroring the JSDoc typedef in effector-scripted.js. */
export interface ScriptRule {
  match?: { taskId?: string; role?: string; nth?: number };
  emit?: {
    outcome?: string;
    summary?: string;
    evidence?: Record<string, unknown>;
    sha?: string;
    files?: string[];
    delayMs?: number;
    vanish?: boolean;
    worktree?: string;
  };
}

export interface SplitEffector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string; handle?: unknown }>;
  start(desired: {
    taskId: string | null;
    role: string;
    seedKind?: string;
  }): Promise<{ attemptId: string; worktree?: string }>;
  stop(attemptId: string): Promise<void>;
  onEnd(handler: (end: AttemptEnd) => Promise<void> | void): void;
  readonly started: Array<{
    taskId: string | null;
    role: string;
    attemptId: string;
    seedKind?: string;
  }>;
  vanishAll(): void;
}

export interface CreateSplitEffectorOptions {
  byRole?: Record<string, Effector | (() => Effector)>;
  fallback?: Effector | (() => Effector);
  script?: ScriptRule[];
  clock?: {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
  };
  defaultOutcome?: string;
}

export function createSplitEffector(
  options?: CreateSplitEffectorOptions,
): SplitEffector;

export type { Effector };
