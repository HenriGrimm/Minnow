import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { schedulerRunsDir } from './paths.js';
import { renameSchedulerFile } from './atomic-file.js';

export function watcherKey(repository) {
  return createHash('sha256').update(repository.toLowerCase()).digest('hex').slice(0, 20);
}

function ledgerPath(repository) {
  return path.join(schedulerRunsDir(), 'github-watch', `${watcherKey(repository)}.json`);
}

export async function readWatchLedger(repository) {
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath(repository), 'utf8'));
    if (ledger.version !== 1 || !Array.isArray(ledger.issues)) throw new Error('Invalid GitHub watcher ledger');
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, issues: [] };
    throw error;
  }
}

export async function writeWatchLedger(repository, ledger) {
  const target = ledgerPath(repository);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  await renameSchedulerFile(temp, target);
}

const busy = new Set();
export async function withWatchLock(repository, work) {
  const key = repository.toLowerCase();
  if (busy.has(key)) return { changed: false, summary: 'Repository watcher is already running.' };
  busy.add(key);
  const lockPath = `${ledgerPath(repository)}.lock`;
  let lock;
  try {
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    try { lock = await fs.open(lockPath, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => ''));
      // An empty lock may still be receiving its owner PID. Never steal it.
      if (!Number.isSafeInteger(pid) || pid <= 0) return { changed: false, summary: 'Repository watcher is locked.' };
      try { process.kill(pid, 0); return { changed: false, summary: 'Repository watcher is already running.' }; }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await fs.unlink(lockPath);
      try { lock = await fs.open(lockPath, 'wx'); } catch (retry) {
        if (retry.code === 'EEXIST') return { changed: false, summary: 'Repository watcher is already running.' };
        throw retry;
      }
    }
    await lock.writeFile(String(process.pid));
    return await work();
  } finally {
    if (lock) { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
    busy.delete(key);
  }
}
