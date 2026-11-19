/**
 * Chats workspace paths under MINNOW_HOME (~/.minnow/chats).
 * Sandboxed storage for chat-scoped files, separate from the Code workspace.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getBenchmarkWorkspacePath } from '../benchmark-workspace/paths.js';
import { getSchedulerWorkspacePath } from '../scheduler-workspace/paths.js';
import { getMinnowHome } from '../config/home.js';
import { readConfigJson } from '../config/store.js';
import { getScratchWorkspacePath, normalizeWorkspacePathKey, readRecentPathsFromMeta } from '../workspace/root.js';
import { isOpenWorkspace } from '../workspace/open-workspaces.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';
import {
  isRegisteredGitWorktreePath,
  isRepoLocalWorktreePath,
} from '../worktree/allowlist.js';
import { isPathUnderWorktreesRoot } from '../worktree/paths.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';

const CHATS_DIR_NAME = 'chats';

const README_BODY = `# Minnow Chats Workspace

This directory is a sandbox for chat-scoped files (attachments, exports, and session artifacts).

- Files here stay separate from your active Code workspace unless tools are explicitly pointed at this path.
- The server allows tool \`workspaceRoot\` overrides for your Code workspace, chats folder, Scratch workspace, benchmark workspace, scheduler workspace, folders in the workspace MRU list, and board task worktrees under ~/.minnow/worktrees.
- Do not store secrets here if you sync or share ~/.minnow.
`;

/** Absolute path to ~/.minnow/chats (created on bootstrap). */
export function getChatsWorkspacePath() {
  return path.join(getMinnowHome(), CHATS_DIR_NAME);
}

/**
 * Create the chats workspace directory and optional README on first run.
 * @returns {Promise<string>} absolute chats workspace path
 */
export async function ensureChatsWorkspace() {
  const root = getChatsWorkspacePath();
  await fs.mkdir(root, { recursive: true });

  const readmePath = path.join(root, 'README.md');
  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(readmePath, README_BODY, 'utf8');
  }

  return root;
}

/**
 * True when rootPath is a folder some view currently has open, the requesting
 * view's own workspace, the chats sandbox, benchmark workspace, scheduler
 * workspace, a registered git worktree, or repo-local `.worktrees/`.
 * Recent MRU folders are checked in `isAllowedWorkspaceRootAsync`.
 * @param {string} rootPath
 */
export function isAllowedWorkspaceRoot(rootPath) {
  if (!rootPath || typeof rootPath !== 'string' || !rootPath.trim()) {
    return false;
  }
  const resolved = path.resolve(rootPath.trim());
  if (isOpenWorkspace(resolved)) {
    return true;
  }
  if (isPathUnderWorktreesRoot(resolved)) {
    return true;
  }
  if (isRepoLocalWorktreePath(resolved)) {
    return true;
  }
  const key = normalizeWorkspacePathKey(resolved);
  // The *view's* workspace, never the per-call override — an override must never
  // be able to authorise itself.
  const codeKey = normalizeWorkspacePathKey(getRequestWorkspaceRoot());
  const chatsKey = normalizeWorkspacePathKey(getChatsWorkspacePath());
  const scratchKey = normalizeWorkspacePathKey(getScratchWorkspacePath());
  const benchmarkKey = normalizeWorkspacePathKey(getBenchmarkWorkspacePath());
  const schedulerKey = normalizeWorkspacePathKey(getSchedulerWorkspacePath());
  return (
    key === codeKey ||
    key === chatsKey ||
    key === scratchKey ||
    key === benchmarkKey ||
    key === schedulerKey
  );
}

/**
 * True when rootPath is a folder in config.json workspace.recentPaths (MRU).
 * Preview and context-document reads still pass the previous Code folder after a switch.
 * @param {string} resolved
 */
async function isRecentWorkspaceRoot(resolved) {
  const meta = (await readConfigJson('config.json')) ?? {};
  const recents = readRecentPathsFromMeta(meta);
  const key = normalizeWorkspacePathKey(resolved);
  return recents.some((p) => normalizeWorkspacePathKey(p) === key);
}

/**
 * Async allowlist check including registered git worktrees (`git worktree list`)
 * and persisted recent workspace folders.
 * @param {string} rootPath
 * @returns {Promise<boolean>}
 */
export async function isAllowedWorkspaceRootAsync(rootPath) {
  if (isAllowedWorkspaceRoot(rootPath)) return true;
  const resolved = path.resolve(String(rootPath).trim());
  if (await isViewWorkspaceChildRepo(resolved)) return true;
  if (await isRegisteredGitWorktreePath(resolved)) return true;
  return isRecentWorkspaceRoot(resolved);
}

/**
 * A repo root discovered inside the view's workspace folder (a multi-repo
 * workspace such as `frontend/` + `backend/`). Checked against the *view's*
 * workspace, never a per-call override, so an override cannot authorise itself.
 * @param {string} resolved
 */
async function isViewWorkspaceChildRepo(resolved) {
  const viewRoot = getRequestWorkspaceRoot();
  if (!viewRoot) return false;
  try {
    const { isWorkspaceRepoRoot } = await import('../git/repo-resolve.js');
    return await isWorkspaceRepoRoot(resolved, viewRoot);
  } catch {
    return false;
  }
}

/**
 * Validate an allowed workspace root exists as a directory.
 * @param {string} rootPath
 * @returns {Promise<string>} resolved absolute path
 */
export async function validateAllowedWorkspaceRoot(rootPath) {
  const allowed = await isAllowedWorkspaceRootAsync(rootPath);
  if (!allowed) {
    throw new Error(
      'workspaceRoot is not in the allowlist (Code workspace, chats workspace, Scratch workspace, benchmark workspace, scheduler workspace, recent workspace, registered git worktree, or repo-local .worktrees/)',
    );
  }
  const resolved = path.resolve(String(rootPath).trim());
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`workspaceRoot does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error('workspaceRoot must be a directory');
  }
  return resolved;
}

/**
 * Resolve a user path under the chats workspace root (blocks traversal escapes).
 * @param {string | null | undefined} userPath Empty → chats root.
 * @returns {string}
 */
export function resolveSafeChatsPath(userPath) {
  const root = getChatsWorkspacePath();
  const trimmed = typeof userPath === 'string' ? userPath.trim() : '';
  const resolved = trimmed
    ? path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(root, trimmed)
    : root;

  if (!isResolvedPathUnderRoot(resolved, root)) {
    throw new Error('Path resolves outside the chats workspace');
  }

  return resolved;
}

/**
 * Workspace-relative path from the chats root (forward slashes).
 * @param {string} absPath
 */
export function toChatsRelativePath(absPath) {
  const root = getChatsWorkspacePath();
  const rel = path.relative(root, absPath);
  if (rel === '') return '.';
  return rel.replace(/\\/g, '/');
}
