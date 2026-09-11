/** HTTP routes for /api/super-plan, the engine registry wrapper and the boot scan. */

import { randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { makeEvent, CHECKPOINT_VERDICTS, OPTIONAL_STAGES, STAGES } from './events.js';
import { ENGINE_VERSION, openQuestion, readConfig } from './derive.js';
import { superPlanGraph } from './graph.js';
import {
  appendEvents,
  createEntry,
  deleteEntry,
  entryExists,
  listEntries,
  loadState,
  readHighestSeq,
  resetJournalCache,
  SUPERPLAN_NAMESPACE,
} from './journal.js';
import * as superPlanJournal from './journal.js';
import { createSuperPlanEffector } from './effector.js';
import { normalizeAnswer } from './ask.js';
import { slugFromPrompt } from './artifacts.js';
import { projectChatSummary, projectRunView } from './projection.js';
import { subscribeLive } from './live-events.js';
import { isTranscriptKey, listStepTranscripts, readStepTranscript } from './transcripts.js';
import { disposeEngines, getEngine, peekEngine } from '../orchestrator/engine.js';
import { resolveBoardResume } from '../orchestrator/resume-gate.js';
import { subscribeErrors } from '../orchestrator/live-events.js';
import { safeSegment } from '../orchestrator/journal-store.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';

/** Heartbeat cadence. Intermediaries close idle streams without it. */
const HEARTBEAT_MS = 15_000;

/** A view push coalesces the events of one burst. */
const VIEW_PUSH_MS = 40;

const MAX_FEEDBACK_CHARS = 8000;
const MAX_PROMPT_CHARS = 20_000;

// ── Engine registry ──────────────────────────────────────────────────────────

/**
 * How a run's effector is built. Tests inject a scripted effector.
 * @type {(runId: string) => import('../orchestrator/engine.js').Effector}
 */
export const createProductionSuperPlanEffector = (runId) => createSuperPlanEffector({ runId });

let makeEffector = createProductionSuperPlanEffector;
/** @type {Set<import('../orchestrator/engine.js').Effector>} */
const activeEffectors = new Set();

/**
 * @param {(runId: string) => import('../orchestrator/engine.js').Effector} factory
 */
export function setSuperPlanEffectorFactory(factory) {
  makeEffector = factory;
}

/**
 * Event streams following a run, told whenever the run gets its engine. A
 * stream can open on a finished run (no engine), and the run can come back:
 * a rework or a reopened checkpoint loads a new engine the stream must follow.
 * @type {Map<string, Set<(engine: any) => void>>}
 */
const engineFollowers = new Map();

/**
 * @param {string} runId
 * @param {(engine: any) => void} follow
 * @returns {() => void}
 */
function followEngine(runId, follow) {
  let set = engineFollowers.get(runId);
  if (!set) {
    set = new Set();
    engineFollowers.set(runId, set);
  }
  set.add(follow);
  return () => {
    set.delete(follow);
    if (!set.size && engineFollowers.get(runId) === set) engineFollowers.delete(runId);
  };
}

/**
 * The live engine for one run: namespace `superplan`, this directory's graph
 * and journal.
 * @param {string} runId
 * @param {{ clock?: typeof import('../orchestrator/engine.js').systemClock, tickMs?: number }} [options]
 */
export async function getSuperPlanEngine(runId, options = {}) {
  const engine = await getEngine(
    runId,
    () => {
      const effector = makeEffector(runId);
      activeEffectors.add(effector);
      return effector;
    },
    {
      namespace: SUPERPLAN_NAMESPACE,
      graph: /** @type {any} */ (superPlanGraph),
      journal: /** @type {any} */ (superPlanJournal),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
    },
  );
  // The shared boot gate asks the user before resuming boards. Super Plan
  // runs resume on their own, so release a hold taken while this one loaded.
  if (engine.wasHeldAtLoad()) await resolveBoardResume(runId, 'resume');
  for (const follow of engineFollowers.get(runId) ?? []) follow(engine);
  return engine;
}

/**
 * State from the live engine when loaded, otherwise from disk.
 * @param {string} runId
 * @returns {Promise<{ state: import('./types').RunState, seq: number, engine: any }>}
 */
async function readRun(runId) {
  const engine = peekEngine(runId, SUPERPLAN_NAMESPACE);
  if (engine) return { state: engine.getState(), seq: engine.getHighestSeq(), engine };
  const state = /** @type {import('./types').RunState} */ (await loadState(runId));
  return { state, seq: state.lastSeq || (await readHighestSeq(runId)), engine: null };
}

/**
 * @param {import('./types').RunState} state
 * @param {number} seq
 * @param {any} engine
 */
function viewOf(state, seq, engine) {
  const failure = engine?.getStartFailures?.()?.[0];
  return projectRunView(state, {
    seq,
    startFailure: failure ? { message: failure.message, consecutive: failure.consecutive } : null,
  });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
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
    if (body.length > 2_000_000) throw new Error('payload too large');
  }
  if (body.trim().length === 0) return {};
  const parsed = JSON.parse(body);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} runId
 */
async function requireRun(runId) {
  try {
    safeSegment(runId, 'run');
  } catch {
    throw new HttpError(400, 'invalid run id');
  }
  if (!(await entryExists(runId))) throw new HttpError(404, 'This plan no longer exists.');
}

/**
 * Append facts, then let the engine react.
 * @param {any} engine
 * @param {Record<string, unknown>[]} events
 */
async function commit(engine, events) {
  if (events.length) await engine.append(events);
  await engine.tick();
}

// ── Routes ───────────────────────────────────────────────────────────────────

/** @type {Array<{ method: string, pattern: RegExp, name: string }>} */
export const ROUTES = [
  { method: 'POST', pattern: /^\/api\/super-plan$/, name: 'create' },
  { method: 'GET', pattern: /^\/api\/super-plan\/runs$/, name: 'list' },
  { method: 'GET', pattern: /^\/api\/super-plan\/plans$/, name: 'plans' },
  { method: 'DELETE', pattern: /^\/api\/super-plan\/plans$/, name: 'delete-plan' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/state$/, name: 'state' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/events$/, name: 'events' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/transcripts$/, name: 'transcripts' },
  { method: 'GET', pattern: /^\/api\/super-plan\/([^/]+)\/transcripts\/([^/]+)$/, name: 'transcript' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/pause$/, name: 'pause' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/resume$/, name: 'resume' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/cancel$/, name: 'cancel' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/skip$/, name: 'skip' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/rework$/, name: 'rework' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/questions\/close$/, name: 'close-questions' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/questions\/([^/]+)\/answer$/, name: 'answer' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/checkpoint$/, name: 'checkpoint' },
  { method: 'POST', pattern: /^\/api\/super-plan\/([^/]+)\/rename$/, name: 'rename' },
  { method: 'DELETE', pattern: /^\/api\/super-plan\/([^/]+)$/, name: 'delete' },
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
    const status = err instanceof HttpError ? err.status : err instanceof SyntaxError ? 400 : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      } catch {
        /* closed */
      }
      res.end();
      return true;
    }
    if (status === 500) console.warn(`[super-plan] ${req.method} ${pathname} failed:`, message);
    json(res, status, { ok: false, error: message });
  }
  return true;
}

/**
 * @param {{ name: string, params: string[] }} route
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function dispatch(route, req, res) {
  if (route.name === 'create') return createRun(req, res);
  if (route.name === 'list') return listRuns(req, res);
  if (route.name === 'plans') return listPlanFiles(req, res);
  if (route.name === 'delete-plan') return deletePlanFile(req, res);

  const [runId, second] = route.params;
  await requireRun(runId);

  switch (route.name) {
    case 'state': {
      const { state, seq, engine } = await readRun(runId);
      return json(res, 200, { ok: true, runId, seq, view: viewOf(state, seq, engine) });
    }

    case 'events':
      return streamEvents(req, res, runId);

    case 'transcripts': {
      const { state } = await readRun(runId);
      const counts = new Map(listStepTranscripts(runId).map((row) => [row.key, row.messageCount]));
      const view = projectRunView(state);
      return json(res, 200, {
        ok: true,
        transcripts: view.transcripts.map((row) => ({ ...row, messageCount: counts.get(row.key) ?? 0 })),
      });
    }

    case 'transcript': {
      if (!isTranscriptKey(second)) throw new HttpError(400, 'invalid transcript key');
      const messages = readStepTranscript(runId, second) ?? [];
      return json(res, 200, { ok: true, key: second, messages });
    }

    case 'pause': {
      const engine = await getSuperPlanEngine(runId);
      const state = engine.getState();
      if (state.finished || state.status !== 'running') return respond(res, engine);
      await commit(engine, [makeEvent('run.paused', {})]);
      return respond(res, engine);
    }

    case 'resume': {
      const engine = await getSuperPlanEngine(runId);
      const state = engine.getState();
      if (state.legacy) throw new HttpError(409, 'This plan was made by an older version of Super Plan and cannot continue. Start a new plan.');
      if (state.finished) throw new HttpError(409, 'This plan has finished. Start a new one, or request changes to reopen it.');
      if (state.status === 'running') return respond(res, engine);
      await commit(engine, [makeEvent('run.resumed', {})]);
      return respond(res, engine);
    }

    case 'cancel': {
      const engine = await getSuperPlanEngine(runId);
      if (!engine.getState().finished) await commit(engine, [makeEvent('run.cancelled', { reason: 'user' })]);
      return respond(res, engine);
    }

    case 'skip': {
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const state = engine.getState();
      const stage = typeof body.stage === 'string' ? body.stage : state.step?.kind === 'stage' ? state.step.stage : '';
      if (!OPTIONAL_STAGES.includes(/** @type {any} */ (stage))) throw new HttpError(400, 'Only research, review and polish can be skipped.');
      if (state.finished || state.step?.kind !== 'stage' || state.step.stage !== stage) {
        throw new HttpError(409, `${stage} is not the stage that is running.`);
      }
      await commit(engine, [makeEvent('stage.skipped', { stage, reason: 'user' })]);
      return respond(res, engine);
    }

    case 'rework': {
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const state = engine.getState();
      const stage = typeof body.stage === 'string' ? body.stage : '';
      if (!STAGES.includes(/** @type {any} */ (stage))) throw new HttpError(400, 'unknown stage');
      if (state.legacy) throw new HttpError(409, 'This plan was made by an older version of Super Plan and cannot continue.');
      if (state.finished && state.stopReason !== 'complete') throw new HttpError(409, 'A cancelled plan cannot be reworked. Start a new one.');
      const done = state.stageRecords.some((r) => r.stage === stage && r.outcome === 'ok');
      const allowed = done || (stage === 'review' && Boolean(state.artifacts.plan)) || (stage === 'research' && Boolean(state.artifacts.spec));
      if (!allowed) throw new HttpError(409, 'That stage has not run yet.');
      await commit(engine, [makeEvent('stage.reopened', { stage, reason: 'user' })]);
      return respond(res, engine);
    }

    case 'close-questions': {
      const engine = await getSuperPlanEngine(runId);
      const state = engine.getState();
      if (state.finished || state.questionsClosed) return respond(res, engine);
      if (state.step?.kind !== 'stage' || state.step.stage !== 'interview') throw new HttpError(409, 'The interview is not running.');
      const events = [makeEvent('questions.closed', { reason: 'user' })];
      if (state.status === 'stopped' && state.stopReason === 'paused') events.push(makeEvent('run.resumed', { reason: 'answered' }));
      await commit(engine, events);
      return respond(res, engine);
    }

    case 'answer': {
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const state = engine.getState();
      const question = state.questions.find((q) => q.questionId === second);
      if (!question) throw new HttpError(404, 'no such question');
      if (question.status !== 'open') throw new HttpError(409, 'This question was already answered.');
      const normalized = normalizeAnswer(question, body.answer ?? body);
      if (!normalized.ok) throw new HttpError(400, normalized.error);
      const events = [makeEvent('question.answered', { questionId: question.questionId, answer: normalized.answer })];
      // Answering is an explicit "carry on".
      if (state.status === 'stopped' && state.stopReason === 'paused' && !state.finished) events.push(makeEvent('run.resumed', { reason: 'answered' }));
      await commit(engine, events);
      return respond(res, engine);
    }

    case 'checkpoint': {
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const state = engine.getState();
      const checkpoint = body.checkpoint === 'spec' || body.checkpoint === 'accept' ? body.checkpoint : '';
      const verdict = typeof body.verdict === 'string' ? body.verdict : '';
      if (!checkpoint) throw new HttpError(400, "checkpoint must be 'spec' or 'accept'");
      if (!CHECKPOINT_VERDICTS[checkpoint].includes(verdict)) {
        throw new HttpError(400, `verdict must be one of ${CHECKPOINT_VERDICTS[checkpoint].join(', ')}`);
      }
      const atCheckpoint = state.step?.kind === 'checkpoint' && state.step.checkpoint === checkpoint && !state.finished;
      const reopenAccepted = checkpoint === 'accept' && verdict !== 'accept' && state.finished && state.stopReason === 'complete';
      if (!atCheckpoint && !reopenAccepted) throw new HttpError(409, 'The plan is not waiting for that answer.');
      const feedback = typeof body.feedback === 'string' ? body.feedback.trim().slice(0, MAX_FEEDBACK_CHARS) : '';
      await commit(engine, [makeEvent('checkpoint.answered', { checkpoint, verdict, ...(feedback ? { feedback } : {}) })]);
      return respond(res, engine);
    }

    case 'rename': {
      const engine = await getSuperPlanEngine(runId);
      const body = await readJsonBody(req);
      const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      if (!title) throw new HttpError(400, 'title is required');
      await commit(engine, [makeEvent('run.renamed', { title })]);
      return respond(res, engine);
    }

    case 'delete': {
      const loaded = peekEngine(runId, SUPERPLAN_NAMESPACE);
      if (loaded && !loaded.getState().finished) {
        await loaded.append([makeEvent('run.cancelled', { reason: 'user' })]);
        await loaded.tick();
      }
      disposeEngines(runId, SUPERPLAN_NAMESPACE);
      await deleteEntry(runId);
      return json(res, 200, { ok: true });
    }

    default:
      throw new HttpError(404, 'no such route');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {any} engine
 */
function respond(res, engine) {
  const state = engine.getState();
  const seq = engine.getHighestSeq();
  return json(res, 200, { ok: true, runId: state.runId, seq, view: viewOf(state, seq, engine) });
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function createRun(req, res) {
  const body = await readJsonBody(req);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'Describe what the plan should cover.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, `Keep the request under ${MAX_PROMPT_CHARS} characters; attach detail in the interview.`);
  const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath.trim() : '';
  if (!workspacePath) throw new HttpError(400, 'Open a workspace folder before starting a plan.');
  try {
    if (!(await stat(workspacePath)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new HttpError(400, `The workspace folder ${workspacePath} is not available.`);
  }

  const runId = `${slugFromPrompt(prompt, 36) || 'plan'}-${randomBytes(3).toString('hex')}`;
  await createEntry(runId);
  const config = { ...readConfig(body.config), engine: ENGINE_VERSION };
  await appendEvents(runId, [
    makeEvent('run.created', {
      runId,
      prompt,
      workspacePath,
      config,
      ...(typeof body.chatId === 'string' && body.chatId ? { chatId: body.chatId } : {}),
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim().slice(0, 120) } : {}),
    }),
    makeEvent('run.started', {}),
  ]);
  const engine = await getSuperPlanEngine(runId);
  await engine.tick();
  const state = engine.getState();
  const seq = engine.getHighestSeq();
  return json(res, 201, { ok: true, runId, seq, view: viewOf(state, seq, engine) });
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Summaries for the sidebar and plan library: `?ids=a,b` or `?active=1`.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function listRuns(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const idsParam = url.searchParams.get('ids');
  const activeOnly = url.searchParams.get('active') === '1';
  const ids = idsParam ? idsParam.split(',').map((id) => id.trim()).filter(Boolean) : await listEntries();
  const runs = [];
  for (const runId of ids.slice(0, 500)) {
    try {
      safeSegment(runId, 'run');
      if (!(await entryExists(runId))) continue;
      const { state, seq } = await readRun(runId);
      if (activeOnly && state.finished) continue;
      runs.push({ ...projectChatSummary(state, { seq }), chatId: state.chatId, workspacePath: state.workspacePath });
    } catch {
      /* one unreadable run does not hide the rest */
    }
  }
  return json(res, 200, { ok: true, runs });
}

/** Saved plans the library lists: files directly under documentation/plans/. */
const PLANS_DIR = path.join('documentation', 'plans');

/**
 * The plan files in the requesting view's workspace, newest first. The library
 * reads this rather than a model tool, so it works whatever the user's tool
 * permissions are.
 * @param {import('node:http').IncomingMessage} _req
 * @param {import('node:http').ServerResponse} res
 */
async function listPlanFiles(_req, res) {
  const root = getRequestWorkspaceRoot();
  const dir = path.join(root, PLANS_DIR);
  /** @type {import('node:fs').Dirent[]} */
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return json(res, 200, { ok: true, workspacePath: root, plans: [] });
    throw err;
  }
  const plans = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    try {
      const info = await stat(path.join(dir, entry.name));
      plans.push({ path: `documentation/plans/${entry.name}`, modifiedAt: info.mtimeMs, bytes: info.size });
    } catch {
      /* removed between readdir and stat */
    }
  }
  plans.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return json(res, 200, { ok: true, workspacePath: root, plans: plans.slice(0, 500) });
}

/**
 * Delete one plan document the user chose to remove from the library. Only
 * markdown under documentation/plans/ in the requesting view's workspace.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function deletePlanFile(req, res) {
  const body = await readJsonBody(req);
  const rel = typeof body.path === 'string' ? body.path.trim().replace(/\\/g, '/') : '';
  const segments = rel.split('/');
  if (
    !rel.startsWith('documentation/plans/') ||
    !rel.toLowerCase().endsWith('.md') ||
    segments.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new HttpError(400, 'Only plan documents under documentation/plans/ can be deleted here.');
  }
  const root = getRequestWorkspaceRoot();
  const target = path.resolve(root, ...segments);
  const plansRoot = path.resolve(root, PLANS_DIR);
  if (!target.startsWith(plansRoot + path.sep)) throw new HttpError(400, 'That path is outside documentation/plans/.');
  try {
    await unlink(target);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  return json(res, 200, { ok: true, path: rel });
}

// ── Events stream ────────────────────────────────────────────────────────────

/**
 * Stream a run's view (on every journal change) and its live channel.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} runId
 */
async function streamEvents(req, res, runId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(': connected\n\n');

  let closed = false;
  /** @type {Array<() => void>} */
  const cleanups = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* already gone */
      }
    }
    try {
      res.end();
    } catch {
      /* closed */
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  /**
   * @param {string} type
   * @param {unknown} data
   */
  const send = (type, data) => {
    if (closed) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      cleanup();
    }
  };

  const { state: diskState } = await readRun(runId);
  if (closed) return;

  /** @type {any} */
  let engine = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pending = null;
  const pushView = () => {
    const current = engine ? engine.getState() : diskState;
    const seq = engine ? engine.getHighestSeq() : current.lastSeq;
    send('view', viewOf(current, seq, engine));
  };
  /** @param {any} next */
  const attach = (next) => {
    if (closed || !next || next === engine) return;
    unsubscribe?.();
    engine = next;
    unsubscribe = next.subscribe((/** @type {any} */ event) => {
      send('event', { type: event.type, seq: event.seq, ...(event.stage ? { stage: event.stage } : {}) });
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        pushView();
      }, VIEW_PUSH_MS);
    });
    pushView();
  };
  cleanups.push(followEngine(runId, attach));
  cleanups.push(() => {
    unsubscribe?.();
    if (pending) clearTimeout(pending);
  });

  // A finished run needs no live engine until something reopens it; anything
  // else is loaded so its changes stream (and a running one resumes).
  const loaded = peekEngine(runId, SUPERPLAN_NAMESPACE);
  if (loaded) attach(loaded);
  else if (!diskState.finished && !diskState.legacy) attach(await getSuperPlanEngine(runId));
  if (!engine) pushView();
  cleanups.push(subscribeLive(runId, (payload) => send('live', payload)));
  cleanups.push(
    subscribeErrors(runId, (payload) => send('error', { message: payload?.message ?? 'The stage could not start.', stage: payload?.role ?? null })),
  );
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  cleanups.push(() => clearInterval(heartbeat));
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
 * Re-arm every run that was running when the server stopped. Paused, halted
 * and finished runs stay on disk until someone opens them.
 * @param {{ clock?: typeof import('../orchestrator/engine.js').systemClock, tickMs?: number }} [options]
 */
export async function bootSuperPlanRuntime(options = {}) {
  try {
    for (const runId of await listEntries()) {
      try {
        const state = /** @type {import('./types').RunState} */ (await loadState(runId));
        if (!state || state.finished || state.legacy || state.status !== 'running') continue;
        const engine = await getSuperPlanEngine(runId, options);
        await engine.tick();
      } catch (error) {
        console.warn(`[super-plan] could not recover ${runId}:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (err) {
    console.warn('[super-plan] boot scan failed:', err instanceof Error ? err.message : err);
  }
}

/** Tests: drop the engine registry and journal cache so cases do not leak. */
export function resetSuperPlanMiddlewareForTests() {
  disposeEngines(undefined, SUPERPLAN_NAMESPACE);
  for (const effector of activeEffectors) {
    for (const attempt of effector.inspect()) void effector.stop(attempt.attemptId);
  }
  activeEffectors.clear();
  resetJournalCache();
  makeEffector = createProductionSuperPlanEffector;
}

export { disposeEngines, openQuestion };
