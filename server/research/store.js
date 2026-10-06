/**
 * Deep Research task registry, SSE progress, and ~/.minnow/research persistence.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import {
  readActiveChatModelBinding,
  useJsonSessionsStore,
} from '../config/sessions-repo.js';
import { readResource } from '../config/store.js';
import { getActiveProviderId } from '../providers/store.js';
import { validateProviderId } from '../providers/validate.js';
import { runWithToolContext } from '../runtime/path-access.js';
import { validateWorkspacePath } from '../workspace/root.js';
import { DeepResearcher, normalizeResearchScope } from './engine.js';
import { stripThinking, isLowQuality } from './strip-thinking.js';
import { extractReportTitle } from './visual-report.js';

/** Composite #modelSelect value separator (see src/lib/model-select-key.ts). */
const MODEL_SELECT_KEY_SEP = '\u001f';

/** Strict research id: rs- + 12 hex chars. */
export const RESEARCH_ID_RE = /^rs-[a-f0-9]{12}$/;

/** @typedef {'running' | 'done' | 'error' | 'cancelled'} ResearchStatus */

/** @typedef {import('http').ServerResponse} ServerResponse */

/**
 * @typedef {object} ResearchTaskState
 * @property {string} id
 * @property {string} query
 * @property {string} [title]
 * @property {ResearchStatus} status
 * @property {Record<string, unknown>} progress
 * @property {string | null} result
 * @property {string} rawReport
 * @property {Array<{ url: string; title: string; image?: string }>} sources
 * @property {Array<{ url: string; title: string; summary: string }>} rawFindings
 * @property {Record<string, string | number>} stats
 * @property {string} category
 * @property {string} providerId
 * @property {string} model
 * @property {string} startedAt
 * @property {string | null} completedAt
 * @property {boolean} archived
 * @property {Set<ServerResponse>} subscribers
 * @property {Buffer[]} events
 * @property {DeepResearcher | null} researcher
 * @property {AbortController | null} abortController
 * @property {boolean} cancelRequested
 * @property {boolean} runTimedOut
 * @property {string | null} errorMessage
 * @property {ReturnType<typeof setTimeout> | null} runTimeoutTimer
 * @property {boolean} [checkpointPersisted]
 * @property {ReturnType<typeof setTimeout> | null} [persistDebounceTimer]
 * @property {boolean} [terminalPersisted]
 * @property {Promise<void> | null} [persistChain]
 * @property {Promise<void> | null} [runPromise]
 */

/** @type {Map<string, ResearchTaskState>} */
const tasks = new Map();

/**
 * @typedef {{ queue: Buffer[], draining: boolean, endAfterFlush?: boolean }} SubscriberWriteState
 */

/** @type {WeakMap<ServerResponse, SubscriberWriteState>} */
const subscriberWrites = new WeakMap();

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isResearchId(id) {
  return typeof id === 'string' && RESEARCH_ID_RE.test(id);
}

/**
 * @returns {string}
 */
export function createResearchId() {
  return `rs-${randomBytes(6).toString('hex')}`;
}

/**
 * @returns {string}
 */
export function getResearchDataDir() {
  return path.join(getMinnowHome(), 'research');
}

/**
 * @param {string} id
 * @returns {string}
 */
export function getResearchFilePath(id) {
  return path.join(getResearchDataDir(), `${id}.json`);
}

/**
 * Ensure ~/.minnow/research exists (lightweight — avoids full layout races in tests).
 * @returns {Promise<string>}
 */
async function ensureResearchDataDir() {
  const dir = getResearchDataDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} value
 * @returns {{ providerId: string; modelId: string } | null}
 */
function decodeModelSelectKey(value) {
  const trimmed = value.trim();
  const idx = trimmed.indexOf(MODEL_SELECT_KEY_SEP);
  if (idx <= 0 || idx === trimmed.length - 1) {
    return null;
  }
  const providerId = trimmed.slice(0, idx).trim();
  const modelId = trimmed.slice(idx + 1).trim();
  if (!providerId || !modelId) {
    return null;
  }
  return { providerId, modelId };
}

/**
 * Resolve provider + model: request overrides → research.json → active chat → error.
 * @param {{ providerId?: string; model?: string }} [overrides]
 * @returns {Promise<{ providerId: string; model: string }>}
 */
export async function resolveResearchModel(overrides = {}) {
  const bodyProvider = typeof overrides.providerId === 'string' ? overrides.providerId.trim() : '';
  const bodyModel = typeof overrides.model === 'string' ? overrides.model.trim() : '';

  const config = /** @type {Record<string, unknown>} */ (await readResource('research'));
  const cfgModelObj =
    config.model && typeof config.model === 'object'
      ? /** @type {Record<string, unknown>} */ (config.model)
      : {};
  const cfgProvider =
    typeof cfgModelObj.providerId === 'string' ? cfgModelObj.providerId.trim() : '';
  const cfgModel = typeof cfgModelObj.model === 'string' ? cfgModelObj.model.trim() : '';

  if (bodyProvider && bodyModel) {
    return { providerId: validateProviderId(bodyProvider), model: bodyModel };
  }
  if (cfgProvider && cfgModel) {
    return { providerId: validateProviderId(cfgProvider), model: cfgModel };
  }

  /** @type {{ providerId?: string; modelId?: string }} */
  let chatBinding = {};
  try {
    if (!useJsonSessionsStore()) {
      const binding = readActiveChatModelBinding();
      if (binding && typeof binding.modelId === 'string' && binding.modelId.trim()) {
        const decoded = decodeModelSelectKey(binding.modelId);
        if (decoded) {
          chatBinding = { providerId: decoded.providerId, modelId: decoded.modelId };
        } else {
          chatBinding = {
            providerId: typeof binding.providerId === 'string' ? binding.providerId.trim() : '',
            modelId: binding.modelId.trim(),
          };
        }
      }
    } else {
      const sessions = /** @type {Record<string, unknown>} */ (await readResource('sessions'));
      const activeId = typeof sessions.activeId === 'string' ? sessions.activeId : '';
      const chats = Array.isArray(sessions.chats) ? sessions.chats : [];
      const chat = chats.find(
        (c) => c && typeof c === 'object' && /** @type {{ id?: string }} */ (c).id === activeId,
      );
      if (chat && typeof chat === 'object') {
        const row = /** @type {{ modelId?: string; providerId?: string }} */ (chat);
        if (typeof row.modelId === 'string' && row.modelId.trim()) {
          const decoded = decodeModelSelectKey(row.modelId);
          if (decoded) {
            chatBinding = { providerId: decoded.providerId, modelId: decoded.modelId };
          } else {
            chatBinding = {
              providerId: typeof row.providerId === 'string' ? row.providerId.trim() : '',
              modelId: row.modelId.trim(),
            };
          }
        }
      }
    }
  } catch {
    /* sessions unavailable — fall through */
  }

  const providerId = validateProviderId(
    bodyProvider || cfgProvider || chatBinding.providerId || (await getActiveProviderId()),
  );
  const model = bodyModel || cfgModel || chatBinding.modelId || '';
  if (!model) {
    throw new Error(
      'No research model configured. Set Settings → Deep Research model or pass providerId and model.',
    );
  }
  return { providerId, model };
}

/**
 * @param {unknown[]} findings
 * @returns {Array<{ url: string; title: string; image?: string }>}
 */
export function extractSources(findings) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ url: string; title: string; image?: string }>} */
  const sources = [];
  for (const raw of findings) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const f = /** @type {Record<string, unknown>} */ (raw);
    const url = typeof f.url === 'string' ? f.url : '';
    const title =
      (typeof f.title === 'string' && f.title) || url;
    const summary =
      (typeof f.summary === 'string' && f.summary) ||
      (typeof f.evidence === 'string' ? f.evidence : '');
    if (url && !seen.has(url) && !isLowQuality(summary)) {
      seen.add(url);
      /** @type {{ url: string; title: string; image?: string }} */
      const entry = { url, title };
      const og = typeof f.og_image === 'string' ? f.og_image : '';
      if (og) {
        entry.image = og;
      }
      sources.push(entry);
    }
  }
  return sources;
}

/**
 * @param {unknown[]} findings
 * @returns {Array<{ url: string; title: string; summary: string }>}
 */
export function extractRawFindings(findings) {
  /** @type {Array<{ url: string; title: string; summary: string }>} */
  const items = [];
  try {
    for (const raw of findings) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const f = /** @type {Record<string, unknown>} */ (raw);
      const url = typeof f.url === 'string' ? f.url : '';
      const title = (typeof f.title === 'string' && f.title) || 'Untitled';
      const summary = typeof f.summary === 'string' ? f.summary : '';
      const evidence = typeof f.evidence === 'string' ? f.evidence : '';
      const content = summary || (evidence ? evidence.slice(0, 2000) : '');
      if (url && content && !isLowQuality(content)) {
        items.push({ url, title, summary: content });
      }
    }
  } catch {
    return [];
  }
  return items;
}

/**
 * @param {ResearchStatus} status
 * @returns {boolean}
 */
function isTerminal(status) {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {Buffer}
 */
function formatSseData(obj) {
  return Buffer.from(`data: ${JSON.stringify(obj)}\n\n`, 'utf8');
}

/**
 * Parse persisted SSE buffers into operational activity log entries.
 * @param {Buffer[]} events
 * @returns {Record<string, unknown>[]}
 */
function parseActivityLogFromEvents(events) {
  /** @type {Record<string, unknown>[]} */
  const log = [];
  for (const buf of events) {
    const text = buf.toString('utf8');
    const match = text.match(/^data:\s*(.+)$/m);
    if (!match) {
      continue;
    }
    try {
      const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(match[1]));
      if (typeof parsed.phase !== 'string') {
        continue;
      }
      const { status, final, ...rest } = parsed;
      log.push(rest);
    } catch {
      /* ignore malformed buffers */
    }
  }
  return log;
}

/** Debounce window for checkpointing in-flight runs to disk (reload / server restart). */
const RESEARCH_CHECKPOINT_DEBOUNCE_MS = 1500;

/**
 * @param {ResearchTaskState} state
 */
function scheduleResearchCheckpoint(state) {
  if (isTerminal(state.status)) {
    return;
  }
  if (state.persistDebounceTimer) {
    clearTimeout(state.persistDebounceTimer);
  }
  state.persistDebounceTimer = setTimeout(() => {
    state.persistDebounceTimer = null;
    void queueResearchPersist(state).catch((err) => {
      console.error('[research] checkpoint persist failed:', err);
    });
  }, RESEARCH_CHECKPOINT_DEBOUNCE_MS);
}

/**
 * @param {ResearchTaskState} state
 */
function checkpointResearchProgress(state) {
  if (isTerminal(state.status)) {
    return;
  }
  if (!state.checkpointPersisted) {
    state.checkpointPersisted = true;
    void queueResearchPersist(state).catch((err) => {
      console.error('[research] initial checkpoint failed:', err);
    });
    return;
  }
  scheduleResearchCheckpoint(state);
}

/**
 * @param {ServerResponse} res
 * @returns {SubscriberWriteState}
 */
function getWriteState(res) {
  let w = subscriberWrites.get(res);
  if (!w) {
    w = { queue: [], draining: false };
    subscriberWrites.set(res, w);
  }
  return w;
}

/**
 * @param {ServerResponse} res
 * @returns {boolean}
 */
function canWriteToSubscriber(res) {
  return !res.writableEnded && !res.destroyed;
}

/**
 * @param {ResearchTaskState} state
 * @param {ServerResponse} res
 */
function detachSubscriber(state, res) {
  state.subscribers.delete(res);
  subscriberWrites.delete(res);
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {ResearchTaskState} state
 * @param {ServerResponse} res
 * @param {{ terminal?: boolean }} [opts]
 */
function flushSubscriberQueue(state, res, opts = {}) {
  if (!canWriteToSubscriber(res)) {
    if (!opts.terminal) {
      detachSubscriber(state, res);
    } else {
      subscriberWrites.delete(res);
    }
    return;
  }

  const w = getWriteState(res);
  const requireSubscriber = !opts.terminal;

  while (w.queue.length > 0) {
    if (requireSubscriber && !state.subscribers.has(res)) {
      subscriberWrites.delete(res);
      return;
    }
    const buf = w.queue.shift();
    try {
      const ok = res.write(buf);
      if (!ok) {
        if (!w.draining) {
          w.draining = true;
          res.once('drain', () => {
            w.draining = false;
            flushSubscriberQueue(state, res, opts);
          });
        }
        return;
      }
    } catch {
      if (!opts.terminal) {
        detachSubscriber(state, res);
      } else {
        subscriberWrites.delete(res);
      }
      return;
    }
  }

  if (w.endAfterFlush) {
    subscriberWrites.delete(res);
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * @param {ResearchTaskState} state
 * @param {ServerResponse} res
 * @param {Buffer} buf
 */
function enqueueToSubscriber(state, res, buf) {
  if (!canWriteToSubscriber(res)) {
    detachSubscriber(state, res);
    return;
  }
  if (!state.subscribers.has(res)) {
    return;
  }
  const w = getWriteState(res);
  w.queue.push(buf);
  flushSubscriberQueue(state, res);
}

/**
 * @param {ResearchTaskState} state
 * @param {Record<string, unknown>} event
 */
function appendProgress(state, event) {
  if (isTerminal(state.status) && state.terminalPersisted === true) {
    return;
  }
  state.progress = event;
  const buf = formatSseData({ ...event, status: state.status });
  state.events.push(buf);
  for (const res of [...state.subscribers]) {
    enqueueToSubscriber(state, res, buf);
  }
  checkpointResearchProgress(state);
}

/**
 * @param {ResearchTaskState} state
 */
function broadcastTerminal(state) {
  /** @type {Record<string, unknown>} */
  const payload = { status: state.status, final: true };
  if (state.errorMessage) {
    payload.message = state.errorMessage;
  }
  const buf = formatSseData(payload);
  for (const res of [...state.subscribers]) {
    state.subscribers.delete(res);
    try {
      if (canWriteToSubscriber(res)) {
        const w = getWriteState(res);
        w.queue.push(buf);
        w.endAfterFlush = true;
        flushSubscriberQueue(state, res, { terminal: true });
      } else {
        res.destroy();
      }
    } catch {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  }
  state.subscribers.clear();
}

/**
 * @param {ResearchTaskState} state
 */
function finalizeFromResearcher(state) {
  const researcher = state.researcher;
  if (!researcher) {
    return;
  }
  state.sources = extractSources(researcher.findings);
  state.rawFindings = extractRawFindings(researcher.findings);
  state.stats = researcher.getStats();
  if (researcher.category) {
    state.category = researcher.category;
  }
}

/**
 * @param {ResearchTaskState} state
 * @returns {Promise<void>}
 */
async function persistResearch(state) {
  await ensureResearchDataDir();
  const filePath = getResearchFilePath(state.id);
  /** @type {Record<string, unknown>} */
  const data = {
    id: state.id,
    query: state.query,
    title: resolveResearchTitle(state) || undefined,
    status: state.status,
    result: state.result,
    raw_report: state.rawReport,
    sources: state.sources,
    raw_findings: state.rawFindings,
    stats: state.stats,
    category: state.category,
    providerId: state.providerId,
    model: state.model,
    started_at: state.startedAt,
    completed_at: state.completedAt,
    archived: state.archived,
    activity_log: parseActivityLogFromEvents(state.events),
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Serialize writes for one run so a stale checkpoint can never land after the
 * terminal snapshot or recreate a result after deletion.
 * @param {ResearchTaskState} state
 * @returns {Promise<void>}
 */
function queueResearchPersist(state) {
  const prior = state.persistChain ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => persistResearch(state));
  state.persistChain = next;
  return next;
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function loadResearchFromDisk(id) {
  if (!isResearchId(id)) {
    return null;
  }
  const filePath = getResearchFilePath(id);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * @param {string} id
 * @returns {ResearchTaskState | undefined}
 */
export function getResearchTask(id) {
  return tasks.get(id);
}

/**
 * @param {ResearchTaskState} state
 * @param {ServerResponse} res
 */
export function addSubscriber(state, res) {
  state.subscribers.add(res);
  for (const buf of state.events) {
    enqueueToSubscriber(state, res, buf);
  }
  if (isTerminal(state.status)) {
    /** @type {Record<string, unknown>} */
    const payload = { status: state.status, final: true };
    if (state.errorMessage) {
      payload.message = state.errorMessage;
    }
    try {
      if (canWriteToSubscriber(res)) {
        const w = getWriteState(res);
        w.queue.push(formatSseData(payload));
        w.endAfterFlush = true;
        flushSubscriberQueue(state, res, { terminal: true });
      }
    } catch {
      /* subscriber may already be closed */
    }
    state.subscribers.delete(res);
  }
}

/**
 * @param {ResearchTaskState} state
 * @param {ServerResponse} res
 */
export function removeSubscriber(state, res) {
  detachSubscriber(state, res);
}

function resolveResearchTitle(state) {
  const existing = typeof state.title === 'string' ? state.title.trim() : '';
  if (existing) return existing;
  const report =
    typeof state.result === 'string' && state.result.trim()
      ? state.result
      : typeof state.rawReport === 'string'
        ? state.rawReport
        : '';
  if (!report) return '';
  const { title } = extractReportTitle(report, state.query);
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * @param {ResearchTaskState} state
 */
function markDone(state) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'done';
  state.completedAt = new Date().toISOString();
  const title = resolveResearchTitle(state);
  if (title) {
    state.title = title;
  }
}

/**
 * @param {ResearchTaskState} state
 * @param {string} message
 */
function markError(state, message) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'error';
  state.errorMessage = message;
  state.completedAt = new Date().toISOString();
  appendProgress(state, { phase: 'error', message });
}

/**
 * @param {ResearchTaskState} state
 */
function markCancelled(state) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'cancelled';
  state.completedAt = new Date().toISOString();
}

/**
 * @param {ResearchTaskState} state
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, unknown>}
 */
function mergeEngineConfig(config, overrides) {
  const merged = { ...config };
  const numericKeys = [
    'maxRounds',
    'minRounds',
    'maxTimeSeconds',
    'runTimeoutSeconds',
    'maxReportTokens',
    'extractionTimeoutSeconds',
    'extractionConcurrency',
    'maxUrlsPerRound',
    'maxContentChars',
    'synthesisWindow',
    'maxEmptyRounds',
  ];
  for (const key of numericKeys) {
    if (overrides[key] !== undefined && overrides[key] !== null) {
      merged[key] = overrides[key];
    }
  }
  if (typeof overrides.searchProvider === 'string' && overrides.searchProvider.trim()) {
    merged.searchProvider = overrides.searchProvider.trim();
  } else if (typeof config.searchProvider === 'string' && config.searchProvider.trim()) {
    merged.searchProvider = config.searchProvider.trim();
  }
  if (typeof overrides.category === 'string' && overrides.category.trim()) {
    merged.category = overrides.category.trim();
  }
  if (typeof overrides.scope === 'string' && overrides.scope.trim()) {
    merged.scope = normalizeResearchScope(overrides.scope);
  }
  if (typeof overrides.workspaceRoot === 'string' && overrides.workspaceRoot.trim()) {
    merged.workspaceRoot = overrides.workspaceRoot.trim();
  }
  return merged;
}

/**
 * @param {ResearchTaskState} state
 * @param {object} opts
 * @param {string} [opts.priorReport]
 * @param {unknown[] | null} [opts.priorFindings]
 * @param {Set<string> | string[] | null} [opts.priorUrls]
 * @param {Record<string, unknown>} opts.engineConfig
 * @returns {Promise<void>}
 */
async function runResearchTask(state, opts) {
  const abortController = new AbortController();
  state.abortController = abortController;

  const cfg = opts.engineConfig;
  const runTimeoutSeconds = Number(cfg.runTimeoutSeconds ?? 1800);

  /** @type {DeepResearcher} */
  const researcher = new DeepResearcher({
    providerId: state.providerId,
    model: state.model,
    maxRounds: Number(cfg.maxRounds ?? 0),
    minRounds: Number(cfg.minRounds ?? 3),
    maxTimeSeconds: Number(cfg.maxTimeSeconds ?? 300),
    maxReportTokens: Number(cfg.maxReportTokens ?? 16384),
    extractionTimeoutSeconds: Number(cfg.extractionTimeoutSeconds ?? 90),
    extractionConcurrency: Number(cfg.extractionConcurrency ?? 3),
    maxUrlsPerRound: Number(cfg.maxUrlsPerRound ?? 3),
    maxContentChars: Number(cfg.maxContentChars ?? 15_000),
    synthesisWindow: Number(cfg.synthesisWindow ?? 10),
    maxEmptyRounds: Number(cfg.maxEmptyRounds ?? 2),
    searchProvider: typeof cfg.searchProvider === 'string' ? cfg.searchProvider : '',
    category: state.category || (typeof cfg.category === 'string' ? cfg.category : ''),
    scope: normalizeResearchScope(typeof cfg.scope === 'string' ? cfg.scope : 'web'),
    ...(typeof cfg.workspaceRoot === 'string' && cfg.workspaceRoot.trim()
      ? { workspaceRoot: cfg.workspaceRoot.trim() }
      : {}),
    progressCallback: (event) => appendProgress(state, event),
  });

  state.researcher = researcher;

  if (runTimeoutSeconds > 0) {
    state.runTimeoutTimer = setTimeout(() => {
      state.runTimedOut = true;
      researcher.cancel();
      abortController.abort();
    }, runTimeoutSeconds * 1000);
  }

  appendProgress(state, { phase: 'probing', model: state.model });

  try {
    const workspaceRoot =
      typeof cfg.workspaceRoot === 'string' ? cfg.workspaceRoot.trim() : '';
    const runResearch = async () =>
      researcher.research({
        question: state.query,
        priorReport: opts.priorReport ?? '',
        priorFindings: /** @type {import('./extractor.js').ResearchFinding[] | null} */ (
          opts.priorFindings ?? null
        ),
        priorUrls: opts.priorUrls ?? null,
        signal: abortController.signal,
      });

    const result = workspaceRoot
      ? await runWithToolContext(runResearch, { workspaceRoot })
      : await runResearch();

    finalizeFromResearcher(state);

    if (state.cancelRequested) {
      if (result) {
        state.result = result;
        state.rawReport = stripThinking(result) ?? '';
      } else if (researcher.evolvingReport) {
        state.result = researcher.evolvingReport;
        state.rawReport = stripThinking(researcher.evolvingReport) ?? '';
      }
      markCancelled(state);
      return;
    }

    if (state.runTimedOut) {
      if (researcher.evolvingReport) {
        state.result = researcher.evolvingReport;
        state.rawReport = stripThinking(researcher.evolvingReport) ?? '';
        markDone(state);
        return;
      }
      markError(state, `Research timed out after ${runTimeoutSeconds}s`);
      state.result =
        state.result ||
        `Research timed out after ${runTimeoutSeconds}s. The model may be too slow for deep research.`;
      return;
    }

    state.result = result;
    state.rawReport = stripThinking(result) ?? '';
    markDone(state);
  } catch (err) {
    finalizeFromResearcher(state);
    if (state.cancelRequested) {
      markCancelled(state);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (researcher.evolvingReport && state.runTimedOut) {
      state.result = researcher.evolvingReport;
      state.rawReport = stripThinking(researcher.evolvingReport) ?? '';
      markDone(state);
      return;
    }
    state.result = message;
    markError(state, message);
  } finally {
    if (state.runTimeoutTimer) {
      clearTimeout(state.runTimeoutTimer);
      state.runTimeoutTimer = null;
    }
    if (state.persistDebounceTimer) {
      clearTimeout(state.persistDebounceTimer);
      state.persistDebounceTimer = null;
    }
    try {
      await queueResearchPersist(state);
      state.terminalPersisted = true;
    } catch (err) {
      console.error('[research] persist failed:', err);
      state.status = 'error';
      state.errorMessage = `Could not save research result: ${err instanceof Error ? err.message : String(err)}`;
      state.completedAt = new Date().toISOString();
      state.terminalPersisted = true;
    }
    broadcastTerminal(state);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.providerId]
 * @param {string} [opts.model]
 * @param {string} [opts.continueFrom]
 * @param {string} [opts.category]
 * @param {string} [opts.searchProvider]
 * @param {number} [opts.maxRounds]
 * @param {number} [opts.minRounds]
 * @param {number} [opts.maxTimeSeconds]
 * @param {number} [opts.runTimeoutSeconds]
 * @param {number} [opts.maxReportTokens]
 * @param {number} [opts.extractionTimeoutSeconds]
 * @param {number} [opts.extractionConcurrency]
 * @param {number} [opts.maxUrlsPerRound]
 * @param {number} [opts.maxContentChars]
 * @param {number} [opts.synthesisWindow]
 * @param {number} [opts.maxEmptyRounds]
 * @returns {Promise<{ researchId: string }>}
 */
export async function startResearch(opts) {
  const query = typeof opts.query === 'string' ? opts.query.trim() : '';
  if (!query) {
    throw new Error('query is required');
  }

  await ensureResearchDataDir();

  const { providerId, model } = await resolveResearchModel({
    providerId: opts.providerId,
    model: opts.model,
  });

  const baseConfig = /** @type {Record<string, unknown>} */ (await readResource('research'));
  const engineConfig = mergeEngineConfig(baseConfig, opts);

  const scope = normalizeResearchScope(engineConfig.scope);
  if (
    (scope === 'codebase' || scope === 'both') &&
    typeof opts.workspaceRoot === 'string' &&
    opts.workspaceRoot.trim()
  ) {
    engineConfig.workspaceRoot = await validateWorkspacePath(opts.workspaceRoot);
  }

  /** @type {string} */
  let priorReport = '';
  /** @type {unknown[] | null} */
  let priorFindings = null;
  /** @type {Set<string> | null} */
  let priorUrls = null;

  if (typeof opts.continueFrom === 'string' && isResearchId(opts.continueFrom)) {
    const prior = await loadResearchFromDisk(opts.continueFrom);
    if (!prior) {
      throw new Error(`Prior research not found: ${opts.continueFrom}`);
    }
    priorReport =
      (typeof prior.raw_report === 'string' && prior.raw_report) ||
      (typeof prior.result === 'string' ? prior.result : '');
    priorFindings = Array.isArray(prior.raw_findings) ? prior.raw_findings : null;
    const sources = Array.isArray(prior.sources) ? prior.sources : [];
    const urls = sources
      .map((s) => (s && typeof s === 'object' ? /** @type {{ url?: string }} */ (s).url : ''))
      .filter(Boolean);
    priorUrls = urls.length ? new Set(urls) : null;
  }

  const id = createResearchId();
  /** @type {ResearchTaskState} */
  const state = {
    id,
    query,
    status: 'running',
    progress: {},
    result: null,
    rawReport: '',
    sources: [],
    rawFindings: [],
    stats: {},
    category: typeof opts.category === 'string' ? opts.category.trim() : '',
    providerId,
    model,
    startedAt: new Date().toISOString(),
    completedAt: null,
    archived: false,
    subscribers: new Set(),
    events: [],
    researcher: null,
    abortController: null,
    cancelRequested: false,
    runTimedOut: false,
    errorMessage: null,
    runTimeoutTimer: null,
    checkpointPersisted: false,
    persistDebounceTimer: null,
    terminalPersisted: false,
    persistChain: null,
    runPromise: null,
  };

  tasks.set(id, state);
  await queueResearchPersist(state);
  state.checkpointPersisted = true;

  state.runPromise = runResearchTask(state, {
    priorReport,
    priorFindings,
    priorUrls,
    engineConfig,
  });

  return { researchId: id };
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function cancelResearch(id) {
  const state = tasks.get(id);
  if (!state || state.status !== 'running') {
    return false;
  }
  state.cancelRequested = true;
  state.researcher?.cancel();
  state.abortController?.abort();
  return true;
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getResearchStatus(id) {
  const live = tasks.get(id);
  if (live) {
    const settled = !isTerminal(live.status) || live.terminalPersisted === true;
    return {
      status: settled ? live.status : 'running',
      progress: live.progress,
      query: live.query,
      startedAt: live.startedAt,
      completedAt: settled ? live.completedAt : null,
    };
  }
  const disk = await loadResearchFromDisk(id);
  if (!disk) {
    return null;
  }
  return {
    status: typeof disk.status === 'string' ? disk.status : 'done',
    progress: {},
    query: typeof disk.query === 'string' ? disk.query : '',
    startedAt: disk.started_at ?? disk.startedAt ?? null,
    completedAt: disk.completed_at ?? disk.completedAt ?? null,
  };
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getResearchResult(id) {
  const live = tasks.get(id);
  if (live && live.result != null) {
    return {
      result: live.result,
      sources: live.sources,
      rawFindings: live.rawFindings,
      category: live.category,
    };
  }
  const disk = await loadResearchFromDisk(id);
  if (!disk) {
    return null;
  }
  return {
    result: disk.result ?? '',
    sources: Array.isArray(disk.sources) ? disk.sources : [],
    rawFindings: Array.isArray(disk.raw_findings) ? disk.raw_findings : [],
    category: typeof disk.category === 'string' ? disk.category : '',
  };
}

/**
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getResearchDetail(id) {
  const live = tasks.get(id);
  if (live) {
    const settled = !isTerminal(live.status) || live.terminalPersisted === true;
    return {
      id: live.id,
      query: live.query,
      title: resolveResearchTitle(live) || undefined,
      status: settled ? live.status : 'running',
      result: live.result,
      raw_report: live.rawReport,
      sources: live.sources,
      raw_findings: live.rawFindings,
      stats: live.stats,
      category: live.category,
      providerId: live.providerId,
      model: live.model,
      started_at: live.startedAt,
      completed_at: settled ? live.completedAt : null,
      archived: live.archived,
      activity_log: parseActivityLogFromEvents(live.events),
    };
  }
  return loadResearchFromDisk(id);
}

/**
 * Coerce persisted research timestamps to sortable epoch milliseconds.
 * ISO strings (normal on disk) must not be passed through Number() — that yields NaN.
 * @param {unknown} value
 * @returns {number}
 */
function researchTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

/**
 * Best-effort sort key: completed time first, then started time.
 * @param {{ completed_at?: unknown; started_at?: unknown }} row
 * @returns {number}
 */
function researchListSortTime(row) {
  const completed = researchTimestampMs(row.completed_at);
  if (completed > 0) {
    return completed;
  }
  return researchTimestampMs(row.started_at);
}

/**
 * In-memory runs still executing (not yet persisted to disk).
 * @returns {object[]}
 */
export function listInMemoryRunningResearch() {
  /** @type {object[]} */
  const items = [];
  for (const state of tasks.values()) {
    if ((state.status !== 'running' && state.terminalPersisted === true) || state.archived) {
      continue;
    }
    const sources = Array.isArray(state.sources) ? state.sources : [];
    const stats =
      state.stats && typeof state.stats === 'object'
        ? /** @type {Record<string, unknown>} */ (state.stats)
        : {};
    items.push({
      id: state.id,
      query: state.query,
      category: typeof state.category === 'string' ? state.category : '',
      source_count: sources.length,
      status: 'running',
      duration: '',
      rounds: stats.Rounds ?? '',
      started_at: state.startedAt,
      completed_at: null,
      archived: false,
    });
  }
  return items;
}

/**
 * @param {{ search?: string; sort?: string; limit?: number; archived?: boolean }} [opts]
 * @returns {Promise<{ research: object[]; total: number }>}
 */
export async function listResearchLibrary(opts = {}) {
  await ensureResearchDataDir();
  const dir = getResearchDataDir();
  const search = typeof opts.search === 'string' ? opts.search.toLowerCase() : '';
  const sort = typeof opts.sort === 'string' ? opts.sort : 'recent';
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 50)));
  const archived = opts.archived === true;

  /** @type {object[]} */
  const items = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { research: [], total: 0 };
  }

  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) {
      continue;
    }
    const stem = ent.name.slice(0, -5);
    if (!isResearchId(stem)) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(dir, ent.name), 'utf8');
      const d = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
      if (Boolean(d.archived) !== archived) {
        continue;
      }
      const q = typeof d.query === 'string' ? d.query : '';
      const storedTitle = typeof d.title === 'string' ? d.title.trim() : '';
      const backfillTitle =
        storedTitle ||
        (typeof d.result === 'string' && d.result.trim()
          ? extractReportTitle(d.result, q).title
          : '');
      const title =
        typeof backfillTitle === 'string' ? backfillTitle.trim() : '';
      const searchHaystack = `${title} ${q}`.toLowerCase();
      if (search && !searchHaystack.includes(search)) {
        continue;
      }
      const sources = Array.isArray(d.sources) ? d.sources : [];
      const stats =
        d.stats && typeof d.stats === 'object'
          ? /** @type {Record<string, unknown>} */ (d.stats)
          : {};
      items.push({
        id: stem,
        query: q,
        title: title || undefined,
        category: typeof d.category === 'string' ? d.category : '',
        source_count: sources.length,
        status: typeof d.status === 'string' ? d.status : 'done',
        duration: stats.Duration ?? '',
        rounds: stats.Rounds ?? '',
        started_at: d.started_at ?? d.startedAt ?? 0,
        completed_at: d.completed_at ?? d.completedAt ?? 0,
        archived: Boolean(d.archived),
      });
    } catch {
      continue;
    }
  }

  if (!archived) {
    for (const live of listInMemoryRunningResearch()) {
      const q = typeof live.query === 'string' ? live.query : '';
      if (search && !q.toLowerCase().includes(search)) {
        continue;
      }
      if (!items.some((row) => row.id === live.id)) {
        items.push(live);
      }
    }
  }

  if (sort === 'recent') {
    items.sort((a, b) => researchListSortTime(b) - researchListSortTime(a));
  } else if (sort === 'oldest') {
    items.sort((a, b) => researchListSortTime(a) - researchListSortTime(b));
  } else if (sort === 'most-messages') {
    items.sort((a, b) => Number(b.source_count || 0) - Number(a.source_count || 0));
  } else if (sort === 'alpha') {
    items.sort((a, b) => String(a.query).localeCompare(String(b.query)));
  }

  return { research: items.slice(0, limit), total: items.length };
}

/**
 * @param {string} id
 * @param {boolean} archived
 * @returns {Promise<boolean>}
 */
export async function setResearchArchived(id, archived) {
  if (!isResearchId(id)) {
    return false;
  }
  const live = tasks.get(id);
  if (live) {
    live.archived = archived;
    await queueResearchPersist(live);
    return true;
  }
  const disk = await loadResearchFromDisk(id);
  if (!disk) {
    return false;
  }
  disk.archived = archived;
  await fs.writeFile(getResearchFilePath(id), JSON.stringify(disk, null, 2), 'utf8');
  return true;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteResearch(id) {
  if (!isResearchId(id)) {
    return false;
  }
  const live = tasks.get(id);
  if (live?.runPromise) {
    if (!isTerminal(live.status)) cancelResearch(id);
    await live.runPromise;
  }
  tasks.delete(id);
  try {
    await fs.unlink(getResearchFilePath(id));
    return true;
  } catch {
    return false;
  }
}
