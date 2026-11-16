#!/usr/bin/env node

import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeRuntimeProcess, shouldRestartServer } from './runtime-process-log.mjs';
import { buildChatPreparation } from './build-headless-runner.mjs';

// The server imports plain JS in both checkout and packaged installations.
// Rebuild on each dev startup so it never consumes a stale/missing TS adapter.
await buildChatPreparation();

const server = fileURLToPath(new URL('../server.js', import.meta.url));
const restartEnabled = process.env.MINNOW_SERVER_RESTART !== '0';
const restartTimes = [];
let child;
let log;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    log?.event('signal-received', { signal, pid: child?.pid });
    child?.kill(signal);
  });
}

function start({ restarted = false } = {}) {
  // A restarted server must not open a second shell: the running Electron
  // window reconnects to the same port once the new server is listening.
  const env = restarted ? { ...process.env, BROWSER: 'none' } : process.env;
  const startedAt = Date.now();
  child = spawn(process.execPath, [server, ...process.argv.slice(2)], {
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
    env,
  });
  log = observeRuntimeProcess(child, 'server');
  console.log(`[runtime-log] Server logs: ${log.directory} (${log.runId})`);
  child.once('error', () => { process.exitCode = 1; });
  child.once('close', (code, signal) => {
    const uptimeMs = Date.now() - startedAt;
    if (restartEnabled && shouldRestartServer({ code, signal, stopping, uptimeMs, restartTimes })) {
      restartTimes.push(Date.now());
      log.event('restart', { pid: child.pid, code, signal, uptimeMs, attempt: restartTimes.length });
      console.warn(`[minnow] Server exited unexpectedly (${signal ?? `code ${code}`}); restarting so interrupted chats recover.`);
      start({ restarted: true });
      return;
    }
    process.exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
  });
}

start();
