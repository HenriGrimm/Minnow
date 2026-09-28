/**
 * Periodic tick loop that dispatches due scheduled jobs.
 */

import { listJobs, getStoredJobById, recomputeAllNextRuns } from './store.js';
import { runStoredJob, getActiveRunCount, MAX_CONCURRENT_RUNS } from './runner.js';

/** Poll interval for due jobs. */
export const TICK_INTERVAL_MS = 15_000;

/** @type {NodeJS.Timeout | null} */
let tickTimer = null;

/** Prevent overlapping tick handlers. */
let ticking = false;

/**
 * Find enabled jobs whose next run is due and start them.
 * @param {{ baseUrl?: string; now?: Date }} [options]
 */
export async function runSchedulerTick(options = {}) {
  if (ticking) {
    return { dispatched: 0, skipped: 'tick_in_progress' };
  }

  ticking = true;
  let dispatched = 0;
  try {
    const now = options.now ?? new Date();
    const jobs = await listJobs();
    for (const job of jobs) {
      if (!job.enabled || job.running) {
        continue;
      }
      if (!job.nextRunAt) {
        continue;
      }
      if (new Date(job.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      if (getActiveRunCount() >= MAX_CONCURRENT_RUNS) {
        break;
      }

      const stored = await getStoredJobById(job.id);
      if (!stored || stored.running) {
        continue;
      }

      const result = await runStoredJob(stored, { baseUrl: options.baseUrl });
      if (result.started) {
        dispatched += 1;
      }
    }
  } finally {
    ticking = false;
  }

  return { dispatched };
}

/**
 * Start the scheduler tick loop after server bootstrap.
 * @param {{ baseUrl?: string; intervalMs?: number }} [options]
 */
export async function startSchedulerTickLoop(options = {}) {
  if (tickTimer) {
    return;
  }

  await recomputeAllNextRuns();

  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
  const baseUrl = options.baseUrl;

  const tick = () => {
    void runSchedulerTick({ baseUrl }).catch((err) => {
      console.warn('[scheduler] tick failed:', err instanceof Error ? err.message : err);
    });
  };

  tick();
  tickTimer = setInterval(tick, intervalMs);
  if (typeof tickTimer.unref === 'function') {
    tickTimer.unref();
  }
}

/** Stop tick loop and clear timer (tests / shutdown). */
export function stopSchedulerTickLoop() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}
