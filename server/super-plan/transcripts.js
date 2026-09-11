/**
 * Stage transcripts: one append-only file per stage step
 * (`~/.minnow/superplan/<runId>/transcripts/<stage>-<n>.jsonl`). Retries of a
 * step (crash, pause, rejected work) continue the same file, so a resumed
 * attempt picks up the conversation where it stopped.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { runDir } from './journal.js';

const KEY_RE = /^(interview|research|draft|review|polish)-\d{1,4}$/;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isTranscriptKey(key) {
  return KEY_RE.test(String(key ?? ''));
}

/**
 * @param {string} runId
 */
function transcriptsDir(runId) {
  return path.join(runDir(runId), 'transcripts');
}

/**
 * Replay one transcript file into messages and meta. A torn last line (the
 * process died mid-append) is skipped, never repaired on a read.
 * @param {string} file
 * @returns {{ messages: Record<string, unknown>[], meta: Record<string, unknown> }}
 */
function replay(file) {
  /** @type {{ messages: Record<string, unknown>[], meta: Record<string, unknown> }} */
  let record = { messages: [], meta: {} };
  let contents = '';
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return record;
    throw error;
  }
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'reset') record = { messages: [], meta: {} };
      else if (entry.type === 'message' && entry.message && typeof entry.message === 'object') record.messages.push(entry.message);
      else if (entry.type === 'meta' && entry.meta && typeof entry.meta === 'object') Object.assign(record.meta, entry.meta);
    } catch {
      /* torn trailing append */
    }
  }
  return record;
}

/**
 * A `TranscriptStore` (see `server/runner/transcript-store.js`) bound to one
 * step. `chatId` is ignored: every attempt of the step shares the file.
 * @param {string} runId
 * @param {string} key
 */
export function createStepTranscriptStore(runId, key) {
  if (!isTranscriptKey(key)) throw new Error(`invalid transcript key ${JSON.stringify(key)}`);
  const dir = transcriptsDir(runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.jsonl`);
  let record = replay(file);
  // Separate a torn final record from the next append.
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw && !raw.endsWith('\n')) appendFileSync(file, '\n');
  } catch {
    /* no file yet */
  }
  const persist = (entry) => {
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (error) {
      // The run was deleted while a stopped attempt was still unwinding.
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' && !existsSync(runDir(runId))) return;
      throw error;
    }
  };
  return {
    load: () => ({ messages: [...record.messages], meta: { ...record.meta } }),
    /** @param {unknown} _chatId @param {Record<string, unknown>} message */
    append(_chatId, message) {
      persist({ type: 'message', message });
      record.messages.push(message);
    },
    /** @param {unknown} _chatId @param {Record<string, unknown>} meta */
    setMeta(_chatId, meta) {
      persist({ type: 'meta', meta });
      Object.assign(record.meta, meta);
    },
    reset() {
      persist({ type: 'reset' });
      record = { messages: [], meta: {} };
    },
  };
}

/**
 * Messages of one step, without the system prompt.
 * @param {string} runId
 * @param {string} key
 * @returns {Record<string, unknown>[] | null} null when there is no such transcript
 */
export function readStepTranscript(runId, key) {
  if (!isTranscriptKey(key)) return null;
  const file = path.join(transcriptsDir(runId), `${key}.jsonl`);
  const { messages } = replay(file);
  return messages.filter((message) => message.role !== 'system');
}

/**
 * Keys with a transcript on disk, and how many messages each holds.
 * @param {string} runId
 * @returns {Array<{ key: string, messageCount: number }>}
 */
export function listStepTranscripts(runId) {
  let names = [];
  try {
    names = readdirSync(transcriptsDir(runId));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const key = name.slice(0, -'.jsonl'.length);
    if (!isTranscriptKey(key)) continue;
    const { messages } = replay(path.join(transcriptsDir(runId), name));
    out.push({ key, messageCount: messages.filter((m) => m.role !== 'system').length });
  }
  return out;
}

/**
 * Tool calls on the transcript's last assistant turn that never got a result
 * (the process stopped between the call and its answer).
 * @param {Record<string, unknown>[]} messages
 * @returns {Array<{ id: string, name: string, arguments: unknown }>}
 */
export function danglingToolCalls(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') return [];
    if (message.role !== 'assistant') continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) return [];
    const answered = new Set(
      messages
        .slice(i + 1)
        .filter((m) => m.role === 'tool' && typeof m.tool_call_id === 'string')
        .map((m) => m.tool_call_id),
    );
    return calls
      .filter((call) => call && typeof call.id === 'string' && !answered.has(call.id))
      .map((call) => ({ id: call.id, name: String(call.function?.name ?? ''), arguments: call.function?.arguments }));
  }
  return [];
}
