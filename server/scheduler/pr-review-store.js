/** Durable PR Reviewer ledger, one file per repository under scheduler-runs/pr-review/. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { schedulerRunsDir } from './paths.js';
import { renameSchedulerFile } from './atomic-file.js';

export const MAX_LEDGER_ROWS = 300;

export function reviewKey(repository) {
  return createHash('sha256').update(String(repository).toLowerCase()).digest('hex').slice(0, 20);
}

function ledgerPath(repository) {
  return path.join(schedulerRunsDir(), 'pr-review', `${reviewKey(repository)}.json`);
}

export async function readReviewLedger(repository) {
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath(repository), 'utf8'));
    if (ledger.version !== 1 || !Array.isArray(ledger.pulls)) throw new Error('Invalid PR Reviewer ledger');
    return { version: 1, pulls: ledger.pulls, queue: Array.isArray(ledger.queue) ? ledger.queue : [], checkedAt: ledger.checkedAt };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, pulls: [], queue: [], checkedAt: undefined };
    throw error;
  }
}

export async function writeReviewLedger(repository, ledger) {
  const target = ledgerPath(repository);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Oldest settled rows go first; rows still in flight are always kept.
  if (ledger.pulls.length > MAX_LEDGER_ROWS) {
    const active = ledger.pulls.filter((row) => !isSettledPhase(row.phase));
    const settled = ledger.pulls.filter((row) => isSettledPhase(row.phase)).slice(-(MAX_LEDGER_ROWS - active.length));
    ledger.pulls = [...settled, ...active];
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  await renameSchedulerFile(temp, target);
}

export const SETTLED_PHASES = new Set(['queued', 'merged', 'approved', 'commented', 'changes_requested', 'skipped', 'blocked']);

export function isSettledPhase(phase) {
  return SETTLED_PHASES.has(phase);
}

const busy = new Set();

/** One poll per repository at a time inside this Minnow process. */
export async function withReviewLock(repository, work) {
  const key = String(repository).toLowerCase();
  if (busy.has(key)) return { changed: false, summary: 'A review of this repository is already running.' };
  busy.add(key);
  try {
    return await work();
  } finally {
    busy.delete(key);
  }
}
