export interface RunnerTimingEvent {
  type: 'runner_timing';
  /** Never compare monotonic offsets from different recorders. */
  clockId: string;
  startedAt: number;
  at: number;
  stage: string;
  durationMs: number;
  /** Offsets within this recorder's monotonic clock, never cross-process clocks. */
  startOffsetMs: number;
  endOffsetMs: number;
  [key: string]: unknown;
}

export interface RunnerTiming {
  start(): number;
  end(stage: string, start: number, details?: Record<string, unknown>): void;
}

export interface RunnerTimingReport {
  version: 1;
  intervalsOverlap: true;
  events: Array<{ stage: string; durationMs: number; clockId?: string; correlationId?: string; category?: string;
    startOffsetMs?: number; endOffsetMs?: number; index?: number; count?: number }>;
  totals: Record<string, { count: number; durationMs: number }>;
  dropped: number;
}
export function createRunnerTimingJournal(limit?: number): { report: RunnerTimingReport; record(event: Partial<RunnerTimingEvent>): void };

export function createRunnerTiming(
  emit: (event: RunnerTimingEvent) => void,
  clock?: () => number,
  wall?: () => number,
): RunnerTiming;
