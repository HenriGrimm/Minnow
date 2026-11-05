/**
 * Rotating `sessions.db` snapshots — the guardrail that replaced the size-capped
 * JSON mirror (see documentation/plans/session-history-loss-on-restart.md).
 *
 * Covers rotation, the restart-loop throttle, discarding a copy that fails
 * `quick_check`, and the corrupt-DB recovery order: quarantine → newest verified
 * snapshot → `state.json.migrated` only when no snapshot is usable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';

import {
  closeSessionsDb,
  deleteSessionsDb,
  getSessionsDb,
  readSessionMeta,
} from '../../server/config/sessions-db.js';
import {
  sessionsDbPath,
  sessionsJsonMigratedPath,
  sessionsSnapshotsDir,
} from '../../server/config/sessions-paths.js';
import { writeWholeSessionState } from '../../server/config/sessions-repo.js';
import {
  listSessionsSnapshots,
  restoreSessionsDbFromNewestSnapshot,
  rotateSessionsSnapshots,
  snapshotSessionsDb,
  snapshotSessionsDbIfDue,
  verifySessionsSnapshot,
} from '../../server/config/sessions-snapshot.js';
import { rmTestHome, setTestHome } from './test-helpers.js';

const ALPHA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BETA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeChat(id, name, history) {
  return {
    id,
    name,
    workspacePath: '',
    modelId: '',
    modeId: 'build',
    history,
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_000_000,
  };
}

function makeState(chats) {
  return {
    version: 6,
    activeId: chats[0]?.id ?? '',
    sidebarCollapsed: false,
    lastActiveChatIdByWorkspace: {},
    lastActiveChatIdByApp: {},
    groups: [],
    chats,
  };
}

const SEEDED = makeState([
  makeChat(ALPHA, 'Alpha', [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]),
  makeChat(BETA, 'Beta', [{ role: 'user', content: 'beta only' }]),
]);

function seed() {
  writeWholeSessionState(SEEDED);
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

/** A snapshot file that rotation will see but nothing ever reads. */
function writeFakeSnapshot(stamp) {
  const dir = sessionsSnapshotsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `sessions-${stamp}.db`);
  fs.writeFileSync(filePath, `placeholder ${stamp}`);
  return filePath;
}

/** Pin an mtime so the throttle window is exact rather than sub-millisecond. */
function touch(filePath, ms) {
  const when = new Date(ms);
  fs.utimesSync(filePath, when, when);
}

/**
 * Damage the `messages` b-tree root while leaving page 1 (sqlite_master) intact,
 * so the store opens and the schema init passes but `quick_check` fails — the
 * shape of corruption `getSessionsDb()` actually has to recover from.
 */
function corruptSessionsDb() {
  closeSessionsDb();
  const base = sessionsDbPath();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${base}${suffix}`, { force: true });

  const probe = new Database(base);
  const pageSize = probe.pragma('page_size', { simple: true });
  const rootPage = probe
    .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get().rootpage;
  probe.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${base}${suffix}`, { force: true });

  const fd = fs.openSync(base, 'r+');
  fs.writeSync(fd, Buffer.alloc(pageSize, 0xee), 0, pageSize, (rootPage - 1) * pageSize);
  fs.closeSync(fd);

  const check = new Database(base);
  const quickCheck = check.pragma('quick_check', { simple: true });
  check.close();
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${base}${suffix}`, { force: true });
  assert.notEqual(quickCheck, 'ok', 'test setup must actually corrupt the store');
}

describe('sessions.db snapshots', () => {
  let homeDir;
  let savedHome;
  let savedStore;

  before(() => {
    savedHome = process.env.MINNOW_HOME;
    savedStore = process.env.MINNOW_SESSIONS_STORE;
    delete process.env.MINNOW_SESSIONS_STORE;
    homeDir = setTestHome(process.env, `minnow-sessions-snapshot-${Date.now()}`);
  });

  after(async () => {
    closeSessionsDb();
    deleteSessionsDb();
    if (savedHome === undefined) delete process.env.MINNOW_HOME;
    else process.env.MINNOW_HOME = savedHome;
    if (savedStore === undefined) delete process.env.MINNOW_SESSIONS_STORE;
    else process.env.MINNOW_SESSIONS_STORE = savedStore;
    await rmTestHome(homeDir);
  });

  beforeEach(() => {
    closeSessionsDb();
    deleteSessionsDb();
    const sessionsDir = path.join(homeDir, 'sessions');
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  test('rotation keeps exactly N snapshots and unlinks the oldest', () => {
    const oldest = writeFakeSnapshot('2000-01-01T00-00-00-000Z');
    const middle = writeFakeSnapshot('2000-01-02T00-00-00-000Z');
    const newer = writeFakeSnapshot('2000-01-03T00-00-00-000Z');
    const newest = writeFakeSnapshot('2000-01-04T00-00-00-000Z');

    const removed = rotateSessionsSnapshots(3);

    assert.deepEqual(removed, [oldest]);
    assert.deepEqual(listSessionsSnapshots(), [newest, newer, middle]);
    assert.equal(fs.existsSync(oldest), false);
  });

  test('a new snapshot rotates the older ones out', async () => {
    seed();
    writeFakeSnapshot('2000-01-01T00-00-00-000Z');
    writeFakeSnapshot('2000-01-02T00-00-00-000Z');

    const result = await snapshotSessionsDb(getSessionsDb(), { force: true, keep: 1 });

    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(listSessionsSnapshots(), [result.file]);
    assert.equal(result.removed.length, 2);
    assert.equal(verifySessionsSnapshot(result.file), true);
  });

  test('throttle skips while a recent snapshot exists', async () => {
    seed();
    const recent = writeFakeSnapshot('2999-01-01T00-00-00-000Z');
    touch(recent, Date.now());

    const skipped = await snapshotSessionsDb(getSessionsDb(), {});
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, 'recent_snapshot');
    assert.deepEqual(listSessionsSnapshots(), [recent]);

    // The same call once the window has passed does write one.
    touch(recent, Date.now() - 24 * 60 * 60 * 1000);
    const taken = await snapshotSessionsDb(getSessionsDb(), {});
    assert.equal(taken.ok, true, taken.reason);
  });

  test('a copy that fails quick_check is discarded, not kept', async () => {
    seed();
    // Stand in for a backup of an already-corrupt store: it produces a file, and
    // that file must never survive as a restore source.
    const badDb = {
      backup: async (dest) => {
        fs.writeFileSync(dest, 'this is not a sqlite database');
      },
    };

    const result = await snapshotSessionsDb(badDb, { force: true });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'quick_check_failed');
    assert.deepEqual(listSessionsSnapshots(), []);
    assert.deepEqual(
      fs.readdirSync(sessionsSnapshotsDir()),
      [],
      'the partial file must be swept too',
    );
  });

  test('the boot hook opens the store itself and skips a profile with no store', async () => {
    // Exactly what bootstrapMinnowRuntime() schedules post-boot.
    assert.deepEqual(await snapshotSessionsDbIfDue(), { ok: false, reason: 'no_db' });

    seed();
    closeSessionsDb();

    process.env.MINNOW_SESSIONS_STORE = 'json';
    assert.deepEqual(await snapshotSessionsDbIfDue(), { ok: false, reason: 'json_store' });
    delete process.env.MINNOW_SESSIONS_STORE;

    const result = await snapshotSessionsDbIfDue();
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(listSessionsSnapshots(), [result.file]);
  });

  test('a damaged header restores the verified snapshot and retains the original', async () => {
    seed();
    const snapshot = await snapshotSessionsDb(getSessionsDb(), { force: true });
    closeSessionsDb();
    const fd = fs.openSync(sessionsDbPath(), 'r+');
    try { fs.writeSync(fd, Buffer.alloc(16, 0xee), 0, 16, 0); } finally { fs.closeSync(fd); }
    const db = getSessionsDb();
    assert.equal(readSessionMeta(db, 'dbRestoredFromSnapshotFile'), path.basename(snapshot.file));
    assert.equal(countRows(db, 'messages'), 3);
    const parked = sessionsDbPath() + '.corrupt-' + readSessionMeta(db, 'dbCorruptQuarantineTs');
    assert.deepEqual(fs.readFileSync(parked).subarray(0, 16), Buffer.alloc(16, 0xee));
  });

  test('an exclusively locked healthy database stays in place', () => {
    seed();
    closeSessionsDb();
    const owner = new Database(sessionsDbPath());
    try {
      owner.pragma('journal_mode = DELETE');
      owner.exec('BEGIN EXCLUSIVE');
      assert.throws(() => getSessionsDb(), { code: 'SQLITE_BUSY' });
    } finally { owner.close(); }
    const opened = getSessionsDb();
    assert.equal(countRows(opened, 'messages'), 3);
    assert.equal(readSessionMeta(opened, 'dbCorruptRecoveredAt'), null);
  });

  test('corrupt sessions.db is quarantined and restored from the newest snapshot', async () => {
    seed();
    const snapshot = await snapshotSessionsDb(getSessionsDb(), { force: true });
    assert.equal(snapshot.ok, true, snapshot.reason);

    corruptSessionsDb();

    const db = getSessionsDb();

    assert.ok(readSessionMeta(db, 'dbCorruptRecoveredAt'), 'corruption must be stamped');
    assert.ok(readSessionMeta(db, 'dbRestoredFromSnapshotAt'), 'restore must be stamped');
    assert.equal(
      readSessionMeta(db, 'dbRestoredFromSnapshotFile'),
      path.basename(snapshot.file),
    );
    assert.equal(countRows(db, 'chats'), 2, 'chats must survive the restore');
    assert.equal(countRows(db, 'messages'), 3, 'messages must survive the restore');

    const quarantined = fs
      .readdirSync(path.dirname(sessionsDbPath()))
      .filter((name) => name.includes('.corrupt-'));
    assert.ok(quarantined.length > 0, 'the corrupt file must be kept, not deleted');
  });

  test('corrupt sessions.db with no snapshot falls back to state.json.migrated', () => {
    seed();
    corruptSessionsDb();
    fs.rmSync(sessionsSnapshotsDir(), { recursive: true, force: true });
    fs.writeFileSync(
      sessionsJsonMigratedPath(),
      JSON.stringify(makeState([makeChat(ALPHA, 'Alpha', [{ role: 'user', content: 'hello' }])])),
      'utf8',
    );

    const db = getSessionsDb();

    assert.equal(readSessionMeta(db, 'dbRestoredFromSnapshotAt'), null);
    assert.ok(readSessionMeta(db, 'jsonImportedAt'), 'the legacy blob must still import');
    assert.equal(countRows(db, 'chats'), 1);
    assert.equal(countRows(db, 'messages'), 1);
  });

  test('restore skips a snapshot that no longer passes quick_check', () => {
    seed();
    closeSessionsDb(); // checkpoint the WAL so the copy below is complete

    const dir = sessionsSnapshotsDir();
    fs.mkdirSync(dir, { recursive: true });
    const good = path.join(dir, 'sessions-2000-01-01T00-00-00-000Z.db');
    fs.copyFileSync(sessionsDbPath(), good);
    const rotten = path.join(dir, 'sessions-2999-01-01T00-00-00-000Z.db');
    fs.writeFileSync(rotten, 'this is not a sqlite database');

    fs.rmSync(sessionsDbPath(), { force: true });

    const restored = restoreSessionsDbFromNewestSnapshot();

    assert.ok(restored, 'the older healthy snapshot must be used');
    assert.equal(restored.file, good);
    assert.equal(countRows(getSessionsDb(), 'messages'), 3);
  });
});
