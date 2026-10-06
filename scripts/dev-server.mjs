#!/usr/bin/env node

import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { observeRuntimeProcess } from './runtime-process-log.mjs';

const server = fileURLToPath(new URL('../server.js', import.meta.url));
const child = spawn(process.execPath, [server, ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});
const log = observeRuntimeProcess(child, 'server');
console.log(`[runtime-log] Server logs: ${log.directory} (${log.runId})`);

const handlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => {
    log.event('signal-received', { signal, pid: child.pid });
    child.kill(signal);
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}
child.once('error', () => { process.exitCode = 1; });
child.once('close', (code, signal) => {
  for (const [name, handler] of handlers) process.off(name, handler);
  process.exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
});
