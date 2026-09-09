/**
 * Spawns the Brain code indexer in a child Node process (Electron-safe via node-runtime).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMinnowHome } from '../../config/home.js';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { applyNodeRuntimeEnv, getLspNodeExecutable } from '../../lsp/node-runtime.js';
import { buildLspProcessEnv } from '../../lsp/paths.js';
import { reindexCode } from './indexer.js';
import { reportIndexProgress } from './index-progress.js';

const WORKER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index-worker.js');

/**
 * Ceiling for one child reindex.
 *
 * The worker drives a language server per file, and a wedged tsserver produces no output
 * at all — no progress frames, no exit. Without this the promise never settles and every
 * caller above it (cascade, a code tool, an attempt's turn) waits forever.
 */
export const INDEX_WORKER_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Longest gap between worker frames before it counts as wedged.
 *
 * Progress frames arrive per file, so silence this long means the worker stopped making
 * progress rather than merely working on a big repo.
 */
export const INDEX_WORKER_SILENCE_MS = 5 * 60 * 1000;

/**
 * Reassemble newline-delimited JSON from stream chunks.
 *
 * Pipe chunks are not line-aligned. The worker's `done` frame spans several chunks on any
 * real repo, and parsing each chunk on its own dropped every fragment — the reindex then
 * failed with "Index worker closed without a result" after doing all the work.
 * @param {(line: string) => void} onLine
 */
export function createNdjsonFramer(onLine) {
  let residual = '';
  return {
    /** @param {string} chunk */
    push(chunk) {
      residual += chunk;
      const lines = residual.split(/\r?\n/);
      residual = lines.pop() ?? '';
      for (const line of lines) {
        if (line) onLine(line);
      }
    },
    /** Deliver a final unterminated line, if any. */
    flush() {
      const tail = residual;
      residual = '';
      if (tail) onLine(tail);
    },
  };
}

/** Tests and MINNOW_BRAIN_INDEX_IN_PROCESS=1 keep indexing on the main thread. */
export function shouldRunBrainIndexInProcess() {
  return (
    process.env.MINNOW_BRAIN_INDEX_IN_PROCESS === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.MINNOW_TEST === '1'
  );
}

/**
 * Run reindexCode in-process or in a child, depending on environment.
 * @param {Parameters<typeof reindexCode>[0]} opts
 */
export async function runBrainCodeReindex(opts = {}) {
  if (shouldRunBrainIndexInProcess()) {
    return reindexCode(opts);
  }
  return runBrainCodeReindexChild(opts);
}

/**
 * @param {Parameters<typeof reindexCode>[0]} opts
 * @param {{ script?: string, timeoutMs?: number, silenceMs?: number }} [overrides] test seam
 */
export function runBrainCodeReindexChild(opts, overrides = {}) {
  const workspaceRoot = getEffectiveWorkspaceRoot();
  const executable = getLspNodeExecutable();
  const env = applyNodeRuntimeEnv(buildLspProcessEnv(), executable);
  const script = overrides.script ?? WORKER_SCRIPT;
  const hardMs = overrides.timeoutMs ?? INDEX_WORKER_TIMEOUT_MS;
  const silenceMs = overrides.silenceMs ?? INDEX_WORKER_SILENCE_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [script], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    let settled = false;

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let hardTimer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let silenceTimer;

    const clearTimers = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
    };

    /**
     * Reject and kill the whole subtree.
     *
     * The worker spawns a language server, which spawns tsserver — killing only the direct
     * child orphans those, and an orphaned tsserver holds gigabytes and a core indefinitely.
     */
    const abandon = (why) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const pid = child.pid;
      if (process.platform === 'win32' && pid) {
        try {
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          });
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      reject(new Error(`Index worker ${why}`));
    };

    hardTimer = setTimeout(() => abandon(`exceeded ${hardMs}ms`), hardMs);

    const noteActivity = () => {
      if (settled) return;
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(
        () => abandon(`produced no output for ${silenceMs}ms`),
        silenceMs,
      );
    };
    noteActivity();

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      noteActivity();
    });

    /** @param {string} line */
    const handleLine = (line) => {
      if (!line) return;
      noteActivity();
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'progress' && msg.repo) {
        reportIndexProgress(msg.repo, {
          indexing: Boolean(msg.indexing),
          filesDone: Number(msg.filesDone) || 0,
          filesTotal: Number(msg.filesTotal) || 0,
          phase: String(msg.phase ?? 'idle'),
        });
      } else if (msg.type === 'done' && !settled) {
        settled = true;
        clearTimers();
        resolve(msg.result);
      } else if (msg.type === 'error' && !settled) {
        settled = true;
        clearTimers();
        reject(new Error(String(msg.message ?? 'Index worker failed')));
      }
    };

    const framer = createNdjsonFramer(handleLine);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => framer.push(chunk));
    child.stdout?.on('end', () => framer.flush());

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimers();
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (code === 0) {
        reject(new Error('Index worker closed without a result'));
        return;
      }
      reject(new Error(stderr.trim() || `Index worker exited with code ${code}`));
    });

    const payload = {
      workspaceRoot,
      minnowHome: getMinnowHome(),
      opts,
    };
    child.stdin?.write(`${JSON.stringify(payload)}\n`);
    child.stdin?.end();
  });
}
