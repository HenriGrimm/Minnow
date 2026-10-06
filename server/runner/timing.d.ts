export interface RunnerTimingEvent {
  type: 'runner_timing';
  startedAt: number;
  at: number;
  stage: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface RunnerTiming {
  start(): number;
  end(stage: string, start: number, details?: Record<string, unknown>): void;
}

export function createRunnerTiming(
  emit: (event: RunnerTimingEvent) => void,
  clock?: () => number,
  wall?: () => number,
): RunnerTiming;
