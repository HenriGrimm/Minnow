/**
 * Machine-readable headless run result (CI artifacts, exit code mapping).
 */

export const HEADLESS_RESULT_VERSION = 1;

export interface HeadlessToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultPreview: string;
}

export interface HeadlessTurnRecord {
  generationId: string;
  finishReason: string | null;
  assistantText: string;
  toolCalls: HeadlessToolCallRecord[];
}

export interface HeadlessRunResult {
  version: number;
  ok: boolean;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  workspace: string | null;
  modeId: string;
  workAgentId: string | null;
  providerId: string;
  modelId: string;
  promptProfile: string;
  userPrompt: string;
  assistantFinal: string;
  turns: HeadlessTurnRecord[];
  stats: {
    toolRounds: number;
    durationMs: number;
  };
  error: string | null;
  /** Present when --persist-chat wrote this run into ~/.minnow sessions. */
  chatId: string | null;
  /** Durable receipt when an existing conversation remains server-owned. */
  managedChat?: { clientRequestId: string; commandId: string | null; executionId: string | null;
    state: string; disposition: string; link: string };
}

/** Stable key order for CI diff-friendly JSON. */
export function serializeHeadlessRunResult(result: HeadlessRunResult): string {
  const ordered = {
    version: result.version,
    ok: result.ok,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    workspace: result.workspace,
    modeId: result.modeId,
    workAgentId: result.workAgentId,
    providerId: result.providerId,
    modelId: result.modelId,
    promptProfile: result.promptProfile,
    userPrompt: result.userPrompt,
    assistantFinal: result.assistantFinal,
    turns: result.turns,
    stats: result.stats,
    error: result.error,
    chatId: result.chatId,
    ...(result.managedChat ? { managedChat: result.managedChat } : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Truncate tool output for JSON artifact size. */
export function previewToolResult(content: string, maxLen = 500): string {
  const t = content.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}
