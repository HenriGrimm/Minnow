/**
 * Poll scheduler notifications and surface them via Minnow menubar badges.
 */

import { detectLocalServer } from '../tools/client';
import { isLocalServerAvailable } from '../tools/config';
import type { SchedulerNotification } from './client';

const POLL_INTERVAL_MS = 30_000;

/** Notification ids already delivered this session (dedupe). */
const deliveredIds = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Deliver one notification to the settings app badge and ack on the server. */
async function deliverNotification(
  row: SchedulerNotification,
): Promise<void> {
  if (deliveredIds.has(row.id)) {
    return;
  }
  deliveredIds.add(row.id);

  const { pushNotification } = await import('../notifications/push');
  pushNotification({
    kind: 'scheduler',
    title: 'Scheduler',
    preview: `${row.label}: ${row.message}`,
    appId: 'scheduler',
    dedupeKey: `scheduler:${row.id}`,
  });

  try {
    await fetch(`/api/scheduler/notifications/${encodeURIComponent(row.id)}/ack`, {
      method: 'POST',
    });
  } catch {}
}

/** Single poll pass for unacked scheduler reminders. */
export async function pollSchedulerNotifications(): Promise<void> {
  if (!isLocalServerAvailable()) {
    await detectLocalServer(); // recovery probe — only fires when already marked down
    if (!isLocalServerAvailable()) return;
  }

  try {
    const response = await fetch('/api/scheduler/notifications');
    if (!response.ok) return;
    const payload = (await response.json()) as { notifications?: SchedulerNotification[] };
    const rows = payload.notifications ?? [];
    for (const row of rows) {
      await deliverNotification(row);
    }
  } catch {}
}

/** Start background polling while the SPA is open. */
export function startSchedulerNotificationPoll(): void {
  if (pollTimer) {
    return;
  }

  void pollSchedulerNotifications();
  pollTimer = setInterval(() => {
    void pollSchedulerNotifications();
  }, POLL_INTERVAL_MS);
}

/** Stop polling (tests). */
export function stopSchedulerNotificationPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
