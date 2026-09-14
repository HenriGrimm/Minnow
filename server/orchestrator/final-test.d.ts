import type { BrowserRungResult, runBrowserRung } from './browser-rung';

export const LADDER_RUNG_IDS: readonly ['typecheck', 'lint', 'unit', 'build'];

export const ALL_RUNG_IDS: readonly ['typecheck', 'lint', 'unit', 'build', 'browser'];

export const DEFAULT_RUNG_COMMANDS: {
  typecheck: string;
  lint: string;
  unit: string;
  build: string;
};

export const BASELINE_RELATIVE_PATHS: string[];

export type LadderRungId = 'typecheck' | 'lint' | 'unit' | 'build';

export interface LadderRung {
  id: LadderRungId;
  command: string;
}

export interface RungBaseline {
  expectedExitCode?: number;
  failingPatterns?: string[];
}

export type FinalTestBaseline = Partial<Record<LadderRungId, RungBaseline>>;

/** One rung's own verdict, carried on `final.test.ended`'s `evidence.rungs`. */
export interface LadderRungResult {
  id: 'typecheck' | 'lint' | 'unit' | 'build' | 'browser';
  command: string;
  exitCode: number;
  outcome: 'pass' | 'fail' | 'blocked';
  matchedBaseline?: boolean;
  /** Present only on a blocked browser rung. */
  reason?: string | null;
}

/**
 * `evidence.browser` on `final.test.ended`.
 */
export interface BrowserRungEvidence {
  status: 'pass' | 'fail' | 'blocked';
  reason: string | null;
  summary: string;
  runInstructions: string;
  url: string | null;
  appCommand: string | null;
  port: number | null;
  assertions: BrowserRungResult['assertions'];
  notObservable: BrowserRungResult['notObservable'];
  screenshots: BrowserRungResult['screenshots'];
}

export interface LadderEvidence {
  failedRung: string | null;
  blockedRung: string | null;
  ran: string[];
  output: string;
  cwd: string;
  rungs: LadderRungResult[];
  browser: BrowserRungEvidence | null;
}

export interface LadderResult {
  outcome: 'pass' | 'fail';
  runInstructions: string;
  summary: string;
  evidence: LadderEvidence & Record<string, unknown>;
}

export function formatRunInstructions(input: { command: string; cwd: string }): string;

export function parseRunInstructions(
  text: string,
): { command: string; cwd: string; url?: string; steps?: string[] } | null;

export function capLadderOutput(text: string, max?: number): string;

export function classifyLadderCommand(command: string): LadderRungId | null;

export function parseVerificationChecklist(
  markdown: string,
): Partial<Record<LadderRungId, string>>;

export function formatLadderPromptBlock(rungs: LadderRung[]): string;

export function resolveLadderRungs(input?: {
  planMarkdown?: string | null;
  packageJson?: unknown;
}): LadderRung[];

export function matchesKnownBaseline(
  rungId: LadderRungId,
  actual: { exitCode: number; output: string },
  baseline: FinalTestBaseline | null | undefined,
): boolean;

export function loadFinalTestBaseline(cwd: string): Promise<FinalTestBaseline | null>;

export function loadPlanMarkdown(cwd: string, planPath?: string | null): Promise<string>;

/** process.env for a rung, with `<cwd>/node_modules/.bin` first on PATH. */
export function ladderEnv(cwd: string): NodeJS.ProcessEnv;

export function execLadderCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<{ exitCode: number; output: string }>;

export function runFinalLadder(input: {
  cwd: string;
  planPath?: string | null;
  planMarkdown?: string | null;
  baseline?: FinalTestBaseline | null;
  signal?: AbortSignal;
  execCommand?: typeof execLadderCommand;
  timeoutMs?: number;
  /** `false` skips the browser rung entirely. Default: run it. */
  browser?: boolean;
  browserRung?: typeof runBrowserRung;
  browserOptions?: Record<string, unknown>;
  browserTimeoutMs?: number;
}): Promise<LadderResult>;

export function finalAttemptEnd(
  attemptId: string,
  result: LadderResult,
): {
  attemptId: string;
  taskId: null;
  role: 'final';
  outcome: 'pass' | 'fail';
  summary: string;
  runInstructions: string;
  evidence: LadderEvidence & Record<string, unknown>;
};
