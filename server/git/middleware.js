/**
 * /api/git — programmatic git operations (MIN-198).
 */

import {
  branches,
  checkout,
  checkoutDetach,
  cherryPick,
  commit,
  createTag,
  deleteBranch,
  diff,
  discard,
  fetch,
  log,
  merge,
  pull,
  push,
  rebase,
  remoteUrl,
  show,
  stage,
  stageAll,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
  status,
  snapshotCreate,
  snapshotDiff,
  snapshotRestore,
  unstage,
  worktreeAdd,
  worktreeRemove,
} from './git-ops.js';
import {
  forgeStatus,
  invalidateForgeStatusCache,
  prCheckout,
  prClose,
  prCreate,
  prDiff,
  prList,
  prMerge,
  prReady,
  prView,
  runCancel,
  runList,
  runLog,
  runRerun,
  runView,
} from './forge-ops.js';
import {
  issueComment as forgeIssueComment,
  issueCreate,
  issueDelete,
  issueEdit,
  issueList,
  issueState,
  issueView,
} from './forge-issue-ops.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';

/**
 * Git ran in whatever `cwd` the caller supplied, unlike `/api/tools` and
 * `/api/terminal` which both go through `validateAllowedWorkspaceRoot`. The auth
 * gate was the only thing between a paired LAN companion and git in an arbitrary
 * directory. The open-workspace registry makes the check a one-liner.
 *
 * An absent `cwd` still means "this request's workspace" and needs no check.
 * @param {unknown} cwd
 * @returns {Promise<void>}
 */
async function assertAllowedGitCwd(cwd) {
  if (cwd === undefined || cwd === null) return;
  if (typeof cwd !== 'string' || !cwd.trim()) return;
  await validateAllowedWorkspaceRoot(cwd);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const OPS = {
  status: (a) => status(a),
  diff: (a) => diff(a),
  stage: (a) => stage(a),
  stageAll: (a) => stageAll(a),
  unstage: (a) => unstage(a),
  discard: (a) => discard(a),
  commit: (a) => commit(a),
  push: (a) => push(a),
  pull: (a) => pull(a),
  fetch: (a) => fetch(a),
  log: (a) => log(a),
  branches: (a) => branches(a),
  checkout: (a) => checkout(a),
  checkoutDetach: (a) => checkoutDetach(a),
  createTag: (a) => createTag(a),
  deleteBranch: (a) => deleteBranch(a),
  remoteUrl: (a) => remoteUrl(a),
  worktreeAdd: (a) => worktreeAdd(a),
  worktreeRemove: (a) => worktreeRemove(a),
  show: (a) => show(a),
  merge: (a) => merge(a),
  rebase: (a) => rebase(a),
  stashList: (a) => stashList(a),
  stashPush: (a) => stashPush(a),
  stashPop: (a) => stashPop(a),
  stashApply: (a) => stashApply(a),
  stashDrop: (a) => stashDrop(a),
  cherryPick: (a) => cherryPick(a),
  snapshotCreate: (a) => snapshotCreate(a),
  snapshotRestore: (a) => snapshotRestore(a),
  snapshotDiff: (a) => snapshotDiff(a),
  forgeStatus: (a) => forgeStatus(a),
  forgeRefresh: (a) => {
    invalidateForgeStatusCache(a?.cwd);
    return forgeStatus({ ...a, refresh: true });
  },
  prList: (a) => prList(a),
  prView: (a) => prView(a),
  prDiff: (a) => prDiff(a),
  prCreate: (a) => prCreate(a),
  prMerge: (a) => prMerge(a),
  prCheckout: (a) => prCheckout(a),
  prReady: (a) => prReady(a),
  prClose: (a) => prClose(a),
  runList: (a) => runList(a),
  runView: (a) => runView(a),
  runRerun: (a) => runRerun(a),
  runCancel: (a) => runCancel(a),
  runLog: (a) => runLog(a),
  issueList: (a) => issueList(a),
  issueView: (a) => issueView(a),
  issueCreate: (a) => issueCreate(a),
  issueDelete: (a) => issueDelete(a),
  issueEdit: (a) => issueEdit(a),
  issueState: (a) => issueState(a),
  issueComment: (a) => forgeIssueComment(a),
};

export async function handleGitRequest(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (pathname !== '/api/git' || req.method !== 'POST') {
    if (pathname.startsWith('/api/git')) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    return false;
  }
  try {
    const body = await readJsonBody(req);
    const op = typeof body?.op === 'string' ? body.op : '';
    const handler = OPS[op];
    if (!handler) {
      sendJson(res, 400, { error: `Unknown git op: ${op || '(none)'}` });
      return true;
    }
    await assertAllowedGitCwd(body?.cwd);
    const result = await handler(body ?? {});
    sendJson(res, 200, result);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { ok: false, error: message });
    return true;
  }
}

/** Vite connect middleware factory. */
export function createGitMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/git')) {
      next();
      return;
    }
    const handled = await handleGitRequest(req, res, parsed.pathname);
    if (!handled) next();
  };
}
