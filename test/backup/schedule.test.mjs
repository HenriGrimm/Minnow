/**
 * Scheduled snapshots: settings validation, retention, skip-if-unchanged, and a
 * failure that always reaches the notification queue.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { resetBackupJobsForTests } from '../../server/backup/jobs.js';
import {
  BACKUP_NOTIFICATION_JOB_ID,
  listSnapshots,
  runBackupScheduleTick,
  runScheduledSnapshot,
} from '../../server/backup/schedule.js';
import {
  readBackupSettings,
  readSchedulePassphrase,
  toPublicBackupSettings,
  updateBackupSettings,
} from '../../server/backup/settings.js';
import { listUnackedNotifications } from '../../server/scheduler/delivery.js';
import {
  PASSPHRASE,
  cleanupTempDirs,
  makeTempDir,
  readAllEntries,
  readHomeFile,
  seedHome,
  useHome,
  writeHomeFile,
} from './helpers.mjs';

after(cleanupTempDirs);

/** @type {string} */
let home;
/** @type {string} */
let dest;

beforeEach(async () => {
  resetBackupJobsForTests();
  home = await seedHome(await makeTempDir('sched-home'));
  dest = await makeTempDir('sched-dest');
  useHome(home);
});

/** Distinct, increasing clock so snapshot file names never collide. */
function at(minute) {
  return new Date(2026, 9, 1, 3, minute, 0);
}

describe('snapshot settings', () => {
  test('rejects a folder inside the Minnow home', async () => {
    await assert.rejects(
      () => updateBackupSettings({ schedule: { destDir: path.join(home, 'backups') } }),
      /outside the Minnow data folder/,
    );
  });

  test('cannot be enabled without a folder', async () => {
    await assert.rejects(() => updateBackupSettings({ schedule: { enabled: true } }), /Choose a folder/);
    assert.equal((await readBackupSettings()).schedule.enabled, false);
  });

  test('validates frequency, retention and the category list', async () => {
    await assert.rejects(() => updateBackupSettings({ schedule: { frequency: 'hourly' } }), /daily or weekly/);
    await assert.rejects(() => updateBackupSettings({ schedule: { keep: 0 } }), /Keep between/);
    await assert.rejects(() => updateBackupSettings({ categories: ['nonsense'] }), /at least one thing/);
    const saved = await updateBackupSettings({ categories: ['issues', 'chats'], schedule: { keep: 3 } });
    assert.deepEqual(saved.categories, ['chats', 'issues'], 'stored in catalog order');
    assert.equal(saved.schedule.keep, 3);
  });

  test('seals the passphrase and never returns it to the UI', async () => {
    await assert.rejects(
      () => updateBackupSettings({ schedule: { passphrase: 'short' } }),
      /at least 8 characters/,
    );
    const saved = await updateBackupSettings({ schedule: { destDir: dest, passphrase: PASSPHRASE } });
    const onDisk = await readHomeFile(home, 'backup.json');
    assert.equal(onDisk.includes(PASSPHRASE), false);
    assert.equal(await readSchedulePassphrase(), PASSPHRASE);

    const visible = toPublicBackupSettings(saved);
    assert.equal(visible.schedule.hasPassphrase, true);
    assert.equal(JSON.stringify(visible).includes('ciphertext'), false);

    await updateBackupSettings({ schedule: { passphrase: null } });
    assert.equal(await readSchedulePassphrase(), '');
  });
});

describe('scheduled snapshot', () => {
  test('writes a snapshot and keeps only the newest N', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, keep: 2, enabled: true } });

    const names = [];
    for (const minute of [1, 2, 3]) {
      const result = await runScheduledSnapshot({ now: at(minute), force: true });
      assert.equal(result.status, 'ok');
      names.push(path.basename(result.file));
    }
    const kept = (await listSnapshots(dest)).map((file) => path.basename(file));
    assert.deepEqual(kept, [names[2], names[1]]);

    const { state, lastExport } = await readBackupSettings();
    assert.equal(state.lastStatus, 'ok');
    assert.equal(state.failures, 0);
    assert.equal(path.basename(state.lastFile), names[2]);
    assert.equal(lastExport.kind, 'scheduled');
    assert.equal(new Date(state.nextRunAt).getTime(), at(3).getTime() + 24 * 60 * 60 * 1000);
  });

  test('never rotates a manual backup that shares the folder', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, keep: 1, enabled: true } });
    const first = await runScheduledSnapshot({ now: at(1), force: true });
    const manual = path.join(dest, 'minnow-backup-2020-01-01_00-00-00.mnbak');
    await fs.copyFile(first.file, manual);

    await runScheduledSnapshot({ now: at(2), force: true });
    await runScheduledSnapshot({ now: at(3), force: true });
    assert.equal((await listSnapshots(dest)).length, 1);
    await fs.access(manual);
  });

  test('skips when nothing changed, and runs again when something did', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, enabled: true } });
    assert.equal((await runScheduledSnapshot({ now: at(1) })).status, 'ok');
    assert.equal((await runScheduledSnapshot({ now: at(2) })).status, 'skipped');
    assert.equal((await listSnapshots(dest)).length, 1);
    assert.equal((await readBackupSettings()).state.lastStatus, 'skipped');

    await writeHomeFile(home, 'brain/pages/facts/new.md', '# New fact\n');
    assert.equal((await runScheduledSnapshot({ now: at(3) })).status, 'ok');
    assert.equal((await listSnapshots(dest)).length, 2);
  });

  test('an emptied folder gets a fresh snapshot even if nothing changed', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, enabled: true } });
    const first = await runScheduledSnapshot({ now: at(1) });
    await fs.rm(first.file);
    assert.equal((await runScheduledSnapshot({ now: at(2) })).status, 'ok');
  });

  test('with a passphrase the snapshot is encrypted and carries credentials', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, enabled: true, passphrase: PASSPHRASE } });
    const result = await runScheduledSnapshot({ now: at(1) });
    const { header, entries } = await readAllEntries(result.file, PASSPHRASE);
    assert.equal(header.encrypted, true);
    assert.ok(entries.has('.key'));
  });

  test('without one it is plaintext and leaves credentials out', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, enabled: true } });
    const result = await runScheduledSnapshot({ now: at(1) });
    const { header, entries } = await readAllEntries(result.file);
    assert.equal(header.encrypted, false);
    assert.equal(entries.has('.key'), false);
  });

  test('a failure is recorded, retried sooner, and raised in the bell', async () => {
    // A folder that cannot be created: its parent is a file.
    const blocked = path.join(dest, 'not-a-folder');
    await fs.writeFile(blocked, 'x');
    await updateBackupSettings({ schedule: { destDir: path.join(blocked, 'snapshots'), enabled: true } });

    const result = await runScheduledSnapshot({ now: at(1) });
    assert.equal(result.status, 'failed');

    const { state } = await readBackupSettings();
    assert.equal(state.lastStatus, 'failed');
    assert.equal(state.failures, 1);
    assert.ok(state.lastError);
    assert.equal(new Date(state.nextRunAt).getTime(), at(1).getTime() + 60 * 60 * 1000);

    const [notification] = await listUnackedNotifications();
    assert.equal(notification.jobId, BACKUP_NOTIFICATION_JOB_ID);
    assert.equal(notification.label, 'Backup');
    assert.match(notification.message, /Scheduled snapshot failed/);

    // Fixing the folder clears the failure streak.
    await updateBackupSettings({ schedule: { destDir: dest } });
    assert.equal((await runScheduledSnapshot({ now: at(2) })).status, 'ok');
    assert.equal((await readBackupSettings()).state.failures, 0);
  });
});

describe('schedule loop', () => {
  test('does nothing while disabled, during boot grace, or before the next run', async () => {
    assert.deepEqual(await runBackupScheduleTick({ bootGraceMs: 0 }), { started: false, reason: 'disabled' });

    await updateBackupSettings({ schedule: { destDir: dest, enabled: true } }, { now: at(0) });
    assert.equal((await runBackupScheduleTick({ now: at(1) })).reason, 'boot_grace');

    const due = await runBackupScheduleTick({ now: at(1), bootGraceMs: 0 });
    assert.equal(due.started, true);
    await due.done;
    assert.equal((await listSnapshots(dest)).length, 1);

    assert.equal((await runBackupScheduleTick({ now: at(2), bootGraceMs: 0 })).reason, 'not_due');
  });

  test('runs again once the interval has passed', async () => {
    await updateBackupSettings({ schedule: { destDir: dest, enabled: true, frequency: 'weekly' } }, { now: at(0) });
    await (await runBackupScheduleTick({ now: at(1), bootGraceMs: 0 })).done;

    const sixDays = new Date(at(1).getTime() + 6 * 24 * 60 * 60 * 1000);
    assert.equal((await runBackupScheduleTick({ now: sixDays, bootGraceMs: 0 })).reason, 'not_due');

    await writeHomeFile(home, 'brain/pages/facts/week.md', '# A week later\n');
    const eightDays = new Date(at(1).getTime() + 8 * 24 * 60 * 60 * 1000);
    const again = await runBackupScheduleTick({ now: eightDays, bootGraceMs: 0 });
    assert.equal(again.started, true);
    await again.done;
    assert.equal((await listSnapshots(dest)).length, 2);
  });
});
