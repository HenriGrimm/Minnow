/**
 * Per-request workspace scope for every `/api/*` request.
 *
 * Runs immediately after `createAuthMiddleware()` — authenticate first, then
 * scope. It reads the workspace the calling view (window or tab) is bound to
 * from `X-Minnow-Workspace` (fetch) or `?workspace=` (SSE and WebSocket, which
 * cannot set headers), validates it against the allowlist, and runs the rest of
 * the chain inside the path-access AsyncLocalStorage with `viewWorkspaceRoot`
 * set.
 *
 * `AsyncLocalStorage` propagates through `next()` because connect invokes the
 * next layer synchronously, and through every `await` inside the handler.
 *
 * A request with no workspace falls through untouched, which is exactly today's
 * behaviour — that is what keeps the LAN companion, the headless CLI, and any
 * older client working unchanged.
 *
 * ⚠️ ALS only covers work that finishes inside the request. Boards, sub-agents,
 * scheduler jobs, dev servers, PTY sessions, and background shell runs all
 * outlive it and must carry their workspace on their own record.
 */

import path from 'node:path';
import { runWithViewWorkspace } from './path-access.js';
import { projectMoveBlocks } from '../workspace/project-move.js';
import {
  isAllowedWorkspaceRoot,
  isAllowedWorkspaceRootAsync,
} from '../chats-workspace/paths.js';

/** Header carrying the requesting view's workspace folder. */
export const WORKSPACE_HEADER = 'x-minnow-workspace';

/** Query parameter carrying it for transports that cannot set headers. */
export const WORKSPACE_QUERY_PARAM = 'workspace';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {URL} url
 * @returns {string}
 */
export function extractWorkspace(req, url) {
  const header = req.headers[WORKSPACE_HEADER];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const fromQuery = url.searchParams.get(WORKSPACE_QUERY_PARAM);
  return typeof fromQuery === 'string' ? fromQuery.trim() : '';
}

/**
 * @returns {import('connect').HandleFunction}
 */
export function createWorkspaceScopeMiddleware() {
  return function minnowWorkspaceScopeMiddleware(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) {
      next();
      return;
    }

    const requested = extractWorkspace(req, url);
    if (!requested) {
      next();
      return;
    }

    const resolved = path.resolve(requested);
    if (projectMoveBlocks(resolved)) {
      sendJson(res, 409, { error: 'This workspace is involved in a project move.' });
      return;
    }

    // Fast path: the synchronous allowlist covers open workspaces, the sandboxes
    // and worktrees, and is what almost every request hits.
    if (isAllowedWorkspaceRoot(resolved)) {
      req.minnowWorkspaceRoot = resolved;
      runWithViewWorkspace(resolved, next);
      return;
    }

    // Slow path: registered git worktrees and the persisted MRU need I/O.
    isAllowedWorkspaceRootAsync(resolved)
      .then((allowed) => {
        if (projectMoveBlocks(resolved)) {
          sendJson(res, 409, { error: 'This workspace is involved in a project move.' });
          return;
        }
        if (!allowed) {
          sendJson(res, 400, {
            error: `Unknown workspace: ${resolved}`,
          });
          return;
        }
        req.minnowWorkspaceRoot = resolved;
        runWithViewWorkspace(resolved, next);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { error: `Workspace scope failed: ${message}` });
      });
  };
}
