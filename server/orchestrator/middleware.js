/** HTTP routes for /api/boards. */

import fs from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_BOARD_CONCURRENCY, derive } from './core/derive.js';
import { formatParseErrors, isParseErrors, parsePlan } from './core/parse-plan.js';
import { makeEvent } from './core/events.js';
import { stateToJSON } from './core/snapshot.js';
import { createScriptedEffector } from './effector-scripted.js';
import { disposeEngines, getEngine, peekEngine } from './engine.js';
import { completeModelPair } from './model-binding.js';
import { listPendingBoardResumes, resolveAllBoardResumes } from './resume-gate.js';
import {
  appendEvent,
  boardExists,
  createBoard,
  deleteBoard,
  listBoards,
  loadState,
  readEvents,
} from './journal.js';
import { journalHasReport, readReport } from './report.js';
import { subscribeErrors, subscribeLive } from './live-events.js';
import { readTranscript } from './transcripts.js';
import { readCommitFileDiff, readCommitFileStats } from './task-files.js';
import { cleanupBoardWorktrees } from '../worktree/worktree-ops.js';
import { resolveSafePath } from '../runtime/path-access.js';
import { attachTouchesExpansion, listRepoFiles } from './touches.js';
import { boardBelongsToWorkspace } from './workspace-scope.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

/** Heartbeat cadence. Intermediaries close idle streams without it. */
const HEARTBEAT_MS = 15_000;

/** Commands that would run git/engine work against the live workspace root. */
const MUTATING_ROUTES = new Set([
  'start',
  'stop',
  'concurrency',
  'startTask',
  'abandonTask',
  'resetTask',
  'rewindTask',
  'rerun',
  'model',
  'rename',
  'delete',
]);

/**
 * How a board's effector is built.
 * @type {(boardId?: string) => import('./engine.js').Effector}
 */
let makeEffector = () => createScriptedEffector({});

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * @param {() => import('./engine.js').Effector} factory
 * @returns {void}
 */
export function setEffectorFactory(factory) {
  makeEffector = factory;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @returns {void}
 */
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('payload too large');
  }
  if (body.trim().length === 0) return {};
  return JSON.parse(body);
}

/**
 * Board state as JSON.
 * @param {import('./core/types').BoardState} state
 * @returns {unknown}
 */
function serialiseState(state) {
  return stateToJSON(state);
}

/**
 * When each in-flight attempt started, for the clocks on the board.
 *
 * Deliberately *not* part of `BoardState`: `ts` is display-only, and the fold
 * is a pure function of the journal that must not vary with timestamps
 * (`derive.test.mjs` asserts exactly that). So it rides alongside the snapshot
 * instead, and only for attempts that are still running — a finished attempt
 * has an outcome, which is the thing worth reading.
 *
 * @param {string} boardId
 * @param {import('./core/types').BoardState} state
 * @returns {Promise<Record<string, number>>}
 */
async function inFlightStartTimes(boardId, state) {
  /** @type {Set<string>} */
  const wanted = new Set();
  for (const task of state.tasks.values()) {
    for (const attempt of task.attempts) {
      if (!attempt.ended) wanted.add(attempt.attemptId);
    }
  }
  if (wanted.size === 0) return {};

  /** @type {Record<string, number>} */
  const out = {};
  try {
    for (const event of await readEvents(boardId)) {
      const attemptId = typeof event?.attemptId === 'string' ? event.attemptId : '';
      if (!attemptId || !wanted.has(attemptId)) continue;
      if (event.type !== 'task.attempt.started' && event.type !== 'merge.enqueued') continue;
      if (typeof event.ts === 'number') out[attemptId] = event.ts;
    }
  } catch {
    // A clock is a nicety. Losing it must never cost the caller its snapshot.
  }
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, pattern: RegExp, name: string }>} */
export const ROUTES = [
  { method: 'POST', pattern: /^\/api\/boards$/, name: 'create' },
  { method: 'GET', pattern: /^\/api\/boards$/, name: 'list' },
  { method: 'GET', pattern: /^\/api\/boards\/resume\/pending$/, name: 'resumePending' },
  { method: 'POST', pattern: /^\/api\/boards\/resume\/resolve$/, name: 'resumeResolve' },
  { method: 'GET', pattern: /^\/api\/boards\/([^/]+)$/, name: 'get' },
  { method: 'GET', pattern: /^\/api\/boards\/([^/]+)\/events$/, name: 'events' },
  { method: 'GET', pattern: /^\/api\/boards\/([^/]+)\/journal$/, name: 'journal' },
  { method: 'GET', pattern: /^\/api\/boards\/([^/]+)\/report$/, name: 'report' },
  { method: 'POST', pattern: /^\/api\/boards\/([^/]+)\/start$/, name: 'start' },
  { method: 'POST', pattern: /^\/api\/boards\/([^/]+)\/stop$/, name: 'stop' },
  { method: 'POST', pattern: /^\/api\/boards\/([^/]+)\/concurrency$/, name: 'concurrency' },
  {
    method: 'POST',
    pattern: /^\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/start$/,
    name: 'startTask',
  },
  {
    method: 'POST',
    pattern: /^\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/abandon$/,
    name: 'abandonTask',
  },
  {
    method: 'POST',
    pattern: /^\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/reset$/,
    name: 'resetTask',
  },
  {
    method: 'POST',
    pattern: /^\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/rewind$/,
    name: 'rewindTask',
  },
  { method: 'POST', pattern: /^\/api\/boards\/([^/]+)\/rerun$/, name: 'rerun' },
  { method: 'POST', pattern: /^\/api\/boards\/([^/]+)\/model$/, name: 'model' },
  {
    method: 'GET',
    pattern: /^\/api\/boards\/([^/]+)\/attempts\/([^/]+)$/,
    name: 'attempt',
  },
  {
    method: 'GET',
    pattern: /^\/api\/boards\/([^/]+)\/tasks\/([^/]+)\/files$/,
    name: 'taskFiles',
  },
  { method: 'PATCH', pattern: /^\/api\/boards\/([^/]+)$/, name: 'rename' },
  { method: 'DELETE', pattern: /^\/api\/boards\/([^/]+)$/, name: 'delete' },
];

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {{ name: string, params: string[] } | null}
 */
export function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match) return { name: route.name, params: match.slice(1).map(decodeURIComponent) };
  }
  return null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleBoardsRequest(req, res, pathname) {
  const route = matchRoute(req.method ?? 'GET', pathname);
  if (!route) return false;

  try {
    await dispatch(route, req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      console.warn(`[orchestrator] ${pathname} failed after the response began:`, message);
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      } catch {
      }
      res.end();
      return true;
    }
    json(res, 500, { ok: false, error: message });
  }
  return true;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * @param {{ name: string, params: string[] }} route
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function dispatch(route, req, res) {
  const [boardId, taskId] = route.params;

  if (MUTATING_ROUTES.has(route.name) && boardId) {
    if (!(await boardExists(boardId))) {
      return json(res, 404, { ok: false, error: 'no such board' });
    }
    const live = peekEngine(boardId)?.getState() ?? (await loadState(boardId));
    if (!(await boardBelongsToWorkspace(live))) {
      return json(res, 409, {
        ok: false,
        error: 'this board belongs to another workspace',
      });
    }
  }

  switch (route.name) {
    case 'list': {
      const ids = await listBoards();
      const workspaceRoot = getEffectiveWorkspaceRoot();
      const boards = [];
      for (const id of ids) {
        const state = await loadState(id);
        if (!(await boardBelongsToWorkspace(state, workspaceRoot))) continue;
        boards.push({
          boardId: id,
          name: state.name,
          planPath: state.planPath,
          workspacePath: state.workspacePath,
          status: state.status,
          concurrency: state.concurrency,
          taskCount: state.tasks.size,
          finished: state.finished,
        });
      }
      return json(res, 200, { ok: true, boards });
    }

    case 'resumePending': {
      const rows = [];
      for (const row of listPendingBoardResumes()) {
        const state = peekEngine(row.boardId)?.getState();
        if (state && !(await boardBelongsToWorkspace(state))) continue;
        rows.push(row);
      }
      return json(res, 200, { ok: true, boards: rows });
    }

    case 'resumeResolve': {
      const body = await readJsonBody(req);
      const decision = body.decision === 'decline' ? 'decline' : 'resume';
      if (body.decision !== 'resume' && body.decision !== 'decline') {
        return json(res, 400, {
          ok: false,
          error: "decision must be 'resume' or 'decline'",
        });
      }
      const boardIds = await resolveAllBoardResumes(decision);
      return json(res, 200, { ok: true, decision, boardIds });
    }

    case 'create':
      return createFromPlan(req, res);

    case 'get': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = peekEngine(boardId);
      // Pair the state with its journal position so a reconnect cannot replay
      // an older failed check over a baseline that already contains the pass.
      const events = engine ? null : await readEvents(boardId);
      const state = engine ? engine.getState() : derive(events);
      const seq = engine ? engine.getHighestSeq() : Number(events.at(-1)?.seq) || 0;
      return json(res, 200, { ok: true, state: serialiseState(state), seq });
    }

    case 'report': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      if (!journalHasReport(await readEvents(boardId))) {
        return json(res, 404, { ok: false, error: 'no current report yet' });
      }
      const markdown = await readReport(boardId);
      if (markdown == null) return json(res, 404, { ok: false, error: 'no report yet' });
      return json(res, 200, { ok: true, markdown, path: 'report.md' });
    }

    case 'journal': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const since = Number(query.get('since'));
      const limit = Number(query.get('limit'));
      let events = await readEvents(boardId);
      if (Number.isSafeInteger(since) && since > 0) {
        events = events.filter((event) => Number(event.seq) > since);
      }
      const truncated = Number.isSafeInteger(limit) && limit > 0 && events.length > limit;
      if (truncated) events = events.slice(-limit);
      return json(res, 200, { ok: true, events, truncated });
    }

    case 'events':
      return streamEvents(req, res, boardId);

    case 'start': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const body = await readJsonBody(req);
      const concurrency =
        body.concurrency === undefined
          ? DEFAULT_BOARD_CONCURRENCY
          : normaliseConcurrency(body.concurrency);
      if (concurrency === null) {
        return json(res, 400, { ok: false, error: 'concurrency must be an integer >= 1' });
      }
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      if (engine.getState()?.finished) {
        return json(res, 409, {
          ok: false,
          error: 'the run has finished; rerun it instead',
          state: serialiseState(engine.getState()),
        });
      }
      try {
        await engine.preflight();
      } catch (err) {
        return json(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          state: serialiseState(engine.getState()),
        });
      }
      await engine.startBoard(concurrency);
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'model': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const body = await readJsonBody(req);
      const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (!providerId || !id) {
        return json(res, 400, { ok: false, error: 'providerId and id are required' });
      }
      const allowed = new Set(['on', 'off', 'low', 'medium', 'high']);
      const raw = typeof body.reasoning === 'string' ? body.reasoning : '';
      const reasoning = allowed.has(raw) ? raw : '';
      if (body.reasoning !== undefined && body.reasoning !== null && !reasoning) {
        return json(res, 400, {
          ok: false,
          error: "reasoning must be 'on', 'off', 'low', 'medium', or 'high'",
        });
      }
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      await engine.setModel({ providerId, id, reasoning: reasoning || null });
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'rename': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return json(res, 400, { ok: false, error: 'name is required' });
      if (name.length > 200) return json(res, 400, { ok: false, error: 'name is too long' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      await engine.rename(name);
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'delete': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      disposeEngines(boardId);
      // Journal delete used to leave ~/.minnow/worktrees/<repo>/<boardId>/ behind.
      // Recreating the same board id then hung engine load on orphan reconcile.
      try {
        await cleanupBoardWorktrees({ boardId, includeIntegration: true });
      } catch (err) {
        console.warn(
          `[orchestrator] ${boardId}: worktree cleanup failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      const removed = await deleteBoard(boardId);
      return json(res, removed ? 200 : 404, {
        ok: removed,
        ...(removed ? { boardId } : { error: 'no such board' }),
      });
    }

    case 'attempt': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const limit = Number(query.get('limit'));
      const transcript = await readTranscript(boardId, taskId, {
        ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {}),
      });
      return json(res, 200, { ok: true, attemptId: taskId, ...transcript });
    }

    case 'taskFiles': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      const task = engine.getState().tasks.get(taskId);
      if (!task) return json(res, 404, { ok: false, error: 'no such task' });
      const sha = task.mergedSha;
      if (!sha) return json(res, 200, { ok: true, taskId, sha: null, source: 'planned' });

      const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
      const wanted = query.get('path');
      if (wanted) {
        const diff = await readCommitFileDiff(sha, wanted);
        return json(res, 200, {
          ok: true,
          taskId,
          sha,
          source: 'merged',
          ...(diff ? { file: diff } : { file: null }),
        });
      }
      const stats = await readCommitFileStats(sha);
      return json(res, 200, {
        ok: true,
        taskId,
        sha,
        source: stats ? 'merged' : 'planned',
        ...(stats
          ? {
              files: stats.files,
              additions: stats.additions,
              deletions: stats.deletions,
              truncated: stats.truncated,
            }
          : {}),
      });
    }

    case 'stop': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      await engine.stopBoard('user');
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'concurrency': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const body = await readJsonBody(req);
      const n = normaliseConcurrency(body.n);
      if (n === null) return json(res, 400, { ok: false, error: 'n must be an integer >= 1' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      await engine.setConcurrency(n);
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'abandonTask': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      const abandoned = await engine.abandonTask(taskId, 'user');
      return json(res, abandoned ? 200 : 409, {
        ok: abandoned,
        ...(abandoned ? {} : { error: 'that task has already finished' }),
        state: serialiseState(engine.getState()),
      });
    }

    case 'resetTask': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      const result = await engine.resetTask(taskId, 'user');
      return json(res, result.ok ? 200 : 409, {
        ok: result.ok,
        taskIds: result.taskIds,
        ...(result.ok ? {} : { error: result.reason ?? 'could not reset that task' }),
        state: serialiseState(engine.getState()),
      });
    }

    case 'rewindTask': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      const result = await engine.rewindFrom(taskId, 'user');
      return json(res, result.ok ? 200 : 409, {
        ok: result.ok,
        taskIds: result.taskIds,
        ...(result.ok ? {} : { error: result.reason ?? 'could not rewind that task' }),
        state: serialiseState(engine.getState()),
      });
    }

    case 'startTask': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      const started = await engine.startTask(taskId);
      return json(res, started ? 200 : 409, {
        ok: started,
        ...(started ? {} : { error: 'task is not startable right now' }),
        state: serialiseState(engine.getState()),
      });
    }

    case 'rerun': {
      if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });
      const body = await readJsonBody(req);
      const taskIds = Array.isArray(body.taskIds)
        ? body.taskIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
        : undefined;
      const concurrency =
        body.concurrency === undefined ? undefined : normaliseConcurrency(body.concurrency);
      if (body.concurrency !== undefined && concurrency === null) {
        return json(res, 400, { ok: false, error: 'concurrency must be an integer >= 1' });
      }
      const engine = await getEngine(boardId, () => makeEffector(boardId));
      try {
        await engine.preflight();
      } catch (err) {
        return json(res, 400, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          state: serialiseState(engine.getState()),
        });
      }
      const result = await engine.reopen({
        ...(taskIds && taskIds.length > 0 ? { taskIds } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      });
      return json(res, result.ok ? 200 : 409, {
        ok: result.ok,
        taskIds: result.taskIds,
        ...(result.ok ? {} : { error: 'nothing to rerun' }),
        state: serialiseState(engine.getState()),
      });
    }

    default:
      return json(res, 404, { ok: false, error: 'no such route' });
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function normaliseConcurrency(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 64) return null;
  return n;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Create a board from a plan file.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function createFromPlan(req, res) {
  const body = await readJsonBody(req);
  const planPath = typeof body.planPath === 'string' ? body.planPath.trim() : '';
  if (!planPath) return json(res, 400, { ok: false, error: 'planPath is required' });

  /** @type {string} */
  let markdown;
  try {
    markdown =
      typeof body.markdown === 'string'
        ? body.markdown
        : await fs.readFile(resolveSafePath(planPath), 'utf8');
  } catch (err) {
    return json(res, 400, {
      ok: false,
      error: `could not read plan: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const parsed = parsePlan(markdown);
  if (isParseErrors(parsed)) {
    return json(res, 400, {
      ok: false,
      error: 'the plan does not parse',
      errors: parsed,
      detail: formatParseErrors(parsed),
    });
  }

  const boardId = deriveBoardId(body.boardId, parsed.name, planPath);
  if (await boardExists(boardId)) {
    return json(res, 409, { ok: false, error: `board ${boardId} already exists` });
  }

  await createBoard(boardId);
  const repoFiles = await listRepoFiles();
  const tasks = attachTouchesExpansion(parsed.tasks, repoFiles);
  await appendEvent(
    boardId,
    makeEvent('board.created', {
      boardId,
      planPath,
      name: parsed.name,
      tasks,
      waves: parsed.waves,
      workspacePath: path.resolve(getEffectiveWorkspaceRoot()),
    }),
  );

  // Optional chip/menubar seed from the client so Start and the header share a journaled pair.
  const model = await completeModelPair(body.providerId, body.id);
  if (model?.providerId && model.id) {
    await appendEvent(
      boardId,
      makeEvent('board.model.set', {
        providerId: model.providerId,
        id: model.id,
      }),
    );
  }

  const state = await loadState(boardId);
  return json(res, 201, { ok: true, boardId, state: serialiseState(state) });
}

/**
 * @param {unknown} requested
 * @param {string} planName
 * @param {string} planPath
 * @returns {string}
 */
function deriveBoardId(requested, planName, planPath) {
  const raw =
    (typeof requested === 'string' && requested.trim()) ||
    planName ||
    path.basename(planPath).replace(/\.md$/i, '');
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'board';
}

// ── Events stream ────────────────────────────────────────────────────────────

/**
 * Stream a board's events.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} boardId
 * @returns {Promise<void>}
 */
async function streamEvents(req, res, boardId) {
  if (!(await boardExists(boardId))) return json(res, 404, { ok: false, error: 'no such board' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush before getEngine(): load() can wait on orphan worktree reclaim.
  // Without a first byte, EventSource stays CONNECTING ("reconnecting") and
  // Chromium's HTTP/1.1 pool fills until later POSTs fail with Failed to fetch.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  const lastEventId = Number(req.headers['last-event-id']);
  const resumeFrom = Number.isSafeInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;

  /**
   * @param {string} type
   * @param {unknown} data
   * @param {number} [id]
   */
  const send = (type, data, id) => {
    let frame = '';
    if (id !== undefined) frame += `id: ${id}\n`;
    frame += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      res.write(frame);
      return true;
    } catch {
      return false;
    }
  };

  const engine = await getEngine(boardId, () => makeEffector(boardId));

  /** @type {Record<string, unknown>[]} */
  let buffered = [];
  let sentThrough = -1;

  const deliver = (event) => {
    const seq = Number(event.seq) || 0;
    if (sentThrough < 0) {
      buffered.push(event);
      return;
    }
    if (seq <= sentThrough) return;
    sentThrough = seq;
    if (!send('event', event, seq)) cleanup();
  };
  const unsubscribe = engine.subscribe(deliver);
  const unsubscribeLive = subscribeLive(boardId, (payload) => {
    if (!send('live', payload)) cleanup();
  });
  const unsubscribeErrors = subscribeErrors(boardId, (payload) => {
    if (!send('error', payload)) cleanup();
  });

  if (resumeFrom > 0) {
    const events = await readEvents(boardId);
    let highest = resumeFrom;
    for (const event of events) {
      const seq = Number(event.seq) || 0;
      if (seq <= resumeFrom) continue;
      send('event', event, seq);
      if (seq > highest) highest = seq;
    }
    sentThrough = highest;
  } else {
    const state = engine.getState();
    const seq = engine.getHighestSeq();
    send(
      'snapshot',
      {
        seq,
        state: serialiseState(state),
        attemptStartedAt: await inFlightStartTimes(boardId, state),
      },
      seq,
    );
    sentThrough = seq;
  }

  const pending = buffered;
  buffered = [];
  for (const event of pending) deliver(event);

  for (const failure of engine.getStartFailures()) {
    send('error', {
      boardId,
      taskId: failure.taskId,
      role: failure.role,
      message: failure.message,
      consecutive: failure.consecutive,
    });
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeLive();
    unsubscribeErrors();
    try {
      res.end();
    } catch {
    }
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ── Middleware ───────────────────────────────────────────────────────────────

/** Connect-style middleware. */
export function createBoardsMiddleware() {
  return async (
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
    /** @type {() => void} */ next,
  ) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (!pathname.startsWith('/api/boards')) {
      next();
      return;
    }
    const handled = await handleBoardsRequest(req, res, pathname);
    if (!handled) next();
  };
}

export { disposeEngines };
