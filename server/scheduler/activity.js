/**
 * Automations activity feed: a small ring buffer of notable events
 * (claims, merges, failures, completed runs) for the hub's Activity column.
 * Stored under scheduler-runs/ so it travels with run history in backups.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { schedulerRunsDir } from './paths.js';
import { renameSchedulerFile } from './atomic-file.js';

const MAX_EVENTS = 200;
const TONES = new Set(['run', 'ok', 'fail', 'warn', 'skip']);

let writeQueue = Promise.resolve();

function activityPath() {
  return path.join(schedulerRunsDir(), 'activity.json');
}

async function readEvents() {
  try {
    const parsed = JSON.parse(await fs.readFile(activityPath(), 'utf8'));
    return Array.isArray(parsed?.events) ? parsed.events : [];
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    // A corrupt feed is not worth failing a run over; start a fresh one.
    return [];
  }
}

/**
 * @param {{ jobId: string; label: string; text: string; tone?: string; runId?: string; ref?: { kind: string; id: string; url?: string } }} input
 */
export function recordActivity(input) {
  const run = writeQueue.then(async () => {
    const events = await readEvents();
    events.unshift({
      id: randomUUID(),
      at: new Date().toISOString(),
      jobId: input.jobId,
      label: String(input.label ?? '').slice(0, 120),
      text: String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
      tone: TONES.has(String(input.tone)) ? input.tone : 'ok',
      runId: input.runId,
      ref: input.ref,
    });
    const target = activityPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, events: events.slice(0, MAX_EVENTS) })}\n`, 'utf8');
    await renameSchedulerFile(tmp, target);
  });
  writeQueue = run.catch((error) => {
    console.warn('[scheduler] activity write failed:', error instanceof Error ? error.message : error);
  });
  return writeQueue;
}

/** Newest first. */
export async function listActivity(limit = 60) {
  await writeQueue;
  return (await readEvents()).slice(0, Math.max(1, Math.min(MAX_EVENTS, limit)));
}

/** Drop a deleted automation's events. */
export function forgetJobActivity(jobId) {
  const run = writeQueue.then(async () => {
    const events = await readEvents();
    const kept = events.filter((event) => event.jobId !== jobId);
    if (kept.length === events.length) return;
    const target = activityPath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, events: kept })}\n`, 'utf8');
    await renameSchedulerFile(tmp, target);
  });
  writeQueue = run.catch(() => {});
  return writeQueue;
}
