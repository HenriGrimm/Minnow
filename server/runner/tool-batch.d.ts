export const STOPPED_TOOL_MSG: 'Stopped by user.';
export const TOOL_ARGUMENTS_INVALID_JSON: 'Tool arguments were not valid JSON.';
export const TOOL_ARGUMENTS_EMPTY: string;

export interface ParseToolArgumentsOptions {
  constrained?: boolean;
}

export interface ParseToolArgumentsResult {
  args: Record<string, unknown>;
  parseError?: string;
}

export function parseToolArguments(
  raw: string,
  options?: ParseToolArgumentsOptions,
): ParseToolArgumentsResult;

export interface PoolWorkItem<T> {
  id: string;
  payload: T;
}

export interface RunWithConcurrencyOptions<T, R> {
  items: PoolWorkItem<T>[];
  concurrency: number;
  signal?: AbortSignal;
  worker: (ctx: { item: PoolWorkItem<T>; signal: AbortSignal }) => Promise<R>;
}

export function runWithConcurrency<T, R>(
  options: RunWithConcurrencyOptions<T, R>,
): Promise<{ results: R[]; aborted: boolean }>;

export const ABORT_GRACE_MS: number;

export interface ToolCallOutcome {
  toolCall: { id: string; function: { name: string; arguments: string } };
  parseError?: string;
  result?: { content: string; attachments?: unknown; codeChange?: unknown };
  /** Set when the call was given up on rather than settling on its own. */
  abandoned?: 'timeout' | 'aborted';
}

export interface ExecuteToolBatchOptions {
  toolCalls: ToolCallOutcome['toolCall'][];
  constrained?: boolean;
  signal?: AbortSignal;
  /** Overrides the per-tool ceiling from `tool-timeouts.js`. */
  toolTimeoutMs?: number;
  execute: (
    name: string,
    args: unknown,
    ctx: { toolCallId: string },
  ) => Promise<{ content: string }>;
  onToolStart?: (tc: ToolCallOutcome['toolCall'], args: unknown) => void;
  onToolDone?: (outcome: ToolCallOutcome) => void;
  onParallelSegmentStart?: (calls: ToolCallOutcome['toolCall'][]) => void;
}

export function executeToolCallBatch(
  options: ExecuteToolBatchOptions,
): Promise<ToolCallOutcome[]>;
