/**
 * One-shot Minnow server runtime initialization (home layout, workspace, APIs).
 * Callable from server.js or a future Electron HTTP host before listen.
 */

import { ensureAgentPacksLayout } from '../agent-packs/registry.js';
import { ensureBenchmarkWorkspace } from '../benchmark-workspace/paths.js';
import { ensureChatsWorkspace } from '../chats-workspace/paths.js';
import { ensureSchedulerWorkspace } from '../scheduler-workspace/paths.js';
import { ensureMinnowLayoutInitialized, getMinnowHome } from '../config/home.js';
import { sweepCheckpoints } from '../generations/checkpoint.js';
import { initLspConfig } from '../lsp/middleware.js';
import { initMcpApi } from '../mcp/middleware.js';
import { initServersApi } from '../servers/index.js';
import { initMemoryApi } from '../memory/routes.js';
import { initBrainApi } from '../brain/routes.js';
import { ensureProviderRegistry } from '../providers/store.js';
import { snapshotSessionsDbIfDue } from '../config/sessions-snapshot.js';
import { initPluginsApi } from '../tools/middleware.js';
import { initWorkspaceRoot } from '../workspace/root.js';
import { recomputeAllNextRuns } from '../scheduler/store.js';
import { applyPendingRestore } from '../backup/restore-apply.js';
import { startBackupScheduleLoop } from '../backup/schedule.js';
import { writeHostLock } from './host-lock.js';

/**
 * Log the outcome of a boot-time restore swap. Silent when nothing was pending.
 * @param {{ applied: boolean, kind?: string, error?: string }} result
 */
export function reportPendingRestore(result) {
  if (result.applied) {
    console.log(
      result.kind === 'rollback'
        ? '[backup] Undid the last restore; the previous data is back in place.'
        : '[backup] Restore applied. The previous data is kept under pre-restore/.',
    );
  } else if (result.error) {
    console.warn(`[backup] Pending ${result.kind ?? 'restore'} could not be applied: ${result.error}`);
  }
}

/**
 * Ensure ~/.minnow layout, load workspace and API registries.
 * Sweep old generation checkpoints so they do not outlive a returning client.
 * Take a rotating `sessions.db` snapshot off the critical path (throttled to at
 * most one per 12 h, so a restart loop cannot thrash the disk).
 *
 * A restore staged by Settings or `minnow restore` is swapped in first, before
 * any store opens the home. Both hosts also do this earlier, ahead of their own
 * config reads; this call is the backstop and a no-op when nothing is pending.
 * @returns {Promise<{ workspacePath: string, homePath: string }>}
 */
export async function bootstrapMinnowRuntime() {
  reportPendingRestore(applyPendingRestore());
  writeHostLock();
  await ensureMinnowLayoutInitialized();
  await ensureChatsWorkspace();
  await ensureBenchmarkWorkspace();
  await ensureSchedulerWorkspace();
  await ensureAgentPacksLayout();
  const workspacePath = await initWorkspaceRoot();
  await ensureProviderRegistry();
  await initMemoryApi();
  await initBrainApi();
  await initLspConfig();
  await initMcpApi();
  await initServersApi();
  await initPluginsApi();
  await recomputeAllNextRuns();
  sweepCheckpoints();
  setImmediate(() => {
    void import('../terminal-runner.js').then((m) => m.warmupTerminalPlatformCaches());
  });
  setImmediate(() => {
    void snapshotSessionsDbIfDue();
  });
  startBackupScheduleLoop();
  const homePath = getMinnowHome();
  return {
    workspacePath,
    homePath,
  };
}
