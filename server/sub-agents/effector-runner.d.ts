import type { AgentsState } from './types';
import type { RunnerDeps, PostChatCompletions } from '../runner/adapters';
import type { TurnModel, TurnResult, RunTurnOptions, AskCapability } from '../runner/run-turn';

export function cancelOrphanedSubAgentGenerations(): number;

export function resolveSubAgentToolIds(typeRow: Record<string, unknown>): string[];

export function parseReportForSchema(
  schemaId: string,
): import('../runner/run-turn').ParseReport;

export function degradeNoReportIfProse(
  result: TurnResult,
  messages: unknown,
  schemaId: string,
): TurnResult;

export interface SubAgentEffector {
  inspect(): Array<{ taskId: string | null; role: string; attemptId: string; cwd?: string }>;
  start(desired: {
    taskId: string | null;
    role: string;
    seedKind?: string;
  }): Promise<{ attemptId: string }>;
  stop(attemptId: string): Promise<void>;
  preflight(): Promise<void>;
  onEnd(
    handler: (end: {
      attemptId: string;
      taskId: string | null;
      role: string;
      outcome: string;
      summary?: string;
      evidence?: Record<string, unknown>;
      usage?: Record<string, number>;
    }) => Promise<void> | void,
  ): void;
  readonly started: Array<{
    taskId: string;
    role: string;
    attemptId: string;
    seedKind?: string;
    cwd: string;
  }>;
  vanishAll(): void;
  seedTranscript(runId: string, messages: unknown[]): void;
}

export interface CreateSubAgentEffectorOptions {
  parentChatId?: string;
  getState?: () => AgentsState | Promise<AgentsState>;
  model?: TurnModel;
  limits?: { maxTurns?: number; wallClockMs?: number };
  runTurn?: (options: RunTurnOptions) => Promise<TurnResult>;
  deps?: RunnerDeps;
  postChatCompletions?: PostChatCompletions;
  loadConfig?: () => Promise<Record<string, unknown>>;
  getTypeRow?: (typeId: string) => Promise<Record<string, unknown> | null>;
  /** Cancel persist:false generations owned by vanished `sa-` attempts. Default false. */
  reapOrphans?: boolean;
  /**
   * Interactive ask handler. Default `null` (unattended). A parent-injected
   * capability later is this argument — not a product-named branch in the runner.
   */
  ask?: AskCapability | null;
}

export function createSubAgentEffector(
  options?: CreateSubAgentEffectorOptions,
): SubAgentEffector;
