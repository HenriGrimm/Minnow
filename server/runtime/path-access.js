/**
 * Workspace path resolution and per-request filesystem access scope (AsyncLocalStorage).
 * Shared by /api/tools, /api/preview, and future Electron HTTP host.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { getFilesystemAccessFromConfig } from '../config/tool-security.js';
import { getDefaultWorkspaceRoot } from '../workspace/root.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';

/**
 * Per-request tool context:
 * - allowOutsideWorkspace: full filesystem access when true
 * - workspaceRootOverride: explicit per-call root (a worktree, sandbox, or board
 *   cwd). Highest precedence — set by callers that know exactly where the work runs.
 * - viewWorkspaceRoot: the workspace the requesting view (window/tab) is bound to,
 *   set by the workspace scope middleware from `X-Minnow-Workspace` / `?workspace=`.
 * - abortSignal: the turn's stop signal, when the caller has one. Carried here rather
 *   than on every handler's arguments so a tool that spawns a child process can kill
 *   it on stop without changing the shape of the ~100 handlers that never need to.
 *
 * Precedence is override > view > persisted global. The global fallback is what
 * keeps the LAN companion, the headless CLI, and any older client working unchanged.
 */
export const pathAccessStore = new AsyncLocalStorage();

const ALLOW_ALL_PATHS = process.env.TOOLS_ALLOW_ALL_PATHS === '1';

/** Active workspace root for the current tool request (override, view, or global). */
export function getEffectiveWorkspaceRoot() {
  const store = pathAccessStore.getStore();
  if (store?.workspaceRootOverride) {
    return store.workspaceRootOverride;
  }
  if (store?.viewWorkspaceRoot) {
    return store.viewWorkspaceRoot;
  }
  return getDefaultWorkspaceRoot();
}

/**
 * Workspace the requesting view is bound to, ignoring any explicit per-call
 * override. Use this when a request-scoped decision must follow the window the
 * request came from rather than a worktree/sandbox the current tool call targets.
 */
export function getRequestWorkspaceRoot() {
  const store = pathAccessStore.getStore();
  if (store?.viewWorkspaceRoot) {
    return store.viewWorkspaceRoot;
  }
  return getDefaultWorkspaceRoot();
}

/** True when the current request carried an explicit view workspace. */
export function hasRequestWorkspaceRoot() {
  return Boolean(pathAccessStore.getStore()?.viewWorkspaceRoot);
}

/**
 * Run `fn` with the requesting view's workspace bound, preserving anything the
 * surrounding store already carries.
 * @template T
 * @param {string} viewWorkspaceRoot
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithViewWorkspace(viewWorkspaceRoot, fn) {
  const parent = pathAccessStore.getStore();
  return pathAccessStore.run({ ...(parent ?? {}), viewWorkspaceRoot }, fn);
}

/**
 * Resolve a user-supplied path under the workspace root unless full access is allowed
 * (TOOLS_ALLOW_ALL_PATHS=1 or persisted toolSecurity.filesystemAccess === 'full').
 * Returns absolute path string, or throws with a message suitable for tool results.
 * @param {string} userPath
 * @param {{ write?: boolean }} [options]
 */
export function resolveSafePath(userPath, options = {}) {
  if (!userPath || typeof userPath !== 'string') {
    throw new Error('Path is required');
  }

  const workspaceRoot = getEffectiveWorkspaceRoot();
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(workspaceRoot, userPath);

  const store = pathAccessStore.getStore();
  const allowOutside = ALLOW_ALL_PATHS || store?.allowOutsideWorkspace === true;

  if (allowOutside) {
    return resolved;
  }

  if (isResolvedPathUnderRoot(resolved, workspaceRoot)) {
    return resolved;
  }

  throw new Error(
    `Path "${userPath}" resolves outside the workspace directory. Enable full disk access in Settings → General → Filesystem access (dangerous) or set TOOLS_ALLOW_ALL_PATHS=1 for automation.`,
  );
}

/**
 * Run async work with filesystem access scope from persisted tool security config.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runWithPathAccess(fn) {
  const fsAccess = await getFilesystemAccessFromConfig();
  const parent = pathAccessStore.getStore();
  return pathAccessStore.run(
    {
      ...(parent?.viewWorkspaceRoot ? { viewWorkspaceRoot: parent.viewWorkspaceRoot } : {}),
      allowOutsideWorkspace: fsAccess === 'full',
    },
    fn,
  );
}

/**
 * Stop signal for the current tool call, when its caller supplied one.
 * @returns {AbortSignal | undefined}
 */
export function getToolAbortSignal() {
  const signal = pathAccessStore.getStore()?.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Run tool handlers with optional workspace root override (validated by caller).
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ allowOutsideWorkspace?: boolean, workspaceRoot?: string, abortSignal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 */
export async function runWithToolContext(fn, options = {}) {
  const fsAccess = await getFilesystemAccessFromConfig();
  const allowOutsideWorkspace =
    options.allowOutsideWorkspace ?? fsAccess === 'full';
  const parent = pathAccessStore.getStore();
  const abortSignal = options.abortSignal ?? parent?.abortSignal;
  const store = {
    ...(parent?.viewWorkspaceRoot ? { viewWorkspaceRoot: parent.viewWorkspaceRoot } : {}),
    allowOutsideWorkspace,
    ...(options.workspaceRoot ? { workspaceRootOverride: options.workspaceRoot } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  };
  return pathAccessStore.run(store, fn);
}
