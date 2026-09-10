import type { RunnerDeps, PostChatCompletions } from '../runner/adapters';
import type { TurnResult, RunTurnOptions, AskCapability, TurnEvent } from '../runner/run-turn';
import type { AttemptEnd } from '../orchestrator/engine';
import type { RunState } from './types';

/** The three pipeline stages that run headless in this wave. */
export const HEADLESS_ROLES: readonly ('research' | 'review' | 'polish')[];

/** Per-stage structured-outcome schema ids (review requires findings). */
export const STAGE_SUMMARY_SCHEMAS: Readonly<Record<string, string>>;

/** Resolve the structured-outcome schema id for one headless stage. */
export function schemaIdForStage(role: string): string;

/** `summarySchema` → `parseReport`. */
export function parseReportForStage(
  schemaId: string,
): import('../runner/run-turn').ParseReport;

/** One-stage seed from the derived run state. */
export function buildStageSeed(
  role: string,
  state: RunState,
  seedKind?: string,
): string;

export interface HeadlessEffector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string; cwd?: string }>;
  start(desired: {
    taskId: string | null;
    role: string;
    seedKind?: string;
  }): Promise<{ attemptId: string }>;
  stop(attemptId: string): Promise<void>;
  preflight(): Promise<void>;
  onEnd(
    handler: (end: AttemptEnd) => Promise<void> | void,
  ): void;
  readonly started: Array<{
    taskId: string | null;
    role: string;
    attemptId: string;
    seedKind?: string;
  }>;
  vanishAll(): void;
  seedTranscript(runId: string, messages: unknown[]): void;
}

export interface CreateHeadlessEffectorOptions {
  runId?: string;
  getState?: () => RunState | Promise<RunState>;
  model?: { providerId: string; id: string };
  limits?: { maxTurns?: number; wallClockMs?: number };
  runTurn?: (options: RunTurnOptions) => Promise<TurnResult>;
  deps?: RunnerDeps;
  postChatCompletions?: PostChatCompletions;
  schemaId?: string;
  systemPrompt?: string;
  ask?: AskCapability | null;
  onEvent?: (event: TurnEvent) => void;
}

export function createHeadlessEffector(
  options?: CreateHeadlessEffectorOptions,
): HeadlessEffector;
