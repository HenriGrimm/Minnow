/**
 * In-app reminder queue persisted for client polling.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMinnowLayout } from '../config/home.js';
import { schedulerNotificationsPath } from './paths.js';

const MAX_NOTIFICATIONS = 200;

/** Serialize notification writes. */
let writeQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 */
function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readStore() {
  await ensureMinnowLayout();
  const filePath = schedulerNotificationsPath();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: parsed?.version ?? 1,
      notifications: Array.isArray(parsed?.notifications) ? parsed.notifications : [],
    };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { version: 1, notifications: [] };
    }
    throw err;
  }
}

/**
 * @param {{ version: number; notifications: object[] }} store
 */
async function writeStore(store) {
  const filePath = schedulerNotificationsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Queue an in-app reminder after a job finishes.
 * @param {{ jobId: string; label: string; message: string; runId?: string; chatId?: string; workspacePath?: string; status?: string; silent?: boolean }} input
 */
export async function enqueueSchedulerNotification(input) {
  return withWriteLock(async () => {
    const store = await readStore();
    const row = {
      id: randomUUID(),
      jobId: input.jobId,
      label: input.label,
      message: input.message,
      createdAt: new Date().toISOString(),
      acked: false,
      runId: input.runId,
      chatId: input.chatId,
      workspacePath: input.workspacePath,
      status: input.status,
      silent: input.silent,
    };
    store.notifications.unshift(row);
    if (store.notifications.length > MAX_NOTIFICATIONS) {
      store.notifications = store.notifications.slice(0, MAX_NOTIFICATIONS);
    }
    await writeStore(store);
    return row;
  });
}

/** Return notifications that have not been acknowledged yet. */
export async function listUnackedNotifications() {
  const store = await readStore();
  return store.notifications.filter((row) => !row.acked);
}

/** @param {string} id */
export async function ackNotification(id) {
  return withWriteLock(async () => {
    const store = await readStore();
    const index = store.notifications.findIndex((row) => row.id === id);
    if (index < 0) {
      throw new Error('Notification not found');
    }
    store.notifications[index] = {
      ...store.notifications[index],
      acked: true,
    };
    await writeStore(store);
    return store.notifications[index];
  });
}

/**
 * Build a short user-facing summary from a headless run result.
 * @param {{ ok?: boolean; assistantFinal?: string; error?: string | null }} result
 */
export function summarizeRunForNotification(result) {
  if (result?.error) {
    return `Job failed: ${String(result.error).slice(0, 240)}`;
  }
  const text = String(result?.assistantFinal ?? '').trim();
  if (!text) {
    return result?.ok ? 'Job completed with no assistant text.' : 'Job failed.';
  }
  if (text.length <= 280) {
    return text;
  }
  return `${text.slice(0, 277)}…`;
}
