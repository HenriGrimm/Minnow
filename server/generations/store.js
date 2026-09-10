import { randomUUID } from 'node:crypto';
import { fireAndForget } from '../webhooks/emit.js';
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
 */

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_BYTES_MESSAGE = `The model streamed more than ${MAX_BYTES / (1024 * 1024)} MB without finishing. It is likely looping — check that its tool calls are being parsed, or lower max tokens.`;
const EVICT_MS_EPHEMERAL = 30_000;
const EVICT_MS_PERSIST = 5 * 60_000;

/** @type {Map<string, GenerationState>} */
const generations = new Map();

/**
 * @typedef {{ queue: Buffer[], draining: boolean, endAfterFlush?: boolean }} SubscriberWriteState
 */

/** @type {WeakMap<ServerResponse, SubscriberWriteState>} */
const subscriberWrites = new WeakMap();

// ── SSE write ────────────────────────────────────────────────────────────────

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
  subscriberWrites.delete(res);
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.destroy();
    } catch {
    }
  }
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
            flushSubscriberQueue(state, res, w.endAfterFlush ? { terminal: true } : {});
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
  const w = getWriteState(res);
  w.queue.push(buf);
  flushSubscriberQueue(state, res);
}

function writeToSubscriber(state, res, buf) {
  enqueueToSubscriber(state, res, buf);
}

/**
 * @param {GenerationState} state
 */
function broadcastTerminalEvent(state) {
  const line = `\n\nevent: end\ndata: ${JSON.stringify(terminalEventPayload(state))}\n\n`;
  const buf = Buffer.from(line, 'utf8');
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
      }
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
    generations.delete(state.id);
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
  const saved = readCheckpoint(id);
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

  state.chunks.push(buf);
  state.totalBytes += buf.length;
  checkpointAppend(state, buf);

  for (const res of [...state.subscribers]) {
    writeToSubscriber(state, res, buf);
  }
  notifyLocalChunk(state, buf);

  if (state.totalBytes > MAX_BYTES) {
    state.upstreamController?.abort();
    markError(state, MAX_BYTES_MESSAGE);
  }
}

// ── Subscribers ──────────────────────────────────────────────────────────────

/**
 * @param {GenerationState} state
 * @param {ServerResponse} res
 */
export function addSubscriber(state, res) {
  state.subscribers.add(res);

  for (const chunk of state.chunks) {
    writeToSubscriber(state, res, chunk);
  }

  if (isTerminal(state.status)) {
    const line = `\n\nevent: end\ndata: ${JSON.stringify(terminalEventPayload(state))}\n\n`;
    try {
      if (canWriteToSubscriber(res)) {
        const w = getWriteState(res);
        w.queue.push(Buffer.from(line, 'utf8'));
        w.endAfterFlush = true;
        flushSubscriberQueue(state, res, { terminal: true });
      }
    } catch {
    }
    state.subscribers.delete(res);
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
  for (const state of generations.values()) {
    state.upstreamController?.abort();
    if (!isTerminal(state.status)) {
      markCancelled(state);
    }
    if (state.evictTimer) {
      clearTimeout(state.evictTimer);
    }
  }
  generations.clear();
  flushAllCheckpoints();
}


