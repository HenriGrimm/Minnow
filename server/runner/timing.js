/** Payload-free local timings. Intervals may overlap (parallel tools/batches). */
export function createRunnerTiming(emit, clock = () => performance.now(), wall = () => Date.now()) {
  const startedAt = wall();
  return {
    start() { return clock(); },
    end(stage, start, details = {}) {
      emit({ type: 'runner_timing', startedAt, at: wall(), stage,
        durationMs: Math.max(0, clock() - start), ...details });
    },
  };
}
