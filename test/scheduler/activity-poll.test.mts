import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { pollSchedulerNotifications, stopSchedulerNotificationPoll } from '../../src/scheduler/notifications-poll.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { getNotifications, resetNotificationStoreForTests } from '../../src/notifications/store.ts';
import { resetNotificationPrefsForTests, saveNotificationPref } from '../../src/notifications/prefs.ts';
import { buildActivityFeed } from '../../src/state/activity-feed.ts';

const originalFetch = globalThis.fetch;

test('many running jobs share a poll pass and never fan out into all HTTP connections', async () => {
  let active = 0, maximum = 0, histories = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === '/api/scheduler/notifications') return Response.json({ notifications: [] });
    if (url === '/api/scheduler/jobs') return Response.json({ jobs: Array.from({ length: 12 }, (_, id) => ({
      id: String(id), label: `Job ${id}`, running: true, workspacePath: '/work',
    })) });
    if (url.startsWith('/api/scheduler/runs/')) {
      active++; histories++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return Response.json({ runs: [] });
    }
    return Response.json({});
  };
  const pass = pollSchedulerNotifications();
  for (let i = 0; i < 20; i++) assert.equal(pollSchedulerNotifications(), pass);
  await pass;
  assert.equal(histories, 12);
  assert.equal(maximum, 1);
});
beforeEach(() => {
  const win = new Window();
  Object.assign(globalThis, { window: win, document: win.document, localStorage: win.localStorage });
  resetNotificationStoreForTests(); resetNotificationPrefsForTests();
  setLocalServerAvailableForTests(true);
  saveNotificationPref('muted', true);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  stopSchedulerNotificationPoll();
  setLocalServerAvailableForTests(false);
});

test('muted scheduler polling captures a running job and one correlated terminal outcome', async () => {
  let finished = false;
  const now = new Date().toISOString();
  globalThis.fetch = async (input) => {
    const url = String(input);
    const body = url === '/api/scheduler/jobs' ? { jobs: finished ? [] : [{ id: 'job-activity', label: 'Dependency check', running: true, workspacePath: '/work' }] }
      : url === '/api/scheduler/runs/job-activity' ? { runs: [{ id: 'run-activity', jobId: 'job-activity', startedAt: now, status: 'running' }] }
      : url === '/api/scheduler/notifications' ? { notifications: finished ? [{ id: 'notice-activity', jobId: 'job-activity', label: 'Dependency check', message: 'Provider unavailable', runId: 'run-activity', status: 'failed', workspacePath: '/work', createdAt: now }] : [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const first = pollSchedulerNotifications();
  assert.equal(pollSchedulerNotifications(), first, 'overlapping polls share one request pass');
  await first;
  const snapshot = () => buildActivityFeed({ chats: [], live: [], pendingChatIds: new Set(), notifications: getNotifications(), workspacePath: '/work' });
  assert.equal(snapshot().runningCount, 1);
  finished = true;
  await pollSchedulerNotifications();
  assert.equal(snapshot().runningCount, 0);
  assert.equal(snapshot().attention.length, 1);
  assert.equal(snapshot().attention[0].id, 'scheduler:run-activity');
  await pollSchedulerNotifications();
  assert.equal(snapshot().attention.length, 1);
  assert.equal(getNotifications().length, 1);
});
