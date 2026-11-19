import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockSync } from 'proper-lockfile';
import { buildChatPreparation } from './build-headless-runner.mjs';
import { observeRuntimeProcess } from './runtime-process-log.mjs';
import { spawnElectronShell } from './spawn-electron.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const checkout = process.platform === 'win32' ? root.toLowerCase() : root;
const id = createHash('sha256').update(checkout).digest('hex').slice(0, 16);
const profile = path.join(os.homedir(), '.minnow-dev', id);
const env = {
  ...process.env,
  PORT: process.env.PORT || process.env.MINNOW_PORT || '19473',
  MINNOW_HOME: path.join(profile, 'server'),
  MINNOW_DEV_USER_DATA: path.join(profile, 'electron'),
  MINNOW_ELECTRON: process.env.MINNOW_BROWSER === '1' ? '0' : '1',
};
delete env.MINNOW_TOKEN;

let server;
let electron;
let stopping = false;
function stopElectron() {
  if (electron?.connected) electron.send({ type: 'minnow-dev-stop' }, () => {});
}

function stop() {
  if (stopping) return;
  stopping = true;
  // IPC requests a graceful server shutdown even on Windows, where
  // ChildProcess.kill() would skip the server's signal handlers.
  if (server?.connected) server.send({ type: 'minnow-dev-stop' }, () => {});
  stopElectron();
}

async function run() {
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  let release;
  try {
    release = lockSync(profile, { lockfilePath: path.join(profile, 'launch.lock') });
  } catch (err) {
    if (err.code !== 'ELOCKED') throw err;
    throw new Error('This checkout already has an isolated Minnow launch (or one just exited).');
  }
  try {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('disconnect', stop);
    if (process.send) process.on('message', message => {
      if (message?.type === 'minnow-dev-stop') stop();
    });
    console.log(`[minnow:dev] Checkout: ${root}\n[minnow:dev] Profile: ${profile}`);
    await buildChatPreparation();
    if (stopping) return;
    server = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, env, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    });
    const log = observeRuntimeProcess(server, 'server', { env });
    console.log(`[runtime-log] Server logs: ${log.directory} (${log.runId})`);
    const closed = new Promise(resolve => server.once('close', resolve));
    try {
      const ready = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', (code, signal) => reject(new Error(`Dev server exited before readiness (${signal ?? code})`)));
        server.on('message', (message) => {
          if (message?.type === 'minnow-dev-ready') resolve(message);
        });
      });
      if (stopping) return;
      if (env.MINNOW_HEADLESS === '1' || env.BROWSER === 'none' || env.MINNOW_BROWSER === '1') {
        const code = await closed;
        if (!stopping) process.exitCode = code || 1;
        return;
      }
      electron = await spawnElectronShell({
        port: ready.port, devUrl: ready.localUrl, foreground: true, supervised: true, env,
      });
      const shellClosed = new Promise(resolve => electron.once('close', resolve));
      if (stopping) stopElectron();
      const code = await Promise.race([closed.then(() => 1), shellClosed]);
      if (!stopping) process.exitCode = code ?? 1;
      stop();
      await shellClosed;
    } catch (err) {
      if (!stopping) throw err;
    } finally {
      stop();
      await closed;
    }
  } finally {
    release();
    if (process.connected) process.disconnect();
  }
}

run().catch((err) => {
  console.error('[minnow:dev]', err.message);
  process.exitCode = 1;
});
