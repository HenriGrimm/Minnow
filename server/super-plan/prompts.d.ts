import type { RunState, SeedKind, StageId } from './types';

export interface StageContext {
  cwd: string;
  date: string;
  specPath: string;
  researchPath: string;
  planPath: string;
  researchUsable: boolean;
  questionBudget: number;
}

export const REPORT_TOOL_NAME: 'report_outcome';

export function interpolate(template: string, vars: Record<string, string | number>): string;
export function buildSystemPrompt(role: StageId, state: RunState, ctx: StageContext): string;
export function buildSeed(role: StageId, seedKind: SeedKind, state: RunState, ctx: StageContext & { errors: string[] }): string;
export function reportToolFor(role: StageId): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export function interviewAskTool(): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export function parseReportFor(
  role: StageId,
  onReport: (report: Record<string, unknown>) => void,
): (raw: unknown) => { ok: true; result: { outcome: 'pass'; summary: string; evidence: string[] } } | { ok: false; error: string };
