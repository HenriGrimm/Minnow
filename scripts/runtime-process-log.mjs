import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_RUNS = 10;
const RUN_FILE = /^(\d{13}-\d+-[a-f0-9]{8})\.(stdout|stderr|events)\.log(?:\.[12])?$/;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/** Independent of app stores so it can record failures before the server boots. */
export function createRuntimeLog(role, { env = process.env, maxBytes = MAX_BYTES, keepRuns = KEEP_RUNS } = {}) {
  if (!['server', 'electron'].includes(role)) throw new Error(`Unknown runtime role: ${role}`);
  const home = env.MINNOW_HOME?.trim() || env.SPEEDCHAT_HOME?.trim() || path.join(os.homedir(), '.minnow');
  const directory = path.resolve(home, 'logs', 'runtime', role);
  const runId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let failed = false;
  const sizes = new Map();

  function safely(run) {
    if (failed) return;
    try { run(); } catch (error) {
      failed = true;
      console.warn(`[runtime-log] ${role} logging unavailable: ${error.message}`);
    }
  }

  safely(() => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = fs.readdirSync(directory).filter((name) => RUN_FILE.test(name));
    const runs = [...new Set(files.map((name) => name.match(RUN_FILE)[1]))].sort().reverse();
    // Never remove logs belonging to a live supervisor, including another checkout.
    for (const old of runs.slice(Math.max(0, keepRuns - 1))) {
      if (isAlive(Number(old.split('-')[1]))) continue;
      for (const name of files.filter((file) => file.startsWith(`${old}.`))) {
        const target = path.join(directory, name);
        if (fs.lstatSync(target).isFile()) fs.unlinkSync(target);
      }
    }
  });

  function write(stream, chunk) {
    safely(() => {
      const file = path.join(directory, `${runId}.${stream}.log`);
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        let size = sizes.get(stream) ?? 0;
        if (size >= maxBytes) {
          fs.rmSync(`${file}.2`, { force: true });
          if (fs.existsSync(`${file}.1`)) fs.renameSync(`${file}.1`, `${file}.2`);
          fs.renameSync(file, `${file}.1`);
          size = 0;
        }
        const end = Math.min(bytes.length, offset + maxBytes - size);
        // Write before echoing to the terminal: a dying sibling may kill this
        // supervisor as soon as concurrently sees an exit.
        fs.appendFileSync(file, bytes.subarray(offset, end), { mode: 0o600 });
        sizes.set(stream, size + end - offset);
        offset = end;
      }
    });
  }

  function event(kind, details = {}) {
    write('events', `${JSON.stringify({ ts: new Date().toISOString(), role, supervisorPid: process.pid, kind, ...details })}\n`);
  }

  return { directory, runId, write, event };
}

/** Keep native stderr outside the process that may abort before JS handlers run. */
export function observeRuntimeProcess(child, role, { echo = true, ...options } = {}) {
  const log = createRuntimeLog(role, options);
  log.event('launch', { pid: child.pid ?? null });
  child.once('spawn', () => log.event('spawn', { pid: child.pid }));
  child.once('error', (error) => log.event('spawn-error', { code: error.code, message: error.message }));
  for (const stream of ['stdout', 'stderr']) {
    child[stream]?.on('data', (chunk) => log.write(stream, chunk));
    if (echo) child[stream]?.pipe(process[stream], { end: false });
  }
  child.once('exit', (code, signal) => log.event('exit', { pid: child.pid, code, signal }));
  child.once('close', (code, signal) => log.event('close', { pid: child.pid, code, signal }));
  return log;
}
