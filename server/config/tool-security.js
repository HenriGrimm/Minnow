/**
 * Tool path security flags from persisted config.json (`toolSecurity` block).
 */

import { readConfigJson } from './store.js';
import { normalizeShellSandboxMode, clampShellSandboxModeForPlatform } from '../terminal/sandbox/mode.js';
import { normalizePermissionLevel } from '../../src/lib/permissions.mjs';

/**
 * The one system-wide agent permission level (Manual / Auto / Full access).
 * @returns {Promise<'manual'|'auto'|'full'>}
 */
export async function getPermissionLevelFromConfig() {
  try {
    const meta = await readConfigJson('config.json');
    const ts = meta && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta).toolSecurity : null;
    if (ts && typeof ts === 'object') return normalizePermissionLevel(/** @type {Record<string, unknown>} */ (ts).permissionLevel);
  } catch {
    /* ignore */
  }
  return normalizePermissionLevel(undefined);
}

/**
 * Filesystem reach follows the permission level: Full access reaches the whole
 * disk; Manual and Auto stay in the workspace unless one call was approved.
 * @returns {Promise<'workspace'|'full'>}
 */
export async function getFilesystemAccessFromConfig() {
  if ((await getPermissionLevelFromConfig()) === 'full') return 'full';
  // Migration: an install that opted into the old "Full disk" switch and has
  // not picked a permission level yet keeps whole-disk reach. Saving a level
  // drops the legacy flag (validators.js).
  try {
    const meta = await readConfigJson('config.json');
    const ts = meta && typeof meta === 'object' ? /** @type {Record<string, unknown>} */ (meta).toolSecurity : null;
    if (ts && typeof ts === 'object') {
      const row = /** @type {Record<string, unknown>} */ (ts);
      if (row.permissionLevel === undefined && row.filesystemAccess === 'full') return 'full';
    }
  } catch {
    /* ignore */
  }
  return 'workspace';
}

/**
 * Agent shell sandbox setting (MIN-553 Phase 3). Default off.
 * @returns {Promise<'off'|'prefer'|'require'>}
 */
export async function getShellSandboxFromConfig() {
  try {
    const meta = await readConfigJson('config.json');
    if (meta && typeof meta === 'object') {
      const ts = /** @type {Record<string, unknown>} */ (meta).toolSecurity;
      if (ts && typeof ts === 'object') {
        return clampShellSandboxModeForPlatform(
          normalizeShellSandboxMode(
            /** @type {Record<string, unknown>} */ (ts).shellSandbox,
            'off',
          ),
        );
      }
    }
  } catch {
    /* ignore */
  }
  return clampShellSandboxModeForPlatform(normalizeShellSandboxMode(undefined, 'off'));
}

/**
 * Persisted "Always allow" for prefer-mode unsandboxed fallback (MIN-553 Phase 3).
 * @returns {Promise<boolean>}
 */
export async function getAllowUnsandboxedShellFromConfig() {
  try {
    const meta = await readConfigJson('config.json');
    if (meta && typeof meta === 'object') {
      const ts = /** @type {Record<string, unknown>} */ (meta).toolSecurity;
      if (ts && typeof ts === 'object') {
        return /** @type {Record<string, unknown>} */ (ts).allowUnsandboxedShell === true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Autopilot default for board shell sandbox (legacy; boards use toolSecurity.shellSandbox).
 * @returns {Promise<'off'|'prefer'|'require'>}
 */
export async function getAutopilotShellSandboxFromConfig() {
  return getShellSandboxFromConfig();
}
