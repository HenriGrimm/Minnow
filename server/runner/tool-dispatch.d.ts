import type { RunHeadlessToolBatch } from './adapters';
import type { ToolCallOutcome } from './tool-batch';

export interface ExecuteInProcessToolOptions {
  /** Attempt root. Required — never defaults to the Code workspace. */
  cwd: string;
  /** Forwarded to the HTTP-layer plan-write guard. */
  modeId?: string | null;
  /** When set, names outside this set are rejected before the registry. */
  allowedToolNames?: Iterable<string> | Set<string> | null;
  toolCallId?: string;
  runtimeOwner?: { chatId: string; runId: string; agentId: string };
}

export interface InProcessToolResult {
  content: string;
  attachments?: unknown;
  codeChange?: unknown;
}

/**
 * Execute one tool against the server registry in-process.
 * Same handlers and HTTP-layer guards as POST `/api/tools`.
 */
export function executeInProcessTool(
  name: string,
  args: Record<string, unknown> | undefined,
  options: ExecuteInProcessToolOptions,
): Promise<InProcessToolResult>;

export interface CreateInProcessToolDispatchOptions {
  cwd: string;
  modeId?: string | null;
  allowedToolNames?: Iterable<string> | Set<string> | null;
  runtimeOwner?: { chatId: string; runId: string; agentId: string };
}

export interface InProcessToolDispatch {
  execute: (
    name: string,
    args: unknown,
    ctx?: { toolCallId?: string },
  ) => Promise<InProcessToolResult>;
  runHeadlessToolBatch: RunHeadlessToolBatch;
  cwd: string;
}

/**
 * Close over attempt `cwd` so `runTurn` can inject `execute` + `runHeadlessToolBatch`.
 * Throws if `cwd` is missing or blank.
 */
export function createInProcessToolDispatch(
  options: CreateInProcessToolDispatchOptions,
): InProcessToolDispatch;
