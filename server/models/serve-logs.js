import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getServerLogPath } from '../servers/paths.js';
import { modelsLogDir } from './paths.js';

const POLL_MS = 200;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 512 * 1024;

export const MLX_LM_MANAGED_SERVER_ID = 'mlx-lm';

/**
 * @param {string} runId
 */
export function logPathForRun(runId) {
  return path.join(modelsLogDir(), `${runId}.log`);
}

/**
 * @param {string} runId
 * @param {string} line
 */
export async function appendServeLog(runId, line) {
  if (!runId || typeof runId !== 'string' || !line) return;
  const logPath = logPathForRun(runId);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  const text = line.endsWith('\n') ? line : `${line}\n`;
  await fsp.appendFile(logPath, text, 'utf8');
}

/**
 * @param {{ runId?: string | null, runtime?: string } | null | undefined} serve
 * @returns {string | null}
 */
export function resolveServeLogPath(serve) {
  if (serve?.runId) return logPathForRun(serve.runId);
  if (serve?.runtime === 'mlx-lm') return getServerLogPath(MLX_LM_MANAGED_SERVER_ID);
  return null;
}

/**
 * @param {string} logPath
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, size: number } | null>}
 */
async function readLogFileTail(logPath, maxBytes = DEFAULT_TAIL_BYTES) {
  const bytes = Math.min(Math.max(1024, maxBytes), MAX_TAIL_BYTES);
  let handle;
  try {
    const stat = await fsp.stat(logPath);
    const start = Math.max(0, stat.size - bytes);
    handle = await fsp.open(logPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    await handle.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), size: stat.size, more: false };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * @param {string} logPath
 * @param {number} offset
 * @returns {Promise<{ text: string, size: number, more: boolean, bytes?: Buffer, reset?: boolean } | null>}
 */
async function readLogFileSince(logPath, offset) {
  let handle;
  try {
    const stat = await fsp.stat(logPath);
    const reset = stat.size < offset;
    if (reset) offset = 0;
    if (stat.size === offset) return { text: '', size: stat.size, more: false, reset };
    handle = await fsp.open(logPath, 'r');
    const toRead = Math.min(stat.size - offset, MAX_TAIL_BYTES);
    const buf = Buffer.alloc(toRead);
    await handle.read(buf, 0, buf.length, offset);
    const end = offset + buf.length;
    return { text: buf.toString('utf8'), bytes: buf, reset, size: end, more: end < stat.size };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * @param {string} runId
 * @param {number} [maxBytes]
 * @returns {Promise<{ text: string, size: number } | null>}
 */
export async function readServeLogTail(runId, maxBytes = DEFAULT_TAIL_BYTES) {
  return readLogFileTail(logPathForRun(runId), maxBytes);
}

/**
 * @param {{ runId?: string | null, runtime?: string }} serve
 * @param {number} [maxBytes]
 */
export async function readServeLogTailForServe(serve, maxBytes = DEFAULT_TAIL_BYTES) {
  const logPath = resolveServeLogPath(serve);
  if (!logPath) return null;
  return readLogFileTail(logPath, maxBytes);
}

/**
 * @param {string} runId
 * @param {number} offset
 * @returns {Promise<{ text: string, size: number } | null>}
 */
async function readServeLogSince(runId, offset) {
  return readLogFileSince(logPathForRun(runId), offset);
}

/**
 * @param {string} logPath
 * @param {(event: { text: string, offset: number, initial?: boolean }) => void} onChunk
 * @returns {() => void}
 */
function subscribeLogFile(logPath, onChunk) {
  let offset = 0;
  let stopped = false;
  let timer = null;
  let decoder = new StringDecoder('utf8');

  const tick = async () => {
    if (stopped) return;
    for (;;) {
      const chunk = await readLogFileSince(logPath, offset);
      if (stopped) return;
      if (!chunk) break;
      offset = chunk.size;
      if (chunk.reset) decoder = new StringDecoder('utf8');
      const text = chunk.bytes ? decoder.write(chunk.bytes) : chunk.text;
      if (text || chunk.reset) onChunk({ text, offset, ...(chunk.reset ? { initial: true } : {}) });
      if (!chunk.more) break;
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  // Replay the complete file in bounded chunks, then follow newly appended output.
  void Promise.resolve().then(() => {
    if (stopped) return;
    onChunk({ text: '', offset: 0, initial: true });
    return tick();
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * @param {string} runId
 * @param {(event: { text: string, offset: number, initial?: boolean }) => void} onChunk
 * @returns {() => void}
 */
export function subscribeServeLog(runId, onChunk) {
  return subscribeLogFile(logPathForRun(runId), onChunk);
}

/**
 * @param {{ runId?: string | null, runtime?: string } | (() => { runId?: string | null, runtime?: string } | null | undefined | Promise<{ runId?: string | null, runtime?: string } | null | undefined>)} serveOrLookup
 * @param {(event: { text: string, offset: number, initial?: boolean }) => void} onChunk
 * @returns {() => void}
 */
export function subscribeServeLogForServe(serveOrLookup, onChunk) {
  const lookup =
    typeof serveOrLookup === 'function' ? serveOrLookup : () => serveOrLookup;

  let currentPath = null;
  let innerUnsub = null;
  let stopped = false;
  let timer = null;
  let attaching = false;

  const tick = async () => {
    if (stopped || attaching) return;
    attaching = true;
    try {
      const serve = await Promise.resolve(lookup());
      if (stopped) return;
      const logPath = serve ? resolveServeLogPath(serve) : null;
      if (logPath !== currentPath) {
        innerUnsub?.();
        innerUnsub = null;
        currentPath = logPath;
        if (logPath) innerUnsub = subscribeLogFile(logPath, onChunk);
      }
    } catch {
    } finally {
      attaching = false;
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    innerUnsub?.();
  };
}
