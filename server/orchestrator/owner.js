/** A process owner prevents two tool servers from resuming the same board. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lockSync } from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import { getMinnowHome } from '../config/home.js';
import { safeSegment } from './journal-store.js';

export async function acquireBoardOwner(boardId) {
  // Run state is excluded from backups; restored checkpoints must not inherit
  // another host's live PID or an abandoned cleanup guard.
  const file = path.join(getMinnowHome(), 'run', 'board-owners', `${safeSegment(boardId)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, token });
  const temporary = `${file}.${token}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  try { for (let attempt = 0; attempt < 32; attempt += 1) {
    try {
      // Hard-link publication is exclusive and atomic: a crash cannot expose
      // an empty claim between create and write. The complete inode is synced.
      fs.linkSync(temporary, file);
      return () => { if (read()?.token === token) fs.unlinkSync(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-owner removal separately from the ownership claim.
      // Re-read under this guard so concurrent reapers cannot unlink a new owner.
      let releaseGuard;
      try {
        releaseGuard = lockSync(file, { realpath: false, lockfilePath: `${file}.reap`, stale: 2000 });
        const owner = read();
        let modified;
        try { modified = fs.statSync(file).mtimeMs; } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const stale = owner?.pid ? !alive(owner.pid) : Date.now() - modified > 60_000;
        if (!stale) throw new Error('This board is already owned by another running engine');
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ELOCKED') throw error;
        // The short-lived cleanup lock is crash recoverable. Wait for its stale
        // threshold without touching a live engine's PID claim.
        await delay(100);
      } finally {
        releaseGuard?.();
      }
    }
  }
  throw new Error('Could not acquire board ownership');
  } finally { fs.rmSync(temporary, { force: true }); }
}
