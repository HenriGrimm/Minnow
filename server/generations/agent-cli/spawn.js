/** Spawn an agent CLI with bounded stdio and deterministic cleanup. */

import { spawn } from 'node:child_process';
import { killProcessTreeAndWait } from '../../terminal-runner.js';

const MAX_STDERR_BYTES = 64 * 1024;

/**
 * @param {{ command: string, args: string[], env?: NodeJS.ProcessEnv, cwd: string, stdin?: string, signal?: AbortSignal }} invocation
 */
export function spawnAgentCli(invocation) {
  if (invocation.signal?.aborted) {
    throw new Error('Agent CLI invocation was cancelled before start');
  }
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let aborting = false;
  const onAbort = () => {
    aborting = true;
    void killProcessTreeAndWait(child, { graceMs: 1500 });
  };
  invocation.signal?.addEventListener('abort', onAbort, { once: true });
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString();
    stderr = `${stderr}${text}`.slice(-MAX_STDERR_BYTES);
  });
  if (typeof invocation.stdin === 'string' && invocation.stdin) child.stdin?.end(invocation.stdin);
  else child.stdin?.end();
  child.stdin?.on('error', () => {});

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stderr, aborted: aborting }));
  }).finally(() => {
    invocation.signal?.removeEventListener('abort', onAbort);
  });
  return {
    child,
    done,
    getStderr: () => stderr,
    stop: (() => {
      let stopPromise = null;
      return () => {
        stopPromise ??= killProcessTreeAndWait(child, { graceMs: 1500 });
        return stopPromise;
      };
    })(),
  };
}

export { MAX_STDERR_BYTES };
