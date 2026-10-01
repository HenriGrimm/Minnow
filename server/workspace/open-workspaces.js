/**
 * In-memory set of workspace folders that currently have a view (window or tab)
 * open on them. This is the filesystem security boundary for multi-workspace
 * Minnow: `isAllowedWorkspaceRoot` admits membership here instead of equality
 * with the one global root.
 *
 * Deliberately **not persisted**. A restart starts empty and windows re-register
 * as they boot — persisting it would let a stale entry silently widen the
 * filesystem boundary after a crash.
 *
 * Electron main is the authority (it owns the window/tab registry) and drives
 * this through `POST /api/workspace/open` and `DELETE /api/workspace/open`.
 */

import path from 'node:path';
import { disposeCodexSessions } from '../generations/codex-app-server/lifecycle.js';
import { normalizeWorkspacePathKey } from './root.js';

/** @type {Map<string, { path: string, refs: number, openedAt: number, seq: number }>} */
const openWorkspaces = new Map();

/** Monotonic open counter — two opens in the same millisecond still order. */
let openSeq = 0;

/**
 * @param {string} absPath
 * @returns {{ key: string, resolved: string }}
 */
function keyFor(absPath) {
  const resolved = path.resolve(String(absPath ?? '').trim());
  return { key: normalizeWorkspacePathKey(resolved), resolved };
}

/**
 * Register a view on a workspace folder. Refcounted so a second view on the
 * same folder (the LAN companion mirroring a window, say) does not un-register
 * it when the first one closes.
 * @param {string} absPath
 * @returns {string} resolved absolute path
 */
export function openWorkspace(absPath) {
  if (!absPath || typeof absPath !== 'string' || !absPath.trim()) {
    throw new Error('Workspace path is required');
  }
  const { key, resolved } = keyFor(absPath);
  const existing = openWorkspaces.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.path;
  }
  openSeq += 1;
  openWorkspaces.set(key, { path: resolved, refs: 1, openedAt: Date.now(), seq: openSeq });
  return resolved;
}

/**
 * Drop one view's claim on a workspace folder; the entry goes away with the
 * last one.
 * @param {string} absPath
 * @returns {boolean} true when the folder is no longer open anywhere
 */
export function closeWorkspace(absPath) {
  if (!absPath || typeof absPath !== 'string' || !absPath.trim()) {
    return false;
  }
  const { key } = keyFor(absPath);
  const existing = openWorkspaces.get(key);
  if (!existing) return true;
  existing.refs -= 1;
  if (existing.refs <= 0) {
    openWorkspaces.delete(key);
    void disposeCodexSessions(session => normalizeWorkspacePathKey(session.workspace) === key).catch(() => {});
    return true;
  }
  return false;
}

/**
 * @param {string} absPath
 * @returns {boolean}
 */
export function isOpenWorkspace(absPath) {
  if (!absPath || typeof absPath !== 'string' || !absPath.trim()) {
    return false;
  }
  return openWorkspaces.has(keyFor(absPath).key);
}

/**
 * Open folders, most recently opened first.
 * @returns {Array<{ path: string, refs: number, openedAt: number, seq: number }>}
 */
export function listOpenWorkspaces() {
  return [...openWorkspaces.values()]
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => ({ ...entry }));
}

/** Test hook — drop every registration. */
export function resetOpenWorkspaces() {
  openWorkspaces.clear();
  openSeq = 0;
}
