import type { BoardState } from './core/types';

/** Opaque journal type. Derive ignores it so the report cannot feed decisions. */
export const REPORT_EVENT_TYPE: 'run.report.written';

export const REPORT_FILE: 'report.md';

/** Give up on the LLM writer and use the mechanical fallback. */
export const REPORT_COMPLETE_TIMEOUT_MS: 60000;

export const REPORT_SYSTEM_PROMPT: string;

export function reportPath(boardId: string): string;

export function journalHasReport(events: Iterable<{ type?: unknown }>): boolean;

export function eventsSinceReopen(
  events: Iterable<{ type?: unknown }>,
): Array<{ type?: unknown }>;

export function suggestedNextStep(abandonment: {
  taskId?: unknown;
  reason?: unknown;
  evidence?: unknown;
}): string;

export function compactReportEvent(event: Record<string, unknown>): Record<string, unknown>;

export function buildReportInput(
  events: Iterable<Record<string, unknown>>,
  state: BoardState,
): Record<string, unknown>;

export function buildReportMessages(
  input: Record<string, unknown>,
): Array<{ role: 'system' | 'user'; content: string }>;

export function formatMechanicalReport(input: Record<string, unknown>): string;

export function extractAssistantText(raw: string): string;

export function defaultComplete(args: {
  input: Record<string, unknown>;
  messages: Array<{ role: string; content: string }>;
  model?: { providerId?: string; id?: string } | null;
}): Promise<string>;

export function persistReport(boardId: string, markdown: string): Promise<string>;

export function readReport(boardId: string): Promise<string | null>;

export type ReportComplete = (args: {
  input: Record<string, unknown>;
  messages: Array<{ role: string; content: string }>;
  /** The board's bound model; null when none was set. */
  model?: { providerId?: string; id?: string } | null;
}) => Promise<string>;

export function writeEndOfRunReport(options: {
  boardId: string;
  events: Iterable<Record<string, unknown>>;
  state: BoardState;
  complete?: ReportComplete;
  persist?: (boardId: string, markdown: string) => Promise<string>;
  /** Override the LLM writer timeout (tests). Default REPORT_COMPLETE_TIMEOUT_MS. */
  completeTimeoutMs?: number;
}): Promise<{
  markdown: string;
  input: Record<string, unknown>;
  messages: Array<{ role: string; content: string }>;
  path: string;
  relativePath: string;
  usedFallback: boolean;
}>;
