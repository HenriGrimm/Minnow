import type { RunState } from './types';

export function buildResearchBrief(state: RunState, spec: string | null): string;

export function runResearchStage(input: {
  engine: { getState: () => RunState; append: (events: Record<string, unknown>[]) => Promise<unknown> };
  runId: string;
  attemptId?: string;
  signal: AbortSignal;
  store?: Record<string, (...args: any[]) => any>;
  resolveBinding?: (state: RunState) => Promise<{ providerId: string; id: string }>;
  pollMs?: number;
}): Promise<{ outcome: 'ok' | 'crashed'; summary: string; evidence?: Record<string, unknown> }>;
