/**
 * Refresh shared dependency dirs after manifest/lockfile changes land in integration.
 * Best-effort only — failures are logged and never thrown.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { killProcessTree } from '../terminal-runner.js';
import { installSpawnTarget } from './dep-install-spawn.js';
import { ECOSYSTEM_ENTRIES, materializeDepDirs } from './dep-symlinks.js';
import { runWorktreeSetupProcess } from './setup-process.js';

const INSTALL_TIMEOUT_MS = 600_000;

function installFailure(label, reason) {
  const detail = String(reason).trim();
  return `${label} (${detail.length > 2000 ? `…${detail.slice(-2000)}` : detail})`;
}

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run ecosystem install commands when `changedFiles` touched a manifest or lockfile.
 * Remove seed junctions first so the install cannot write into the main workspace.
 * Windows `shell:true` spawns cmd.exe, so SIGTERM alone is not enough — kill the tree.
 * @param {string} root — integration worktree root (absolute)
 * @param {string[]} changedFiles — paths from a post-merge git diff
 * @param {{ timeout?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ran: string[], failed: string[] }>}
 */
export async function refreshDependencies(root, changedFiles, { timeout = INSTALL_TIMEOUT_MS, signal } = {}) {
  signal?.throwIfAborted();
  const ran = [];
  const failed = [];

  try {
    const changedBasenames = new Set(changedFiles.map((f) => path.basename(f)));
    const seenCommands = new Set();

    for (const entry of ECOSYSTEM_ENTRIES) {
      signal?.throwIfAborted();
      const triggers = [...entry.manifests, ...(entry.lockfiles ?? [])];
      if (!triggers.some((name) => changedBasenames.has(name))) continue;

      const hasManifest = await Promise.all(
        entry.manifests.map((manifest) => pathExists(path.join(root, manifest))),
      );
      if (!hasManifest.some(Boolean)) continue;

      const install = await entry.resolveInstall(root);
      if (!install) continue;

      const dedupeKey = `${install.command}\0${install.args.join('\0')}`;
      if (seenCommands.has(dedupeKey)) continue;
      seenCommands.add(dedupeKey);

      const label = `${install.command} ${install.args.join(' ')}`;

      const materialized = await materializeDepDirs(root, entry.dirs);
      if (materialized.failed.length > 0) {
        const dirs = materialized.failed.join(', ');
        const reason = `${dirs} link could not be removed — refusing to install through it`;
        failed.push(`${label} (${reason})`);
        console.warn(`[dep-install] skipped ${label} in ${root}: ${reason}`);
        continue;
      }

      try {
        const target = installSpawnTarget(install);
        const result = await (signal ? runWorktreeSetupProcess : runProcess)(target.command, target.args, {
          cwd: root,
          timeout,
          shell: target.shell,
          killTree: killProcessTree,
          signal,
        });
        if (result.code === 0) {
          ran.push(label);
        } else {
          const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
          failed.push(installFailure(label, `exit ${result.code}${detail ? `: ${detail}` : ''}`));
          console.warn(
            `[dep-install] ${label} exited ${result.code}${detail ? `: ${detail}` : ''}`,
          );
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        failed.push(installFailure(label, message));
        console.warn(`[dep-install] ${label} failed: ${message}`);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    failed.push(installFailure('Dependency setup', message));
    console.warn(`[dep-install] unexpected error: ${message}`);
  }

  return { ran, failed };
}
