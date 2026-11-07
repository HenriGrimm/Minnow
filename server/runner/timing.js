const strings = new Set(['name', 'id', 'correlationId', 'category']);
const numbers = new Set(['index', 'count']);
const safeNumber = value => Number.isFinite(value) ? Math.max(0, value) : 0;
let recorderSequence = 0;
// Separate renderer/server/process clock domains even when wall time and local
// recorder sequence happen to match. This is correlation, not an authority ID.
const clockDomain = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

/** Bounded payload-free per-execution evidence. Persist once with settlement,
 * never once per delta; stage totals overlap and are not an end-to-end sum. */
export function createRunnerTimingJournal(limit = 256) {
  const report = { version: 1, intervalsOverlap: true, events: [], totals: Object.create(null), dropped: 0 };
  const cap = Math.max(1, Math.min(256, Number.isSafeInteger(limit) ? limit : 256));
  return {
    report,
    record(event) {
      if (!event || !/^[a-z][a-z0-9_]{0,79}$/.test(event.stage) || !Number.isFinite(event.durationMs)) return;
      const row = { stage: event.stage, durationMs: safeNumber(event.durationMs) };
      for (const key of ['clockId', 'correlationId', 'category']) if (typeof event[key] === 'string') row[key] = event[key].slice(0, 160);
      for (const key of ['startOffsetMs', 'endOffsetMs', 'index', 'count']) if (Number.isFinite(event[key])) row[key] = event[key];
      report.events.push(row);
      if (report.events.length > cap) { report.events.shift(); report.dropped++; }
      // Unknown stages cannot grow unbounded diagnostics state.
      if (Object.hasOwn(report.totals, row.stage) || Object.keys(report.totals).length < 64) {
        const total = report.totals[row.stage] ??= { count: 0, durationMs: 0 };
        total.count++; total.durationMs += row.durationMs;
      }
    },
  };
}

/** Payload-free local timings. Intervals may overlap (parallel tools/batches).
 * Observers are best effort: diagnostics must never fail or delay execution.
 * startOffsetMs/endOffsetMs share one monotonic clock, not the wall clock.
 */
export function createRunnerTiming(emit, clock = () => performance.now(), wall = () => Date.now()) {
  const startedAt = wall();
  const origin = clock();
  const clockId = `${clockDomain}-${++recorderSequence}`;
  return {
    start() { return clock(); },
    end(stage, start, details = {}) {
      try {
        const end = clock();
        const metadata = {};
        for (const key of strings) {
          if (typeof details[key] === 'string') metadata[key] = details[key].slice(0, 160);
        }
        for (const key of numbers) {
          if (Number.isFinite(details[key])) metadata[key] = details[key];
        }
        emit({ ...metadata, type: 'runner_timing', clockId, startedAt, at: wall(),
          stage: String(stage).slice(0, 80), durationMs: safeNumber(end - start),
          startOffsetMs: safeNumber(start - origin), endOffsetMs: safeNumber(end - origin),
        })?.catch?.(() => {});
      } catch { /* Timing observers never own the turn. */ }
    },
  };
}
