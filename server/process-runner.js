import { spawn } from 'node:child_process';
import { getRequestAbortSignal } from './runtime/request-work.js';
import {
  PROCESS_MAX_ACCUMULATE_BYTES,
  appendWithByteCap,
  capTextOutput,
  sliceStreamLines,
} from './tools/output-cap.js';

export const COMMAND_TIMEOUT_MS = 30_000;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {number} [options.timeout]
 * @param {Record<string, string>} [options.env]
 * @param {boolean} [options.shell]
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} [options.onStdout]
 * @param {(text: string) => void} [options.onStderr]
 * @param {(child: import('node:child_process').ChildProcess) => void} [options.onSpawn]
 * @param {(child: import('node:child_process').ChildProcess) => void} [options.killTree]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean, accumulationTruncated?: boolean }>}
 */
export function runProcess(command, args, options = {}) {
  const {
    cwd,
    timeout = COMMAND_TIMEOUT_MS,
    env,
    shell = false,
    onStdout,
    onStderr,
    onSpawn,
    killTree,
    signal = getRequestAbortSignal(),
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      windowsHide: true,
      detached: Boolean(signal) && process.platform !== 'win32',
    });

    onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let accumulationTruncated = false;
    let settled = false;

    let graceTimer = null;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', abort);
      fn();
    };

    const abort = () => {
      if (killTree) killTree(child);
      else if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('exit', code => { if (code !== 0) child.kill(); });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      settle(() => reject(signal.reason ?? new Error('Request disconnected')));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (killTree) {
        killTree(child);
      } else {
        child.kill('SIGTERM');
      }
      graceTimer = setTimeout(() => {
        settle(() => reject(new Error(`Command timed out after ${timeout / 1000}s`)));
      }, 3000);
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      const capped = appendWithByteCap(stdout, text, PROCESS_MAX_ACCUMULATE_BYTES);
      stdout = capped.text;
      if (capped.truncated) accumulationTruncated = true;
      onStdout?.(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      const capped = appendWithByteCap(stderr, text, PROCESS_MAX_ACCUMULATE_BYTES);
      stderr = capped.text;
      if (capped.truncated) accumulationTruncated = true;
      onStderr?.(text);
    });

    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.on('error', (err) => {
      settle(() => reject(err));
    });

    child.on('close', (code) => {
      if (timedOut) {
        settle(() => reject(new Error(`Command timed out after ${timeout / 1000}s`)));
        return;
      }
      settle(() => resolve({ code: code ?? 1, stdout, stderr, timedOut: false, accumulationTruncated }));
    });
  });
}

/**
 * @param {string} label
 * @param {{ code: number, stdout: string, stderr: string, timedOut?: boolean, stopped?: boolean, timeoutSecs?: number, outputSlice?: { headLines?: number, tailLines?: number } }} result
 */
export function formatProcessOutput(label, {
  code,
  stdout,
  stderr,
  timedOut = false,
  stopped = false,
  timeoutSecs,
  accumulationTruncated = false,
  outputSlice,
}) {
  const parts = [
    stopped
      ? `${label} (stopped by user — process terminated, not a failure)`
      : timedOut
        ? `${label} (timed out after ${timeoutSecs ?? COMMAND_TIMEOUT_MS / 1000}s)`
        : `${label} (exit ${code})`,
  ];

  if (accumulationTruncated) {
    parts.push(
      `(subprocess output exceeded ${PROCESS_MAX_ACCUMULATE_BYTES} bytes and was cut during capture)`,
    );
  }

  const capOptions = {
    middleElide: true,
    footerHint:
      'narrow the command scope, or re-run with tail_lines / max_output_chars, or background it and page read_command_log',
  };
  if (stdout.trim()) {
    const { text } = capTextOutput(sliceStreamLines(stdout.trimEnd(), outputSlice), capOptions);
    parts.push(`stdout:\n${text}`);
  }
  if (stderr.trim()) {
    const { text } = capTextOutput(sliceStreamLines(stderr.trimEnd(), outputSlice), capOptions);
    parts.push(`stderr:\n${text}`);
  }
  if (!stdout.trim() && !stderr.trim()) {
    parts.push('(no output)');
  }
  return parts.join('\n\n');
}
