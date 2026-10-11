import { readMtplxActivity } from './mtplx-activity.js';
const BUSY_INTERVAL_MS = 400;
const IDLE_INTERVAL_MS = 2_500;
const REQUEST_TIMEOUT_MS = 1_500;
const STALE_AFTER_MS = 10_000;

/**
 * @typedef {object} ServeActivitySlot
 * @property {number} id
 * @property {number | null} taskId
 * @property {'idle' | 'prompt' | 'generating'} state
 * @property {number} promptProcessed
 * @property {number} promptCached
 * @property {number} decoded
 * @property {number | null} remaining
 * @property {number | null} tokensPerSecond
 */

/**
 * @typedef {object} ServeActivity
 * @property {string} serveId
 * @property {string} modelLabel
 * @property {string | null} libraryId
 * @property {number} updatedAt
 * @property {boolean} available
 * @property {boolean} stale
 * @property {number} queued
 * @property {ServeActivitySlot[]} slots
 */

/** @type {Map<string, { timer: NodeJS.Timeout | null, stopped: boolean, last: ServeActivity | null, prev: Map<number, { taskId: number | null, decoded: number, at: number }> }>} */
const pollers = new Map();

/** @type {Set<(activity: ServeActivity) => void>} */
const listeners = new Set();

/** @type {typeof fetch} */
let fetchImpl = (...args) => fetch(...args);

export function setServeActivityFetchForTests(fn) {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

export function resetServeActivityFetchForTests() {
  fetchImpl = (...args) => fetch(...args);
}

/**
 * @param {(activity: ServeActivity) => void} listener
 * @returns {() => void}
 */
export function subscribeServeActivity(listener) {
  listeners.add(listener);
  for (const entry of pollers.values()) {
    if (entry.last) {
      try {
        listener(entry.last);
      } catch {
      }
    }
  }
  return () => listeners.delete(listener);
}

/** @param {ServeActivity} activity */
function publish(activity) {
  for (const listener of listeners) {
    try {
      listener(activity);
    } catch {
    }
  }
}

/** @param {unknown} value */
function asInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * @param {unknown} raw
 * @param {Map<number, { taskId: number | null, decoded: number, at: number }>} prev
 * @param {number} now
 * @returns {ServeActivitySlot[]}
 */
export function normalizeSlots(raw, prev, now) {
  if (!Array.isArray(raw)) return [];
  /** @type {ServeActivitySlot[]} */
  const slots = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = asInt(entry.id);
    const busy = entry.is_processing === true;
    const taskId = entry.id_task == null ? null : asInt(entry.id_task);
    const nextToken = Array.isArray(entry.next_token) ? entry.next_token[0] : null;
    const remaining = nextToken && nextToken.n_remain != null ? asInt(nextToken.n_remain) : null;

    const generating = busy && remaining != null && remaining > 0;
    const decoded = generating && nextToken ? asInt(nextToken.n_decoded) : 0;

    const before = prev.get(id);
    let tokensPerSecond = null;
    if (generating && before && before.taskId === taskId && decoded > before.decoded) {
      const deltaMs = now - before.at;
      if (deltaMs > 0) tokensPerSecond = ((decoded - before.decoded) / deltaMs) * 1000;
    }

    slots.push({
      id,
      taskId,
      state: !busy ? 'idle' : generating ? 'generating' : 'prompt',
      promptProcessed: busy ? asInt(entry.n_prompt_tokens_processed) : 0,
      promptCached: busy ? asInt(entry.n_prompt_tokens_cache) : 0,
      decoded,
      remaining: generating ? remaining : null,
      tokensPerSecond,
    });

    prev.set(id, { taskId, decoded, at: now });
  }

  return slots;
}

/**
 * @param {unknown} text
 * @returns {number}
 */
export function parseLlamaCppDeferred(text) {
  if (typeof text !== 'string' || !text) return 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(
      /^llamacpp(?::|_)requests_deferred(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)\b/,
    );
    if (!match) continue;
    const n = Number(match[1]);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  return 0;
}

/**
 * @param {string} baseUrl
 * @returns {Promise<unknown | null>}
 */
async function fetchSlots(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/slots`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} baseUrl
 * @returns {Promise<string | null>}
 */
async function fetchMetricsText(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/metrics`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    if (typeof res.text === 'function') return await res.text();
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ id: string, baseUrl: string, runtime?: string, modelLabel?: string, libraryId?: string }} serve
 */
export function startServeActivity(serve) {
  if (!serve?.id || !serve.baseUrl) return;
  if (serve.runtime && !['llama-cpp', 'mtplx'].includes(serve.runtime)) return;
  if (pollers.has(serve.id)) return;

  const identity = {
    modelLabel: String(serve.modelLabel ?? ''),
    libraryId: serve.libraryId ? String(serve.libraryId) : null,
  };

  const entry = { timer: null, stopped: false, last: null, prev: new Map() };
  pollers.set(serve.id, entry);

  const tick = async () => {
    if (entry.stopped) return;
    if (serve.runtime === 'mtplx') {
      let activity;
      try { activity = await readMtplxActivity(serve, fetchImpl); }
      catch { activity = entry.last ? { ...entry.last, stale: true } : { serveId: serve.id, ...identity, updatedAt: Date.now(), available: false, stale: true, queued: 0, slots: [] }; }
      if (entry.stopped) return;
      entry.last = activity;
      publish(activity);
      entry.timer = setTimeout(() => void tick(), activity.mtplx?.activeRequests > 0 && !activity.stale ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
      entry.timer.unref?.();
      return;
    }
    const [raw, metricsText] = await Promise.all([
      fetchSlots(serve.baseUrl),
      fetchMetricsText(serve.baseUrl),
    ]);
    if (entry.stopped) return;

    const now = Date.now();
    const queued =
      metricsText != null ? parseLlamaCppDeferred(metricsText) : (entry.last?.queued ?? 0);
    let activity;
    if (raw == null) {
      activity = entry.last
        ? { ...entry.last, queued, stale: true }
        : {
            serveId: serve.id,
            ...identity,
            updatedAt: now,
            available: false,
            stale: true,
            queued,
            slots: [],
          };
    } else {
      activity = {
        serveId: serve.id,
        ...identity,
        updatedAt: now,
        available: true,
        stale: false,
        queued,
        slots: normalizeSlots(raw, entry.prev, now),
      };
    }

    entry.last = activity;
    publish(activity);

    const busy =
      activity.queued > 0 || activity.slots.some((slot) => slot.state !== 'idle');
    entry.timer = setTimeout(() => {
      void tick();
    }, busy && !activity.stale ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
    entry.timer.unref?.();
  };

  void tick();
}

export function stopServeActivity(serveId) {
  const entry = pollers.get(serveId);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  pollers.delete(serveId);
}

export function stopAllServeActivity() {
  for (const serveId of [...pollers.keys()]) stopServeActivity(serveId);
}

/**
 * @param {string} serveId
 * @returns {ServeActivity | null}
 */
export function getServeActivity(serveId) {
  const entry = pollers.get(serveId);
  if (!entry?.last) return null;
  const stale = entry.last.stale || Date.now() - entry.last.updatedAt > STALE_AFTER_MS;
  return stale === entry.last.stale ? entry.last : { ...entry.last, stale };
}

export function listServeActivity() {
  const out = [];
  for (const serveId of pollers.keys()) {
    const activity = getServeActivity(serveId);
    if (activity) out.push(activity);
  }
  return out;
}
