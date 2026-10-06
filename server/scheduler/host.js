/**
 * Scheduler lifecycle for a Minnow host process.
 *
 * Both hosts — `server.js` in a checkout and the Electron in-process server in
 * an installed build — call these two functions. Wiring the tick loop by hand
 * in one host and not the other is how installed builds shipped a Scheduler
 * that never ran a job.
 */

import { shutdownSchedulerRuns } from './runner.js';
import { setSchedulerServerBaseUrl } from './server-base-url.js';
import { startSchedulerTickLoop, stopSchedulerTickLoop } from './tick.js';

/**
 * Start dispatching due jobs. Call once the HTTP server is listening: a run is
 * a child process that calls back into this server at `baseUrl`.
 * @param {string} baseUrl Origin of this host's HTTP server.
 */
export async function startSchedulerForHost(baseUrl) {
  const origin = String(baseUrl ?? '').trim().replace(/\/$/, '');
  setSchedulerServerBaseUrl(origin);
  await startSchedulerTickLoop({ baseUrl: origin || undefined });
}

/** Stop dispatching and end runs in flight. Safe to call more than once. */
export function stopSchedulerForHost() {
  stopSchedulerTickLoop();
  shutdownSchedulerRuns();
}
