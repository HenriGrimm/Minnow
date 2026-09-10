import { projectSuperPlan } from './projection.js';
/** HTTP routes for /api/super-plan. */

import { randomUUID } from 'node:crypto';

import { makeEvent } from './events.js';
import { superPlanGraph } from './graph.js';
import {
  appendEvent,
  createEntry,
  entryExists,
  listEntries,
  loadState,
  readEvents,
  readHighestSeq,
  resetJournalCache,
} from './journal.js';
import * as superPlanJournal from './journal.js';
import { createSplitEffector } from './effector-split.js';
import { createHeadlessEffector } from './effector-headless.js';
import {
  createDelegatedClaimHandler,
  createDelegatedEffector,
  getDelegatedEffector,
  resetDelegatedEffectors,
} from './effector-delegated.js';
import { createGateEffector } from './effector-gate.js';
import { answerJournaledGate, createJournaledAsk } from './ask-bridge.js';
import { subscribeLive } from './live-events.js';
import { disposeEngines, getEngine, peekEngine } from '../orchestrator/engine.js';
import { resolveBoardResume } from '../orchestrator/resume-gate.js';
import { subscribeErrors } from '../orchestrator/live-events.js';
import { safeSegment } from '../orchestrator/journal-store.js';
import { SUPERPLAN_NAMESPACE } from './journal.js';

/** Heartbeat cadence. Intermediaries close idle streams without it. */
const HEARTBEAT_MS = 15_000;

/** Commands that write the journal. Reads stay available for a stale view. */
const MUTATING_ROUTES = new Set(['start', 'stop', 'resume', 'cancel', 'claim', 'finish']);

/**
 * How a run's effector is built.
 *
 * Tests inject a scripted / split effector. Production
 * `setSuperPlanEffectorFactory` from `server/runtime/middlewares.js` supplies
 * the split effector with headless sub-effectors for the headless stages.
 *
 * @type {(runId: string) => import('../orchestrator/engine.js').Effector}
 */
export const createProductionSuperPlanEffector = (runId) => {
  // interview / draft are delegated to the renderer through a lease; the
  // remaining headless stages run in-process. One delegated effector per run
  // is shared by both roles so the claim route can reach it by `runId`.
  const delegated = createDelegatedEffector({ runId });
  return createSplitEffector({
    byRole: {
      gate: () => createGateEffector({ runId }),
      interview: () => delegated,
      draft: () => delegated,
      research: () => createHeadlessEffector({ runId }),
      review: () => createHeadlessEffector({ runId }),
      polish: () => createHeadlessEffector({ runId }),
    },
    fallback: () => createHeadlessEffector({ runId }),
  });
};

let makeEffector = createProductionSuperPlanEffector;
const activeEffectors = new Set();

/**
 * @param {(runId: string) => import('../orchestrator/engine.js').Effector} factory
 * @returns {void}
 */
export function setSuperPlanEffectorFactory(factory) {
  makeEffector = factory;
}

/**
 * The live engine for one run. Namespace `'superplan'`, this directory's
 * graph and journal — never the board defaults.
 *
 * @param {string} runId
 * @param {{ clock?: typeof import('../orchestrator/engine.js').systemClock, tickMs?: number }} [options]
 * @returns {Promise<import('../orchestrator/engine.js').Engine>}
 */
export async function getSuperPlanEngine(runId, options = {}) {
  const engine = await getEngine(runId, () => { const effector = makeEffector(runId); activeEffectors.add(effector); return effector; }, {
    namespace: SUPERPLAN_NAMESPACE,
    graph: superPlanGraph,
    journal: superPlanJournal,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
  });
  // The shared engine's boot gate is for user-managed boards. Super Plan runs
  // recover automatically, so release a hold created while loading this run.
  if (engine.wasHeldAtLoad()) await resolveBoardResume(runId, 'resume');
  return engine;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

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
 * Run state as JSON. The Super Plan fold is plain objects and arrays (no
 * Maps), so the derived state serialises as itself.
 *
 * @param {import('./types').RunState} state
 * @returns {unknown}
 */
function serialiseState(state) {
  return { ...state, view: { ...projectSuperPlan(state, Date.now()), seq: peekEngine(state.runId, SUPERPLAN_NAMESPACE)?.getHighestSeq() ?? 0 } };
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, pattern: RegExp, name: string }>} */
export const ROUTES = [
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/ask$/, name: 'ask' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/skip$/, name: 'skip' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/rework$/, name: 'rework' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/gates\/([^/]+)\/answer$/, name: 'answer' },
  { method: 'POST', pattern: /^\/api\/super-plan$/, name: 'create' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/state$/, name: 'state' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/events$/, name: 'events' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/start$/, name: 'start' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/stop$/, name: 'stop' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/resume$/, name: 'resume' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/cancel$/, name: 'cancel' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/claim$/, name: 'claim' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/finish$/, name: 'finish' },
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
export async function handleSuperPlanRequest(req, res, pathname) {
  const route = matchRoute(req.method ?? 'GET', pathname);
  if (!route) return false;

  try {
    await dispatch(route, req, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      console.warn(`[super-plan] ${pathname} failed after the response began:`, message);
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
  const [runId] = route.params;

  switch (route.name) {
    case 'create':
      return createRun(req, res);

    case 'state': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = peekEngine(runId, SUPERPLAN_NAMESPACE);
      const state = engine
        ? /** @type {import('./types').RunState} */ (engine.getState())
        : /** @type {import('./types').RunState} */ (await loadState(runId));
      const seq = engine ? engine.getHighestSeq() : await readHighestSeq(runId);
      return json(res, 200, { ok: true, runId, seq, state: serialiseState(state) });
    }

    case 'events':
      return streamEvents(req, res, runId);

    case 'ask': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const lease = getDelegatedEffector(runId)?.leaseOf(body.attemptId);
      if (!lease || !body.clientId || lease.claimedBy !== body.clientId) return json(res, 409, { ok: false, error: 'not the lease owner' });
      const controller = new AbortController();
      // A disconnected renderer must lose its lease and re-ask, not expire the run.
      const unsubscribe = engine.subscribe((event) => {
        if ((event.type === 'stage.ended' && event.attemptId === body.attemptId) || ['run.stopped', 'run.cancelled', 'stage.reopened', 'stage.skipped'].includes(event.type)) controller.abort();
      });
      try {
        const result = await createJournaledAsk({ engine, runId, attemptId: body.attemptId })(body.question ?? {}, { signal: controller.signal });
        if (!res.destroyed) return json(res, 200, { ok: true, answer: result });
      } finally { unsubscribe(); }
      return;
    }
    case 'skip':
    case 'rework': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const state = engine.getState();
      const body = await readJsonBody(req);
      const roles = { grill: 'interview', draft1: 'draft', draft2: 'draft', review1: 'review', review2: 'review', impeccable: 'polish', research: 'research' };
      const stage = route.name === 'skip' ? state.stage : (roles[body.stage] ?? (['interview', 'research', 'draft', 'review', 'polish'].includes(body.stage) ? body.stage : null));
      if (!stage || (route.name === 'skip' && !['interview', 'research', 'review', 'polish'].includes(stage))) return json(res, 400, { ok: false, error: 'this stage cannot be skipped or reopened' });
      await engine.append([makeEvent(route.name === 'skip' ? 'stage.skipped' : 'stage.reopened', { stage })]);
      await engine.tick();
      return json(res, 200, { ok: true });
    }
    case 'answer': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const result = await answerJournaledGate({ engine, runId, gateId: route.params[1], answer: String(body.answer ?? body.verdict ?? ''), errors: Array.isArray(body.errors) ? body.errors.map(String) : [] });
      return json(res, result.status, result);
    }
    case 'claim': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const delegated = getDelegatedEffector(runId);
      if (!delegated) {
        return json(res, 404, { ok: false, error: 'no delegated effector for this run' });
      }
      // Compare-and-set on `attemptId`: the loser of a two-window race gets a
      // 409 and must not run the stage.
      return createDelegatedClaimHandler(delegated)(req, res);
    }

    case 'finish': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const delegated = getDelegatedEffector(runId);
      if (!delegated) {
        return json(res, 404, { ok: false, error: 'no delegated effector for this run' });
      }
      const body = await readJsonBody(req);
      if (!body.clientId) return json(res, 400, { ok: false, error: 'clientId is required' });
      const result = await delegated.finish(String(body?.attemptId ?? ''), {
        clientId: String(body?.clientId ?? ''),
        ...(typeof body?.outcome === 'string' ? { outcome: body.outcome } : {}),
        ...(typeof body?.summary === 'string' ? { summary: body.summary } : {}),
        ...(body?.evidence && typeof body.evidence === 'object' && !Array.isArray(body.evidence)
          ? { evidence: body.evidence }
          : {}),
      });
      // `finish()` delivers the attempt end to the engine's `onEnd` handler,
      // which appends `stage.ended` and ticks the next stage.
      return json(res, result.status ?? 200, {
        ok: result.ok,
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
    }

    case 'start': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const state = /** @type {import('./types').RunState} */ (engine.getState());
      if (state.finished) {
        return json(res, 409, {
          ok: false,
          error: 'the run has finished; create a new run instead',
          state: serialiseState(state),
        });
      }
      if (state.status === 'running') {
        return json(res, 200, { ok: true, state: serialiseState(state) });
      }
      await engine.append([makeEvent('run.started', {})]);
      await engine.tick();
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'stop': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const state = /** @type {import('./types').RunState} */ (engine.getState());
      if (state.finished) {
        return json(res, 200, { ok: true, state: serialiseState(state) });
      }
      // D8: a user stop is a *pause* — non-terminal. The run keeps its stage
      // and open attempt; `resume` re-plans the same stage. Terminal stops are
      // `cancel` (user) and `gate.expired`.
      if (state.status === 'stopped') return json(res, 200, { ok: true, state: serialiseState(state) });
      await engine.append([makeEvent('run.stopped', { reason: 'paused' })]);
      await engine.tick();
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'cancel': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const state = /** @type {import('./types').RunState} */ (engine.getState());
      if (state.finished) {
        return json(res, 200, { ok: true, state: serialiseState(state) });
      }
      await engine.append([makeEvent('run.cancelled', { reason: 'user' })]);
      await engine.tick();
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    case 'resume': {
      if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });
      const engine = await getSuperPlanEngine(runId);
      const state = /** @type {import('./types').RunState} */ (engine.getState());
      if (state.finished) {
        return json(res, 409, {
          ok: false,
          error: 'the run has finished; create a new run instead',
          state: serialiseState(state),
        });
      }
      // D8: a paused run (non-terminal `run.stopped`) resumes its current
      // stage. No gate/verdict body is required for this path.
      if (state.status === 'stopped') {
        await engine.append([makeEvent('run.resumed', {})]);
        await engine.tick();
        return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
      }
      const body = await readJsonBody(req);
      if (!body.kind && state.status === 'running') return json(res, 200, { ok: true, state: serialiseState(state) });
      const kind = typeof body.kind === 'string' ? body.kind : '';
      const verdict = typeof body.verdict === 'string' ? body.verdict : '';
      const verdicts = { spec: ['confirm', 'revise'], accept: ['accept', 'reject'] };
      if (kind !== 'spec' && kind !== 'accept') {
        return json(res, 400, { ok: false, error: "kind must be 'spec' or 'accept'" });
      }
      if (!verdicts[/** @type {'spec' | 'accept'} */ (kind)].includes(verdict)) {
        return json(res, 400, {
          ok: false,
          error: `verdict must be one of ${verdicts[/** @type {'spec' | 'accept'} */ (kind)].join(', ')}`,
        });
      }
      if (state.gate?.kind !== kind || state.gate.status !== 'open') {
        return json(res, 409, {
          ok: false,
          error: `no open ${kind} gate to resume`,
          state: serialiseState(state),
        });
      }
      /** @type {Record<string, unknown>} */
      const payload = { kind, verdict };
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        payload.errors = body.errors.map(String);
      }
      if (state.gate.gateId) {
        const result = await answerJournaledGate({ engine, runId, gateId: state.gate.gateId, answer: verdict, errors: payload.errors ?? [] });
        return json(res, result.status, result);
      }
      await engine.append([makeEvent('gate.answered', payload)]);
      await engine.tick();
      return json(res, 200, { ok: true, state: serialiseState(engine.getState()) });
    }

    default:
      return json(res, 404, { ok: false, error: 'no such route' });
  }
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Create a run from a prompt.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
async function createRun(req, res) {
  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(res, 400, { ok: false, error: 'prompt is required' });

  const runId =
    typeof body.runId === 'string' && body.runId.trim()
      ? body.runId.trim()
      : slugFromPrompt(prompt);
  try {
    safeSegment(runId, 'run');
  } catch (err) {
    return json(res, 400, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (await entryExists(runId)) {
    return json(res, 409, { ok: false, error: `run ${runId} already exists` });
  }

  await createEntry(runId);

  /** @type {Record<string, unknown>} */
  const payload = { runId, prompt };
  if (typeof body.chatId === 'string') payload.chatId = body.chatId;
  if (typeof body.workspacePath === 'string' && body.workspacePath.trim()) {
    payload.workspacePath = body.workspacePath.trim();
  }
  if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
    payload.config = body.config;
  }
  await appendEvent(runId, makeEvent('run.created', payload));

  const state = /** @type {import('./types').RunState} */ (await loadState(runId));
  return json(res, 201, { ok: true, runId, state: serialiseState(state) });
}

/**
 * @param {string} prompt
 * @returns {string}
 */
function slugFromPrompt(prompt) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `run-${randomUUID().slice(0, 8)}`;
}

// ── Events stream ────────────────────────────────────────────────────────────

/**
 * Stream a run's journal events plus its live channel.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} runId
 * @returns {Promise<void>}
 */
async function streamEvents(req, res, runId) {
  if (!(await entryExists(runId))) return json(res, 404, { ok: false, error: 'no such run' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush before getEngine(): load() can wait on journal reads. Without a
  // first byte, EventSource stays CONNECTING and Chromium's HTTP/1.1 pool
  // fills until later POSTs fail with Failed to fetch.
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

  const engine = await getSuperPlanEngine(runId);

  /** @type {Record<string, unknown>[]} */
  let buffered = [];
  let sentThrough = -1;

  let heartbeat = null;
  let closed = false;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {(() => void) | null} */
  let unsubscribeLive = null;
  /** @type {(() => void) | null} */
  let unsubscribeErrors = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    unsubscribe?.();
    unsubscribeLive?.();
    unsubscribeErrors?.();
    try {
      res.end();
    } catch {
    }
  }

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
  unsubscribe = engine.subscribe(deliver);
  unsubscribeLive = subscribeLive(runId, (payload) => {
    if (!send('live', payload)) cleanup();
  });
  // Engine start failures are emitted on the shared orchestrator error bus,
  // keyed by the engine's boardId, which is this runId.
  unsubscribeErrors = subscribeErrors(runId, (payload) => {
    if (!send('error', payload)) cleanup();
  });

  if (resumeFrom > 0) {
    const events = await readEvents(runId);
    let highest = resumeFrom;
    for (const event of events) {
      const seq = Number(event.seq) || 0;
      if (seq <= resumeFrom) continue;
      send('event', event, seq);
      if (seq > highest) highest = seq;
    }
    sentThrough = highest;
  } else {
    const state = /** @type {import('./types').RunState} */ (engine.getState());
    const seq = engine.getHighestSeq();
    send(
      'snapshot',
      {
        seq,
        state: serialiseState(state),
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
      runId,
      stage: failure.role,
      message: failure.message,
      consecutive: failure.consecutive,
    });
  }

  heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ── Middleware ───────────────────────────────────────────────────────────────

/** Connect-style middleware. */
export function createSuperPlanMiddleware() {
  return async (
    /** @type {import('node:http').IncomingMessage} */ req,
    /** @type {import('node:http').ServerResponse} */ res,
    /** @type {() => void} */ next,
  ) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (!pathname.startsWith('/api/super-plan')) {
      next();
      return;
    }
    const handled = await handleSuperPlanRequest(req, res, pathname);
    if (!handled) next();
  };
}

// ── Boot scan ────────────────────────────────────────────────────────────────

/**
 * Re-arm every non-terminal run after a server restart.
 *
 * `getEngine` calls `load()`, whose `engine.js:466` branch re-arms the safety
 * tick for `state.status === 'running'` — so an open stage re-plans itself on
 * the next tick with no user Resume click and no SSE subscription. Super Plan
 * engines opt out of the board boot resume gate (`resumeGate: false`), so the
 * armed production gate cannot hold them for a user answer.
 *
 * @param {{ clock?: typeof import('../orchestrator/engine.js').systemClock, tickMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function bootSuperPlanRuntime(options = {}) {
  try {
    const ids = await listEntries();
    for (const runId of ids) {
      try {
        const state = /** @type {import('./types').RunState} */ (await loadState(runId));
        if (!state || state.finished) continue;
        await getSuperPlanEngine(runId, {
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
        });
      } catch (error) { console.warn(`[super-plan] could not recover ${runId}:`, error instanceof Error ? error.message : error); }
    }
  } catch (err) {
    console.warn('[super-plan] boot scan failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests: drop engine registry + journal cache so cases do not leak. */
export function resetSuperPlanMiddlewareForTests() {
  disposeEngines(undefined, SUPERPLAN_NAMESPACE);
  for (const effector of activeEffectors) for (const attempt of effector.inspect()) void effector.stop(attempt.attemptId);
  activeEffectors.clear();
  resetDelegatedEffectors();
  resetJournalCache();
}

export { disposeEngines, MUTATING_ROUTES };
