import type { RunnerDeps } from './adapters';
import type { TranscriptMessage, TranscriptStore } from './transcript-store';

export interface TurnUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: number | undefined;
}

export type TurnResult =
  | { outcome: 'pass'; summary: string; evidence: string[]; usage?: TurnUsage }
  | { outcome: 'fail'; summary: string; blockers: string[]; usage?: TurnUsage }
  | { outcome: 'blocked'; summary: string; needs: string[]; usage?: TurnUsage }
  | { outcome: 'no_report'; usage?: TurnUsage }
  | { outcome: 'crashed'; error: string; usage?: TurnUsage }
  | { outcome: 'timeout'; usage?: TurnUsage };

export type AttemptResult = TurnResult;

export type TurnPhase = 'generating' | 'thinking' | 'tools';

export type TurnEvent =
  | { type: 'response_restart'; warning: string }
  | { type: 'loading_model' }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_streaming'; name: string }
  | { type: 'tool_call'; name: string; id?: string; arguments?: unknown }
  | {
      type: 'tool_result';
      name: string;
      id?: string;
      content: string;
      attachments?: unknown[];
      codeChange?: unknown;
      isError?: boolean;
    }
  | { type: 'phase'; phase: TurnPhase }
  | { type: 'reasoning_end' }
  | {
      type: 'stream_meta';
      usage?: Record<string, number>;
      stats?: Record<string, unknown>;
      runtime?: unknown;
      model?: string;
      finishReason?: string;
    }
  | { type: 'round_start'; index: number }
  | {
      type: 'round_end';
      index: number;
      text: string;
      reasoning: string;
      toolCallCount: number;
      usage?: Record<string, number>;
      stats?: Record<string, unknown>;
      finishReason?: string;
      t0: number;
      tFirst: number | null;
      tEnd: number;
    };

export interface TurnModel {
  providerId: string;
  id: string;
  sampler?: { preset: Record<string, unknown>; maxTokens: number };
  thinking?: { mode: 'on' | 'off'; budgetTokens?: number | null };
}

export interface TurnLimits {
  maxTurns?: number;
  wallClockMs?: number;
  contextBudget?: unknown;
  modelContextLimit?: number | null;
}

export type ParseReportResult =
  | { ok: true; result: TurnResult }
  | { ok: false; error: string };

export type ParseReport = (raw: unknown) => ParseReportResult;

export interface TurnToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type TurnSeedKind = 'isolated' | 'continue';

export interface MessagesChangeMeta {
  settled: boolean;
}

export interface RunTurnOptions {
  chatId: string;
  seed: string;
  messages?: TranscriptMessage[];
  seedKind?: TurnSeedKind;
  tools: TurnToolDefinition[];
  /** Opt into search_tools discovery. Product callers pass the persisted setting (default on). */
  lazyTools?: boolean;
  model: TurnModel;
  onEvent?: (event: TurnEvent) => void;
  cwd?: string;
  transcript?: TranscriptStore;
  signal?: AbortSignal;
  limits?: TurnLimits;
  deps: RunnerDeps;
  reportToolName?: string | null;
  injectReportTool?: boolean;
  parseReport?: ParseReport;
  systemPrompt?: string;
  ask?: AskCapability | null;
  askTimeoutMs?: number;
  nudgeToolUse?: boolean;
  finalizeStructuredOutcome?: boolean;
  summarySchema?: string;
  onRoundBoundary?: () => TranscriptMessage[] | null;
  execute?: (
    name: string,
    args: unknown,
    ctx: { toolCallId: string; chatId: string; cwd?: string },
  ) => Promise<{ content: string }>;
}

export const DEFAULT_REPORT_TOOL_NAME: 'report_outcome';
export const ASK_QUESTION_TOOL_NAME: 'ask_question';
export const DEFAULT_ASK_TIMEOUT_MS: number;
export const ASK_QUESTION_UNAVAILABLE_ERROR: string;
export const ASK_QUESTION_TIMEOUT_ERROR: string;

export { buildOpeningMessages, buildOpeningTranscript } from './opening-messages';

export function resolveTurnTools(
  tools: TurnToolDefinition[] | undefined,
  options?: {
    reportToolName?: string | null;
    injectReportTool?: boolean;
    ask?: AskCapability | null;
  },
): TurnToolDefinition[];

export interface AskCapability {
  ask(
    question: unknown,
    ctx: { signal: AbortSignal; chatId: string },
  ): Promise<unknown>;
}

export function runTurn(options: RunTurnOptions): Promise<TurnResult>;
