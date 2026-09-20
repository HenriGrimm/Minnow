/**
 * Spawn ripgrep with a wall-clock ceiling, an abort hook, and a hard output ceiling,
 * returning whatever it produced in every one of those cases.
 *
 * `execFile` could not do this job, and both of its failure modes read to an agent as
 * a hang:
 * - `maxBuffer` turns an over-large result into a *rejection*, throwing away the
 *   megabytes of perfectly good matches already collected. The caller reported an
 *   error after ten seconds of real work.
 * - Nothing held a handle to kill the child. When the turn's five-minute backstop
 *   (`server/runner/tool-timeouts.js`) abandoned the call, `rg.exe` kept walking the
 *   disk; the agent retried and spawned another one to compete with it.
 *
 * Callers get `stopped` instead of a throw so they can serve the partial result and
 * tell the model to narrow the search, which is always the useful next move.
 */

import { spawn } from 'node:child_process';

/**
 * Wall-clock ceiling for one ripgrep run.
 *
 * Deliberately far below the turn's `DEFAULT_TOOL_TIMEOUT_MS` backstop, so a search
 * can no longer be the thing that reaches it — see that file's header, which expects
 * every blocking tool to own a tighter limit of its own.
 */
export const RG_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on collected stdout.
 *
 * A backstop against a pathological result set, not a result cap: callers cap their
 * own output far below this (`GREP_MAX_OUTPUT_CHARS`, `FIND_FILES_DEFAULT_MAX`). It
 * sits high enough that `full_result: true` still returns a real full result.
 */
export const RG_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** Enough stderr to carry a ripgrep diagnostic, never enough to matter. */
const RG_MAX_STDERR_CHARS = 4_000;

/**
 * @typedef {null | 'timeout' | 'aborted' | 'overflow'} RipgrepStopReason
 */

/**
 * @typedef {object} RipgrepRunResult
 * @property {string} stdout Everything collected before the process ended or was killed.
 * @property {string} stderr
 * @property {number | null} code Exit code, or null when killed.
 * @property {RipgrepStopReason} stopped Why it was killed, or null when it ended on its own.
 */

/**
 * Run ripgrep to completion, or kill it and return what it produced.
 *
 * @param {string} rgExecutable
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, maxBytes?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<RipgrepRunResult>} Rejects only when the process could not be spawned.
 */
export function runRipgrep(rgExecutable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? RG_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? RG_MAX_STDOUT_BYTES;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(rgExecutable, args, { cwd: options.cwd, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }

    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    /** @type {RipgrepStopReason} */
    let stopped = null;
    let settled = false;

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;

    const onAbort = () => stop('aborted');

    function cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    /** @param {Exclude<RipgrepStopReason, null>} reason */
    function stop(reason) {
      if (stopped || settled) return;
      stopped = reason;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    // `close` fires after both pipes have ended, so a killed child still hands back
    // everything it had written by then.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: stderr.trim(),
        code: typeof code === 'number' ? code : null,
        stopped,
      });
    });

    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= maxBytes) stop('overflow');
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length >= RG_MAX_STDERR_CHARS) return;
      stderr += String(chunk);
    });

    // ripgrep only reads stdin when given no path, which no caller here does — but an
    // open pipe it could block on is not worth keeping for that.
    child.stdin?.end();

    if (timeoutMs > 0) {
      timer = setTimeout(() => stop('timeout'), timeoutMs);
    }

    if (signal) {
      if (signal.aborted) stop('aborted');
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
