/**
 * Scheduler delivery queue and dedupe tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  ackNotification,
  enqueueSchedulerNotification,
  listUnackedNotifications,
  summarizeRunForNotification,
} from '../../server/scheduler/delivery.js';

describe('scheduler delivery', () => {
  /** @type {string} */
  let homeDir;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-scheduler-delivery-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test('queues and acknowledges notifications', async () => {
    const row = await enqueueSchedulerNotification({
      jobId: 'job-1',
      label: 'Nightly',
      message: 'Done',
      runId: 'run-1',
      workspacePath: '/work/minnow',
      status: 'failed',
      silent: true,
    });
    assert.equal(row.acked, false);

    const pending = await listUnackedNotifications();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, row.id);
    assert.equal(pending[0].runId, 'run-1');
    assert.equal(pending[0].workspacePath, '/work/minnow');
    assert.equal(pending[0].status, 'failed');
    assert.equal(pending[0].silent, true);

    await ackNotification(row.id);
    const afterAck = await listUnackedNotifications();
    assert.equal(afterAck.length, 0);
  });

  test('summarizeRunForNotification truncates long assistant text', () => {
    const long = 'x'.repeat(400);
    const summary = summarizeRunForNotification({ ok: true, assistantFinal: long });
    assert.ok(summary.length <= 280);
    assert.ok(summary.endsWith('…'));
  });

  test('summarizeRunForNotification prefers explicit errors', () => {
    const summary = summarizeRunForNotification({ ok: false, error: 'boom' });
    assert.match(summary, /Job failed: boom/);
  });
});
