import { spawn } from 'node:child_process';
import {
  PROCESS_MAX_ACCUMULATE_BYTES,
  appendWithByteCap,
  capTextOutput,
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
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      windowsHide: true,
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
      fn();
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
 * Keep only the requested head/tail lines of a stream, noting what was dropped.
 *
 * @param {string} text
 * @param {{ headLines?: number, tailLines?: number }} [slice]
 * @returns {string}
 */
export function sliceStreamLines(text, slice) {
  const headLines = Number(slice?.headLines);
  const tailLines = Number(slice?.tailLines);
  const wantHead = Number.isFinite(headLines) && headLines > 0 ? Math.floor(headLines) : 0;
  const wantTail = Number.isFinite(tailLines) && tailLines > 0 ? Math.floor(tailLines) : 0;
  if (!wantHead && !wantTail) return text;

  const lines = text.split(/\r?\n/);
  if (lines.length <= wantHead + wantTail) return text;

  const head = wantHead ? lines.slice(0, wantHead) : [];
  const tail = wantTail ? lines.slice(lines.length - wantTail) : [];
  const dropped = lines.length - head.length - tail.length;
  return [...head, `[… ${dropped} lines omitted …]`, ...tail].join('\n');
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
