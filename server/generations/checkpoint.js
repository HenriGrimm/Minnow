import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

const FLUSH_INTERVAL_MS = 250;

const FLUSH_BYTES = 64 * 1024;

const RETENTION_MS = 24 * 60 * 60 * 1000;

const MAX_DIR_BYTES = 256 * 1024 * 1024;

export const INTERRUPTED_BY_RESTART_MESSAGE =
  'Reply interrupted when the server restarted.';

/**
 * @typedef {object} CheckpointWriter
 * @property {Buffer[]} pending
 * @property {number} pendingBytes
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {boolean} broken
 */

/** @type {Map<string, CheckpointWriter>} */
const writers = new Map();

const ID_RE = /^[0-9a-fA-F-]{36}$/;

function checkpointDir() {
  return path.join(getMinnowHome(), 'generations');
}

function ssePath(id) {
  return path.join(checkpointDir(), `${id}.sse`);
}

function metaPath(id) {
  return path.join(checkpointDir(), `${id}.json`);
}

function isCheckpointableId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function shouldCheckpoint(state) {
  return Boolean(state?.persist) && isCheckpointableId(state?.id);
}

function ensureDir() {
  try {
    fs.mkdirSync(checkpointDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('./store.js').GenerationState} state
 * @returns {object}
 */
function sidecarPayload(state) {
  return {
    id: state.id,
    status: state.status,
    providerId: state.providerId,
    chatId: state.chatId ?? null,
    chosenProviderId: state.chosenProviderId ?? null,
    chosenModelId: state.chosenModelId ?? null,
    fallbackUsed: state.fallbackUsed === true,
    quotaExceeded: state.quotaExceeded === true,
    errorMessage: state.errorMessage ?? null,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null,
  };
}

function writeSidecar(state) {
  if (!ensureDir()) return;
  try {
    fs.writeFileSync(
      metaPath(state.id),
      `${JSON.stringify(sidecarPayload(state), null, 2)}\n`,
      'utf8',
    );
  } catch {
  }
}

/**
 * @param {string} id
 * @returns {CheckpointWriter}
 */
function getWriter(id) {
  let w = writers.get(id);
  if (!w) {
    w = { pending: [], pendingBytes: 0, timer: null, broken: false };
    writers.set(id, w);
  }
  return w;
}

/**
 * @param {string} id
 */
function flushWriter(id) {
  const w = writers.get(id);
  if (!w) return;
  if (w.timer) {
    clearTimeout(w.timer);
    w.timer = null;
  }
  if (w.pending.length === 0 || w.broken) return;
  const buf = Buffer.concat(w.pending, w.pendingBytes);
  w.pending = [];
  w.pendingBytes = 0;
  if (!ensureDir()) {
    w.broken = true;
    return;
  }
  try {
    fs.appendFileSync(ssePath(id), buf);
  } catch {
    w.broken = true;
  }
}

export function checkpointCreated(state) {
  if (!shouldCheckpoint(state)) return;
  writeSidecar(state);
}

/**
 * @param {import('./store.js').GenerationState} state
 * @param {Buffer} buf
 */
export function checkpointAppend(state, buf) {
  if (!shouldCheckpoint(state) || !buf?.length) return;
  const w = getWriter(state.id);
  if (w.broken) return;
  w.pending.push(buf);
  w.pendingBytes += buf.length;
  if (w.pendingBytes >= FLUSH_BYTES) {
    flushWriter(state.id);
    return;
  }
  if (!w.timer) {
    w.timer = setTimeout(() => flushWriter(state.id), FLUSH_INTERVAL_MS);
    w.timer.unref?.();
  }
}

export function checkpointFinalize(state) {
  if (!shouldCheckpoint(state)) return;
  flushWriter(state.id);
  writers.delete(state.id);
  writeSidecar(state);
}

export function flushAllCheckpoints() {
  for (const id of [...writers.keys()]) {
    flushWriter(id);
    writers.delete(id);
  }
}

/**
 * @typedef {object} ReadCheckpoint
 * @property {string} id
 * @property {'complete' | 'error' | 'cancelled'} status
 * @property {Buffer} sse
 * @property {object} meta
 */

/**
 * @param {string} id
 * @returns {ReadCheckpoint | null}
 */
export function readCheckpoint(id) {
  if (!isCheckpointableId(id)) return null;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
  let sse;
  try {
    sse = fs.readFileSync(ssePath(id));
  } catch {
    sse = Buffer.alloc(0);
  }
  const stored = typeof meta?.status === 'string' ? meta.status : '';
  const interrupted = stored !== 'complete' && stored !== 'error' && stored !== 'cancelled';
  if (sse.length === 0 && interrupted) {
    return null;
  }
  return {
    id,
    status: interrupted ? 'error' : stored,
    sse,
    meta: {
      ...meta,
      errorMessage: interrupted
        ? INTERRUPTED_BY_RESTART_MESSAGE
        : (meta?.errorMessage ?? null),
    },
  };
}

export function deleteCheckpoint(id) {
  if (!isCheckpointableId(id)) return;
  for (const file of [ssePath(id), metaPath(id)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
    }
  }
}

/**
 * @returns {{ removed: number, bytesAfter: number }}
 */
export function sweepCheckpoints() {
  const dir = checkpointDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, bytesAfter: 0 };
  }

  /** @type {Map<string, { mtimeMs: number, bytes: number }>} */
  const byId = new Map();
  for (const name of names) {
    const match = name.match(/^(.+)\.(sse|json)$/);
    if (!match || !isCheckpointableId(match[1])) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    const entry = byId.get(match[1]) ?? { mtimeMs: 0, bytes: 0 };
    entry.mtimeMs = Math.max(entry.mtimeMs, stat.mtimeMs);
    entry.bytes += stat.size;
    byId.set(match[1], entry);
  }

  const now = Date.now();
  let removed = 0;
  let total = 0;
  /** @type {Array<{ id: string, mtimeMs: number, bytes: number }>} */
  const kept = [];
  for (const [id, entry] of byId) {
    if (now - entry.mtimeMs > RETENTION_MS) {
      deleteCheckpoint(id);
      removed += 1;
      continue;
    }
    total += entry.bytes;
    kept.push({ id, ...entry });
  }

  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of kept) {
    if (total <= MAX_DIR_BYTES) break;
    deleteCheckpoint(entry.id);
    removed += 1;
    total -= entry.bytes;
  }

  return { removed, bytesAfter: total };
}

export function resetCheckpointWritersForTests() {
  for (const w of writers.values()) {
    if (w.timer) clearTimeout(w.timer);
  }
  writers.clear();
}
