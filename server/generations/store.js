import { randomUUID } from 'node:crypto';
import { fireAndForget } from '../webhooks/emit.js';
import {
  GENERATION_REPLAY_BYTES, GENERATION_REQUEST_BYTES, GENERATIONS_TOTAL_BYTES, GENERATIONS_MAX_COUNT,
  SUBSCRIBER_BACKLOG_BYTES, SUBSCRIBER_STALL_MS, SUBSCRIBERS_MAX_COUNT, CHUNK_OVERHEAD_BYTES, GENERATION_OVERHEAD_BYTES,
  REPLAY_LIMIT_MESSAGE,
} from './memory-limits.js';
import {
  checkpointAppend,
  checkpointCreated,
  checkpointFinalize,
  flushAllCheckpoints,
  readCheckpoint,
} from './checkpoint.js';

/** @typedef {'pending' | 'streaming' | 'complete' | 'error' | 'cancelled'} GenerationStatus */

/** @typedef {import('http').ServerResponse} ServerResponse */

/**
 * @typedef {object} FallbackCandidate
 * @property {string} providerId
 * @property {string} modelId
 */

/**
 * @typedef {object} LocalSubscriber
 * @property {(buf: Buffer) => void} onChunk
 * @property {(payload: ReturnType<typeof terminalEventPayload>) => void} onEnd
 */

/**
 * @typedef {object} GenerationState
 * @property {string} id
 * @property {string} providerId
 * @property {Buffer} requestBody
 * @property {Buffer[]} chunks
 * @property {number} totalBytes
 * @property {GenerationStatus} status
 * @property {AbortController | null} upstreamController
 * @property {Set<ServerResponse>} subscribers
 * @property {Set<LocalSubscriber>} localSubscribers
 * @property {ReturnType<typeof setTimeout> | null} evictTimer
 * @property {boolean} persist
 * @property {string} startedAt
 * @property {string | null} finishedAt
 * @property {string | null} errorMessage
 * @property {FallbackCandidate[]} candidates
 * @property {number} activeCandidateIndex
 * @property {boolean} failoverDisabled
 * @property {boolean} fallbackUsed
 * @property {boolean} [quotaExceeded] provider refused because the allowance is spent
 * @property {string} chosenProviderId
 * @property {string} chosenModelId
 * @property {string | null} fallbackRole
 * @property {string | null} chatId
 * @property {boolean} [routerPreferAvailable]
 */

const EVICT_MS_EPHEMERAL = 30_000;
const EVICT_MS_PERSIST = 5 * 60_000;

/** @type {Map<string, GenerationState>} */
const generations = new Map();
let retainedBytes = 0;
const generationCosts = new WeakMap();

function releaseRequestBody(state) {
  const bytes = state.requestBody.length;
  state.requestBody = Buffer.alloc(0);
  if (!generationCosts.has(state)) return;
  generationCosts.set(state, generationCosts.get(state) - bytes);
  retainedBytes -= bytes;
}

function releaseGeneration(state) {
  if (generations.get(state.id) !== state) return;
  retainedBytes -= generationCosts.get(state) ?? 0;
  generationCosts.delete(state);
  generations.delete(state.id);
  state.requestBody = Buffer.alloc(0);
  state.chunks = [];
  state.totalBytes = 0;
}

/** Diagnostics report conservative buffer plus state/chunk accounting. */
export function generationMemoryUsage() {
  let subscriberBytes = 0;
  for (const res of openResponses.keys()) {
    subscriberBytes += (subscriberWrites.get(res)?.queuedBytes ?? 0) + (res.writableLength ?? 0);
  }
  return { retainedBytes, generationCount: generations.size, subscriberBytes, subscriberCount: openResponses.size };
}

/**
 * @typedef {{ queue: Buffer[], queuedBytes: number, draining: boolean, replayEnd?: number, replayChunk?: number, replayOffset?: number, endAfterFlush?: boolean, timer?: ReturnType<typeof setTimeout>, onDrain?: () => void, onClose?: () => void }} SubscriberWriteState
 */

/** @type {WeakMap<ServerResponse, SubscriberWriteState>} */
const subscriberWrites = new WeakMap();
const openResponses = new Map();

// ── SSE write ────────────────────────────────────────────────────────────────

/**
 * @param {ServerResponse} res
 * @returns {SubscriberWriteState}
 */
function getWriteState(res) {
  let w = subscriberWrites.get(res);
  if (!w) {
    w = { queue: [], queuedBytes: 0, draining: false };
    subscriberWrites.set(res, w);
  }
  return w;
}

/**
 * @param {GenerationStatus} status
 * @returns {boolean}
 */
function isTerminal(status) {
  return status === 'complete' || status === 'error' || status === 'cancelled';
}

/**
 * @param {GenerationState} state
 * @returns {object}
 */
function terminalEventPayload(state) {
  const payload = { status: state.status };
  if (state.errorMessage) {
    payload.errorMessage = state.errorMessage;
  }
  if (state.quotaExceeded) {
    payload.quotaExceeded = true;
  }
  if (state.fallbackUsed) {
    payload.fallbackUsed = true;
    payload.chosenProviderId = state.chosenProviderId;
    payload.chosenModelId = state.chosenModelId;
  }
  return payload;
}

/**
 * @param {ServerResponse} res
 * @returns {boolean}
 */
function canWriteToSubscriber(res) {
  return !res.writableEnded && !res.destroyed;
}

/**
 * @param {GenerationState} state
 * @param {ServerResponse} res
 * @param {Buffer} buf
 */
function detachSubscriber(state, res) {
  state.subscribers.delete(res);
  clearWriteState(res);
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.destroy();
    } catch {
    }
  }
}

function clearWriteState(res) {
  const w = subscriberWrites.get(res);
  if (w?.timer) clearTimeout(w.timer);
  if (w?.onDrain) res.removeListener?.('drain', w.onDrain);
  if (w?.onClose) res.removeListener?.('close', w.onClose);
  if (w) { w.queue = []; w.queuedBytes = 0; }
  subscriberWrites.delete(res);
  openResponses.delete(res);
}

function queueBuffer(state, res, buf) {
  const w = getWriteState(res);
  const cost = buf.length + CHUNK_OVERHEAD_BYTES;
  if (w.queuedBytes + cost + (res.writableLength ?? 0) > SUBSCRIBER_BACKLOG_BYTES) {
    detachSubscriber(state, res);
    return false;
  }
  if (!w.onClose) {
    w.onClose = () => detachSubscriber(state, res);
    res.once('close', w.onClose);
  }
  w.queue.push(buf);
  w.queuedBytes += cost;
  return true;
}

/**
 * @param {GenerationState} state
 * @param {ServerResponse} res
 * @param {{ terminal?: boolean }} [opts]
 */
function flushSubscriberQueue(state, res, opts = {}) {
  if (!canWriteToSubscriber(res)) {
    if (!opts.terminal) {
      detachSubscriber(state, res);
    } else {
      clearWriteState(res);
    }
    return;
  }

  const w = getWriteState(res);
  if (w.draining) return;
  const requireSubscriber = !opts.terminal;

  while ((w.replayChunk ?? 0) < (w.replayEnd ?? 0) || w.queue.length > 0) {
    if (requireSubscriber && !state.subscribers.has(res)) {
      clearWriteState(res);
      return;
    }

    let buf;
    if ((w.replayChunk ?? 0) < (w.replayEnd ?? 0)) {
      // Replay already belongs to the generation RAM budget. Read it lazily,
      // rather than duplicating the whole reply into the live subscriber queue.
      const chunk = state.chunks[w.replayChunk];
      const offset = w.replayOffset ?? 0;
      buf = chunk.subarray(offset, offset + 64 * 1024);
      w.replayOffset = offset + buf.length;
      if (w.replayOffset >= chunk.length) {
        w.replayChunk += 1;
        w.replayOffset = 0;
      }
    } else {
      buf = w.queue.shift();
      w.queuedBytes -= buf.length + CHUNK_OVERHEAD_BYTES;
    }
    try {
      const ok = res.write(buf);
      if (!ok) {
        if (!w.draining) {
          w.draining = true;
          w.timer = setTimeout(() => detachSubscriber(state, res), SUBSCRIBER_STALL_MS);
          w.timer.unref?.();
          w.onDrain = () => {
            clearTimeout(w.timer);
            w.timer = undefined;
            w.onDrain = undefined;
            w.draining = false;
            flushSubscriberQueue(state, res, w.endAfterFlush ? { terminal: true } : {});
          };
          res.once('drain', w.onDrain);
        }
        return;
      }
    } catch {
      detachSubscriber(state, res);
      return;
    }
  }

  if (w.endAfterFlush) {
    clearWriteState(res);
    try {
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch {
      try {
        res.destroy();
      } catch {
      }
    }
  }
}

/**
 * @param {GenerationState} state
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
  if (!queueBuffer(state, res, buf)) return;
  flushSubscriberQueue(state, res);
}

function writeToSubscriber(state, res, buf) {
  // Rehydrated checkpoints may be one large buffer; writes stay below the socket backlog cap.
  for (let offset = 0; offset < buf.length && state.subscribers.has(res); offset += 64 * 1024) {
    enqueueToSubscriber(state, res, buf.subarray(offset, offset + 64 * 1024));
  }
}

/**
 * @param {GenerationState} state
 */
function broadcastTerminalEvent(state) {
  // Replay needs only output. Keeping each tool round's full input until eviction
  // lets completed history exhaust the shared budget and block unrelated chats.
  releaseRequestBody(state);
  const line = `\n\nevent: end\ndata: ${JSON.stringify(terminalEventPayload(state))}\n\n`;
  const buf = Buffer.from(line, 'utf8');
  for (const res of [...state.subscribers]) {
    state.subscribers.delete(res);
    try {
      if (canWriteToSubscriber(res)) {
        const w = getWriteState(res);
        if (!queueBuffer(state, res, buf)) continue;
        w.endAfterFlush = true;
        flushSubscriberQueue(state, res, { terminal: true });
      } else {
        detachSubscriber(state, res);
      }
    } catch {
      detachSubscriber(state, res);
    }
  }
  state.subscribers.clear();
  broadcastLocalTerminal(state);
}

/**
 * @param {GenerationState} state
 */
function scheduleEviction(state) {
  if (state.evictTimer) {
    clearTimeout(state.evictTimer);
  }
  const delay = state.persist ? EVICT_MS_PERSIST : EVICT_MS_EPHEMERAL;
  state.evictTimer = setTimeout(() => {
    // A replay cursor still reads these buffers while its socket drains.
    // Stall timers and the subscriber cap keep this retention bounded.
    if ([...openResponses.values()].includes(state)) {
      scheduleEviction(state);
      return;
    }
    releaseGeneration(state);
  }, delay);
}

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * @param {{ providerId: string, body: unknown, persist?: boolean, candidates?: FallbackCandidate[], fallbackRole?: string | null, chatId?: string | null, }} params
 * @returns {GenerationState}
 */
export function createGenerationState({
  providerId,
  body,
  persist = false,
  candidates,
  fallbackRole = null,
  chatId = null,
}) {
  const id = randomUUID();
  const requestBody = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const cost = requestBody.length + GENERATION_OVERHEAD_BYTES;
  if (requestBody.length > GENERATION_REQUEST_BYTES || retainedBytes + cost > GENERATIONS_TOTAL_BYTES
    || generations.size >= GENERATIONS_MAX_COUNT) {
    throw Object.assign(new Error('Generation request exceeds the host memory budget. Retry after other replies finish.'), {
      code: 'GENERATION_MEMORY_LIMIT', statusCode: requestBody.length > GENERATION_REQUEST_BYTES ? 413 : 503,
    });
  }
  const parsedBody = body && typeof body === 'object' ? /** @type {{ model?: string }} */ (body) : {};
  const primaryModelId = typeof parsedBody.model === 'string' ? parsedBody.model : '';
  const chain =
    Array.isArray(candidates) && candidates.length > 0
      ? candidates
      : [{ providerId, modelId: primaryModelId }];
  const first = chain[0];
  /** @type {GenerationState} */
  const state = {
    id,
    providerId,
    requestBody,
    chunks: [],
    totalBytes: 0,
    status: 'pending',
    upstreamController: null,
    subscribers: new Set(),
    localSubscribers: new Set(),
    evictTimer: null,
    persist: persist === true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
    quotaExceeded: false,
    candidates: chain,
    activeCandidateIndex: 0,
    failoverDisabled: false,
    fallbackUsed: false,
    chosenProviderId: first.providerId,
    chosenModelId: first.modelId,
    fallbackRole: typeof fallbackRole === 'string' ? fallbackRole : null,
    chatId: typeof chatId === 'string' && chatId.trim() ? chatId.trim() : null,
  };
  generations.set(id, state);
  generationCosts.set(state, cost);
  retainedBytes += cost;
  checkpointCreated(state);
  return state;
}

/**
 * @param {string} id
 * @returns {GenerationState | undefined}
 */
export function getGenerationState(id) {
  return generations.get(id) ?? rehydrateFromCheckpoint(id);
}

/**
 * @returns {import('./store.js').GenerationState[]}
 */
export function listGenerationStates() {
  return [...generations.values()];
}

/**
 * @param {string} id
 * @returns {GenerationState | undefined}
 */
function rehydrateFromCheckpoint(id) {
  if (generations.size >= GENERATIONS_MAX_COUNT || retainedBytes + GENERATION_OVERHEAD_BYTES > GENERATIONS_TOTAL_BYTES) {
    throw Object.assign(new Error('Saved reply cannot be loaded while the generation memory budget is full. Retry after other replies finish.'), {
      code: 'GENERATION_MEMORY_LIMIT', statusCode: 503,
    });
  }
  const available = Math.min(GENERATION_REPLAY_BYTES - CHUNK_OVERHEAD_BYTES, GENERATIONS_TOTAL_BYTES - retainedBytes - GENERATION_OVERHEAD_BYTES - CHUNK_OVERHEAD_BYTES);
  const saved = readCheckpoint(id, Math.max(0, available));
  if (!saved) return undefined;
  const meta = saved.meta ?? {};
  const chunks = saved.sse.length > 0 ? [saved.sse] : [];
  /** @type {GenerationState} */
  const state = {
    id,
    providerId: typeof meta.providerId === 'string' ? meta.providerId : '',
    requestBody: Buffer.alloc(0),
    chunks,
    totalBytes: saved.sse.length,
    status: saved.status,
    upstreamController: null,
    subscribers: new Set(),
    localSubscribers: new Set(),
    evictTimer: null,
    persist: false,
    startedAt: typeof meta.startedAt === 'string' ? meta.startedAt : new Date().toISOString(),
    finishedAt: typeof meta.finishedAt === 'string' ? meta.finishedAt : null,
    errorMessage: typeof meta.errorMessage === 'string' ? meta.errorMessage : null,
    quotaExceeded: meta.quotaExceeded === true,
    candidates: [],
    activeCandidateIndex: 0,
    failoverDisabled: true,
    fallbackUsed: meta.fallbackUsed === true,
    chosenProviderId: typeof meta.chosenProviderId === 'string' ? meta.chosenProviderId : '',
    chosenModelId: typeof meta.chosenModelId === 'string' ? meta.chosenModelId : '',
    fallbackRole: null,
    chatId: typeof meta.chatId === 'string' ? meta.chatId : null,
  };
  generations.set(id, state);
  const cost = GENERATION_OVERHEAD_BYTES + saved.sse.length + (chunks.length ? CHUNK_OVERHEAD_BYTES : 0);
  generationCosts.set(state, cost);
  retainedBytes += cost;
  scheduleEviction(state);
  return state;
}

/**
 * @param {GenerationState} state
 */
export function markStreaming(state) {
  if (state.status === 'pending') {
    state.status = 'streaming';
  }
}

/**
 * @param {GenerationState} state
 * @param {{ providerId: string, modelId: string, index: number }} selection
 */
export function noteGenerationCandidateChosen(state, selection) {
  state.failoverDisabled = true;
  state.activeCandidateIndex = selection.index;
  state.chosenProviderId = selection.providerId;
  state.chosenModelId = selection.modelId;
  state.fallbackUsed = selection.index > 0;
  state.providerId = selection.providerId;
}

/**
 * @param {GenerationState} state
 * @param {Buffer} buf
 */
export function appendChunk(state, buf) {
  if (isTerminal(state.status)) {
    return;
  }
  markStreaming(state);

  const cost = buf.length + CHUNK_OVERHEAD_BYTES;
  const replayCost = state.totalBytes + state.chunks.length * CHUNK_OVERHEAD_BYTES;
  if (replayCost + cost > GENERATION_REPLAY_BYTES || retainedBytes + cost > GENERATIONS_TOTAL_BYTES) {
    markError(state, REPLAY_LIMIT_MESSAGE);
    state.upstreamController?.abort();
    return;
  }
  if (!buf.length) return;
  // A tiny view must not retain its provider's potentially huge backing allocation.
  const owned = Buffer.allocUnsafeSlow(buf.length);
  buf.copy(owned);
  buf = owned;

  state.chunks.push(buf);
  state.totalBytes += buf.length;
  generationCosts.set(state, (generationCosts.get(state) ?? 0) + cost);
  retainedBytes += cost;
  checkpointAppend(state, buf);

  for (const res of [...state.subscribers]) {
    writeToSubscriber(state, res, buf);
  }
  notifyLocalChunk(state, buf);
}

// ── Subscribers ──────────────────────────────────────────────────────────────

/**
 * @param {GenerationState} state
 * @param {ServerResponse} res
 */
export function addSubscriber(state, res) {
  if (openResponses.has(res)) return;
  if (openResponses.size >= SUBSCRIBERS_MAX_COUNT) {
    res.destroy();
    return;
  }
  openResponses.set(res, state);
  const writeState = getWriteState(res);
  writeState.onClose = () => detachSubscriber(state, res);
  res.once('close', writeState.onClose);
  state.subscribers.add(res);

  writeState.replayEnd = state.chunks.length;
  writeState.replayChunk = 0;
  writeState.replayOffset = 0;

  if (isTerminal(state.status)) {
    const line = `\n\nevent: end\ndata: ${JSON.stringify(terminalEventPayload(state))}\n\n`;
    try {
      if (canWriteToSubscriber(res)) {
        const w = getWriteState(res);
        if (!queueBuffer(state, res, Buffer.from(line, 'utf8'))) return;
        w.endAfterFlush = true;
        flushSubscriberQueue(state, res, { terminal: true });
      }
    } catch {
      detachSubscriber(state, res);
    }
    state.subscribers.delete(res);
  } else {
    flushSubscriberQueue(state, res);
  }
}

/**
 * @param {GenerationState} state
 * @param {ServerResponse} res
 */
export function removeSubscriber(state, res) {
  detachSubscriber(state, res);
}

/**
 * @param {GenerationState} state
 * @param {Buffer} buf
 */
function notifyLocalChunk(state, buf) {
  for (const sub of [...state.localSubscribers]) {
    try {
      sub.onChunk(buf);
    } catch {
      state.localSubscribers.delete(sub);
    }
  }
}

/**
 * @param {GenerationState} state
 */
function broadcastLocalTerminal(state) {
  const payload = terminalEventPayload(state);
  for (const sub of [...state.localSubscribers]) {
    state.localSubscribers.delete(sub);
    try {
      sub.onEnd(payload);
    } catch {
    }
  }
}

/**
 * @param {GenerationState} state
 * @param {LocalSubscriber} subscriber
 * @returns {() => void}
 */
export function addLocalSubscriber(state, subscriber) {
  for (const chunk of state.chunks) {
    try {
      subscriber.onChunk(chunk);
    } catch {
      return () => {};
    }
  }

  if (isTerminal(state.status)) {
    try {
      subscriber.onEnd(terminalEventPayload(state));
    } catch {
    }
    return () => {};
  }

  state.localSubscribers.add(subscriber);
  return () => {
    state.localSubscribers.delete(subscriber);
  };
}

/**
 * @param {GenerationState} state
 * @param {LocalSubscriber} subscriber
 */
export function removeLocalSubscriber(state, subscriber) {
  state.localSubscribers.delete(subscriber);
}

// ── Complete ─────────────────────────────────────────────────────────────────

/**
 * @param {GenerationState} state
 */
export function markComplete(state) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'complete';
  state.finishedAt = new Date().toISOString();
  checkpointFinalize(state);
  broadcastTerminalEvent(state);
  fireAndForget('chat.completed', {
    generationId: state.id,
    providerId: state.chosenProviderId || state.providerId,
    modelId: state.chosenModelId,
    status: 'completed',
    chatId: state.chatId,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    fallbackUsed: state.fallbackUsed === true,
  });
  scheduleEviction(state);
}

/**
 * @param {GenerationState} state
 * @param {string} message
 * @param {{ quotaExceeded?: boolean }} [options]
 */
export function markError(state, message, options) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'error';
  state.errorMessage = message;
  if (options?.quotaExceeded) {
    state.quotaExceeded = true;
  }
  state.finishedAt = new Date().toISOString();
  checkpointFinalize(state);
  broadcastTerminalEvent(state);
  scheduleEviction(state);
}

/**
 * @param {GenerationState} state
 */
export function markCancelled(state) {
  if (isTerminal(state.status)) {
    return;
  }
  state.status = 'cancelled';
  state.finishedAt = new Date().toISOString();
  checkpointFinalize(state);
  broadcastTerminalEvent(state);
  scheduleEviction(state);
}

/**
 * @param {GenerationState} state
 */
export function cancel(state) {
  state.upstreamController?.abort();
  markCancelled(state);
}

export const NON_AGENT_FALLBACK_ROLES = new Set(['utility', 'chat-titles', 'goal-eval', 'editor-completion']);

export function hasActiveUserAgentGenerations() {
  for (const state of generations.values()) {
    if (state.status !== 'pending' && state.status !== 'streaming') {
      continue;
    }
    if (state.chatId) {
      return true;
    }
    if (state.persist) {
      return true;
    }
    const role = state.fallbackRole;
    if (role && !NON_AGENT_FALLBACK_ROLES.has(role)) {
      return true;
    }
  }
  return false;
}

export function deleteGenerationsForProviderShutdown() {
  for (const [res, state] of openResponses) detachSubscriber(state, res);
  for (const state of generations.values()) {
    state.upstreamController?.abort();
    if (!isTerminal(state.status)) {
      markCancelled(state);
    }
    if (state.evictTimer) {
      clearTimeout(state.evictTimer);
    }
    for (const res of [...state.subscribers]) detachSubscriber(state, res);
    releaseGeneration(state);
  }
  generations.clear();
  flushAllCheckpoints();
}

