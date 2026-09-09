/** Per-attempt transcripts. */

import fs from 'node:fs/promises';
import path from 'node:path';

import { boardDir } from './journal.js';
import { isHighFrequencyTurnEvent } from '../runner/turn-event.js';

/**
 * Lines kept per attempt.
 */
export const MAX_LINES = 5_000;

/** Bytes kept per line. Tool results can be enormous; the shape is the point. */
const MAX_LINE_BYTES = 8_000;

/**
 * Bytes kept for the fields a person actually reads: a thought, a round's
 * prose, an attempt summary. A long thought is normal — a reasoning model at
 * high effort routinely writes past the tool-payload budget — so clipping these
 * at the same cap cut arguments off mid-sentence and made a working agent look
 * broken. Tool payloads keep the tight cap; prose gets room to be prose.
 */
const MAX_PROSE_BYTES = 64_000;

/** Fields billed against `MAX_PROSE_BYTES` rather than the tool-payload cap. */
const PROSE_KEYS = new Set(['text', 'summary']);

/**
 * Attempts folder under an already-resolved journal directory.
 *
 * @param {string} entryDir
 * @returns {string}
 */
export function attemptsDirFrom(entryDir) {
  return path.join(entryDir, 'attempts');
}

/**
 * @param {string} boardId
 * @returns {string}
 */
export function attemptsDir(boardId) {
  return attemptsDirFrom(boardDir(boardId));
}

/**
 * Attempt ids reach here from HTTP, so they are never interpolated into a path unchecked — the same rule `journal.js` applies to board ids.
 * @param {string} attemptId
 * @returns {string}
 */
function safeAttemptId(attemptId) {
  const id = String(attemptId ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.includes('..')) {
    throw new Error(`invalid attempt id: ${JSON.stringify(attemptId)}`);
  }
  return id;
}

/**
 * @param {string} entryDir
 * @param {string} attemptId
 * @returns {string}
 */
export function transcriptPathFor(entryDir, attemptId) {
  return path.join(attemptsDirFrom(entryDir), `${safeAttemptId(attemptId)}.jsonl`);
}

/**
 * @param {string} boardId
 * @param {string} attemptId
 * @returns {string}
 */
export function transcriptPath(boardId, attemptId) {
  return transcriptPathFor(boardDir(boardId), attemptId);
}

/**
 * Resolve the journal directory for a write/read.
 * @param {string | undefined} id
 * @param {{ entryDir?: string }} [options]
 * @returns {string}
 */
function resolveEntryDir(id, options = {}) {
  if (typeof options.entryDir === 'string' && options.entryDir) return options.entryDir;
  return boardDir(String(id ?? ''));
}

/**
 * Event types whose `text` grows in place rather than arriving in pieces.
 */
const COALESCING_TYPES = new Set(['thinking']);

/**
 * One append queue per file, a line count, and the pending coalesced line.
 * @type {Map<string, { chain: Promise<unknown>, lines: number, capped: boolean,
 *                      pending: { entryDir: string, line: Record<string, unknown> } | null }>}
 */
const writers = new Map();

/**
 * @param {string} key
 * @returns {{ chain: Promise<unknown>, lines: number, capped: boolean,
 *             pending: { entryDir: string, line: Record<string, unknown> } | null }}
 */
function writerFor(key) {
  let entry = writers.get(key);
  if (!entry) {
    entry = { chain: Promise.resolve(), lines: 0, capped: false, pending: null };
    writers.set(key, entry);
  }
  return entry;
}

/**
 * Trim a value down to something worth reading.
 *
 * The marker must not vary with the input's length: a coalescing thought is
 * held by comparing one frame's text against the last, and a marker carrying
 * how much was dropped would differ on every frame, so no two clipped frames
 * would fold together and each one would append its own line.
 *
 * @param {unknown} value
 * @param {number} [limit]
 * @returns {unknown}
 */
function clip(value, limit = MAX_LINE_BYTES) {
  if (typeof value !== 'string') return value;
  return value.length > limit ? `${value.slice(0, limit)}… [clipped]` : value;
}

/**
 * Queue one already-built line for append, counting it against the cap.
 *
 * @param {string} file
 * @param {string} entryDir
 * @param {Record<string, unknown>} line
 * @returns {void}
 */
function appendLine(file, entryDir, line) {
  const writer = writerFor(file);
  if (writer.capped) return;
  writer.lines += 1;
  if (writer.lines > MAX_LINES) {
    writer.capped = true;
    return;
  }
  const text = `${JSON.stringify(line)}\n`;
  writer.chain = writer.chain
    .then(async () => {
      await fs.mkdir(attemptsDirFrom(entryDir), { recursive: true });
      await fs.appendFile(file, text, 'utf8');
    })
    .catch(() => {
    });
}

/**
 * Write out the held coalesced line, if there is one.
 * @param {string} file
 * @returns {void}
 */
function flushPending(file) {
  const writer = writers.get(file);
  const pending = writer?.pending;
  if (!writer || !pending) return;
  writer.pending = null;
  appendLine(file, pending.entryDir, pending.line);
}

/**
 * Record one turn event for an attempt.
 * @param {{ boardId?: string, entryDir?: string, attemptId: string, taskId?: string | null, role?: string,
 *          event: Record<string, unknown> }} entry
 * @returns {void}
 */
export function recordTranscriptEvent(entry) {
  const { attemptId, event } = entry;
  const entryDir =
    typeof entry.entryDir === 'string' && entry.entryDir
      ? entry.entryDir
      : entry.boardId
        ? boardDir(entry.boardId)
        : '';
  if (!entryDir || !attemptId || !event) return;
  const type = typeof event.type === 'string' ? event.type : '';
  if (!type || isHighFrequencyTurnEvent(type)) return;

  /** @type {string} */
  let file;
  try {
    file = transcriptPathFor(entryDir, attemptId);
  } catch {
    return;
  }

  const writer = writerFor(file);
  if (writer.capped) return;

  /** @type {Record<string, unknown>} */
  const line = { ts: Date.now(), type };
  for (const key of [
    'name',
    'text',
    'summary',
    'error',
    'id',
    'content',
    'index',
    'toolCallCount',
    'reasoning',
    'finishReason',
  ]) {
    if (event[key] !== undefined) {
      line[key] = clip(event[key], PROSE_KEYS.has(key) ? MAX_PROSE_BYTES : MAX_LINE_BYTES);
    }
  }
  if (event.arguments !== undefined) line.arguments = clip(event.arguments);
  if (event.result !== undefined) line.result = clip(event.result);
  if (entry.role) line.role = entry.role;

  if (!COALESCING_TYPES.has(type) || typeof line.text !== 'string') {
    flushPending(file);
    appendLine(file, entryDir, line);
    return;
  }

  const held = writer.pending;
  if (held && held.line.type === type && typeof held.line.text === 'string') {
    const previous = /** @type {string} */ (held.line.text);
    const next = /** @type {string} */ (line.text);
    if (next.startsWith(previous)) {
      held.line.text = next;
      return;
    }
    if (previous.startsWith(next)) return;
  }
  flushPending(file);
  writer.pending = { entryDir, line };
}

/**
 * Record how an attempt ended, as the transcript's last line.
 *
 * @param {{ boardId?: string, entryDir?: string, attemptId: string, outcome: string, summary?: string }} end
 * @returns {void}
 */
export function recordTranscriptEnd(end) {
  recordTranscriptEvent({
    boardId: end.boardId,
    entryDir: end.entryDir,
    attemptId: end.attemptId,
    event: {
      type: 'attempt_end',
      name: end.outcome,
      ...(end.summary === undefined ? {} : { summary: end.summary }),
    },
  });
}

/**
 * Wait for everything queued for an attempt to reach disk.
 * @param {string} [id] board id, or unused when `options.entryDir` is set
 * @param {string} [attemptId] all attempts when omitted
 * @param {{ entryDir?: string }} [options]
 * @returns {Promise<void>}
 */
export async function flushTranscripts(id, attemptId, options = {}) {
  if (attemptId) {
    const entryDir = resolveEntryDir(id, options);
    if (!entryDir) return;
    const file = transcriptPathFor(entryDir, attemptId);
    flushPending(file);
    await writers.get(file)?.chain;
    return;
  }
  for (const file of [...writers.keys()]) flushPending(file);
  await Promise.all([...writers.values()].map((w) => w.chain));
}

/**
 * Read one attempt's transcript.
 * @param {string} [id] board id, or unused when `options.entryDir` is set
 * @param {string} attemptId
 * @param {{ limit?: number, entryDir?: string }} [options]
 * @returns {Promise<{ events: Record<string, unknown>[], truncated: boolean, capped: boolean }>}
 */
export async function readTranscript(id, attemptId, options = {}) {
  const entryDir = resolveEntryDir(id, options);
  const file = transcriptPathFor(entryDir, attemptId);
  await writers.get(file)?.chain;
  const pending = writers.get(file)?.pending?.line ?? null;

  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return {
        events: pending ? [{ ...pending }] : [],
        truncated: false,
        capped: false,
      };
    }
    throw err;
  }

  /** @type {Record<string, unknown>[]} */
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
    }
  }

  if (pending) events.push({ ...pending });
  const folded = coalesceEvents(events);

  const limit = Number.isSafeInteger(options.limit) && Number(options.limit) > 0
    ? Number(options.limit)
    : 0;
  const truncated = limit > 0 && folded.length > limit;
  return {
    events: truncated ? folded.slice(-limit) : folded,
    truncated,
    capped: writers.get(file)?.capped ?? false,
  };
}

/**
 * Collapse runs of prefix-extending events of the same coalescing type.
 * @param {readonly Record<string, unknown>[]} events
 * @returns {Record<string, unknown>[]}
 */
export function coalesceEvents(events) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const event of events ?? []) {
    const type = typeof event?.type === 'string' ? event.type : '';
    const text = typeof event?.text === 'string' ? event.text : null;
    const last = out[out.length - 1];
    if (
      text !== null &&
      COALESCING_TYPES.has(type) &&
      last &&
      last.type === type &&
      typeof last.text === 'string'
    ) {
      const previous = /** @type {string} */ (last.text);
      if (text.startsWith(previous)) {
        out[out.length - 1] = { ...last, ...event, text };
        continue;
      }
      if (previous.startsWith(text)) continue;
    }
    out.push(event);
  }
  return out;
}

/**
 * Drop the per-process writer state. For tests that move `MINNOW_HOME`.
 *
 * @returns {void}
 */
export function resetTranscripts() {
  writers.clear();
}

/**
 * Delete attempt transcript files after Reset/Rewind has already stopped the agents.
 * Invalid ids (merge attempt ids with `#`) are skipped — they never had a file.
 *
 * @param {string} boardId
 * @param {Iterable<string>} attemptIds
 * @returns {Promise<void>}
 */
export async function deleteAttemptTranscripts(boardId, attemptIds) {
  const entryDir = boardDir(boardId);
  for (const raw of attemptIds) {
    const attemptId = String(raw ?? '');
    if (!attemptId) continue;
    /** @type {string} */
    let file;
    try {
      file = transcriptPathFor(entryDir, attemptId);
    } catch {
      continue;
    }
    const writer = writers.get(file);
    if (writer) {
      flushPending(file);
      await writer.chain;
      writers.delete(file);
    }
    try {
      await fs.unlink(file);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    }
  }
}
