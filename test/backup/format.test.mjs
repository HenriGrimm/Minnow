/**
 * The `.mnbak` container: framing boundaries, large files, and every way a
 * damaged, truncated, tampered or hostile archive must be refused.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  BackupFormatError,
  looksLikeBackup,
  readArchive,
  readArchiveHeader,
  writeArchive,
} from '../../server/backup/format.js';
import { stageRestore } from '../../server/backup/restore.js';
import { readPendingRestore } from '../../server/backup/restore-apply.js';
import { FAST_KDF, PASSPHRASE, cleanupTempDirs, homeHas, makeTempDir, readAllEntries } from './helpers.mjs';

after(cleanupTempDirs);

/** @param {Array<{ p: string, data: Buffer, c?: string }>} files */
async function* entriesOf(files) {
  for (const file of files) {
    yield {
      meta: { p: file.p, s: file.data.length, m: 0, c: file.c ?? 'issues' },
      chunks: (async function* chunks() {
        // Odd chunk size so frame and chunk boundaries never line up.
        for (let offset = 0; offset < file.data.length; offset += 50_001) {
          yield file.data.subarray(offset, offset + 50_001);
        }
      })(),
    };
  }
}

const HEADER = {
  app: 'minnow',
  appVersion: '0.1.6',
  createdAt: '2026-10-01T00:00:00.000Z',
  categories: [{ id: 'issues', files: 1, bytes: 1 }],
  roots: [{ path: 'issues', category: 'issues', kind: 'dir', exclude: [] }],
  totals: { files: 1, bytes: 1 },
  includesCredentials: false,
};

async function writeSample(files, passphrase, name = 'sample.mnbak') {
  const out = path.join(await makeTempDir('format'), name);
  await writeArchive({ outPath: out, header: HEADER, passphrase, entries: entriesOf(files), kdf: FAST_KDF });
  return out;
}

describe('container round trip', () => {
  for (const size of [0, 1, 65_535, 65_536, 65_537, 131_072, 3_000_000]) {
    test(`${size}-byte file survives, encrypted and plain`, async () => {
      const data = crypto.randomBytes(size);
      for (const passphrase of [undefined, PASSPHRASE]) {
        const out = await writeSample([{ p: 'issues/blob.bin', data }], passphrase);
        const { entries } = await readAllEntries(out, passphrase);
        assert.ok(entries.get('issues/blob.bin').content.equals(data));
      }
    });
  }

  test('an archive with no files still closes cleanly', async () => {
    const out = await writeSample([], PASSPHRASE);
    const result = await readArchive({ archivePath: out, passphrase: PASSPHRASE, onEntry: async () => {} });
    assert.equal(result.files, 0);
  });

  test('the same content encrypts differently every time', async () => {
    const data = Buffer.from('identical content');
    const a = await fs.readFile(await writeSample([{ p: 'issues/a', data }], PASSPHRASE, 'a.mnbak'));
    const b = await fs.readFile(await writeSample([{ p: 'issues/a', data }], PASSPHRASE, 'b.mnbak'));
    assert.equal(a.equals(b), false);
    assert.equal(a.includes(data), false, 'plaintext must not appear in an encrypted archive');
  });

  test('refuses to overwrite an existing file', async () => {
    const out = await writeSample([{ p: 'issues/a', data: Buffer.from('x') }]);
    await assert.rejects(
      () => writeArchive({ outPath: out, header: HEADER, entries: entriesOf([]) }),
      /EEXIST/,
    );
  });
});

describe('damaged and hostile archives', () => {
  const data = crypto.randomBytes(200_000);

  test('wrong passphrase is reported as such', async () => {
    const out = await writeSample([{ p: 'issues/blob.bin', data }], PASSPHRASE);
    await assert.rejects(
      () => readAllEntries(out, 'wrong passphrase'),
      (err) => err instanceof BackupFormatError && err.code === 'bad_passphrase',
    );
  });

  test('missing passphrase asks for one', async () => {
    const out = await writeSample([{ p: 'issues/blob.bin', data }], PASSPHRASE);
    await assert.rejects(
      () => readAllEntries(out),
      (err) => err instanceof BackupFormatError && err.code === 'passphrase_required',
    );
  });

  test('a flipped byte in the payload fails, encrypted or not', async () => {
    for (const passphrase of [PASSPHRASE, undefined]) {
      const out = await writeSample([{ p: 'issues/blob.bin', data }], passphrase);
      const raw = await fs.readFile(out);
      const { payloadOffset } = await readArchiveHeader(out);
      raw[payloadOffset + Math.floor((raw.length - payloadOffset) / 2)] ^= 0x01;
      await fs.writeFile(out, raw);
      await assert.rejects(() => readAllEntries(out, passphrase), BackupFormatError);
    }
  });

  test('a truncated archive fails, encrypted or not', async () => {
    for (const passphrase of [PASSPHRASE, undefined]) {
      const out = await writeSample([{ p: 'issues/blob.bin', data }], passphrase);
      const raw = await fs.readFile(out);
      await fs.writeFile(out, raw.subarray(0, raw.length - 40_000));
      await assert.rejects(() => readAllEntries(out, passphrase), BackupFormatError);
    }
  });

  test('an edited header fails authentication', async () => {
    const out = await writeSample([{ p: 'issues/blob.bin', data }], PASSPHRASE);
    const raw = await fs.readFile(out);
    const at = raw.indexOf(Buffer.from('"includesCredentials":false'));
    assert.ok(at > 0);
    // Same length, so only the content of the header changes.
    Buffer.from('"includesCredentials":true ').copy(raw, at);
    await fs.writeFile(out, raw);
    await assert.rejects(
      () => readAllEntries(out, PASSPHRASE),
      (err) => err instanceof BackupFormatError,
    );
  });

  test('a file that is not a backup is refused before anything is read', async () => {
    const file = path.join(await makeTempDir('format'), 'notes.mnbak');
    await fs.writeFile(file, 'just some notes');
    assert.equal(await looksLikeBackup(file), false);
    await assert.rejects(
      () => readArchiveHeader(file),
      (err) => err instanceof BackupFormatError && err.code === 'not_a_backup',
    );
  });

  test('absurd scrypt parameters in a header are refused, not attempted', async () => {
    const out = await writeSample([{ p: 'issues/a', data: Buffer.from('x') }], PASSPHRASE);
    const raw = await fs.readFile(out);
    const from = Buffer.from(`"N":${FAST_KDF.N}`);
    const at = raw.indexOf(from);
    assert.ok(at > 0);
    Buffer.from('"N":99999').copy(raw, at);
    await fs.writeFile(out, raw);
    await assert.rejects(() => readArchiveHeader(out), /damaged or unsupported/);
  });
});

describe('staging a hostile archive', () => {
  test('a path that climbs out of the home aborts the restore and stages nothing', async () => {
    for (const evil of ['../escaped.txt', 'issues/../../escaped.txt', '/etc/escaped', 'C:/escaped', 'issues\\..\\x']) {
      const out = await writeSample([{ p: evil, data: Buffer.from('gotcha') }]);
      const home = await makeTempDir('hostile-home');
      await assert.rejects(() => stageRestore({ home, archivePath: out }), /unsafe file path/);
      assert.equal(readPendingRestore(home), null);
      assert.equal(await homeHas(home, 'restore-staging'), false);
      assert.equal(await homeHas(path.dirname(home), 'escaped.txt'), false);
    }
  });

  test('files outside the known roots are skipped, never written', async () => {
    const out = await writeSample([
      { p: 'issues/state.json', data: Buffer.from('{"version":3,"issues":[]}') },
      { p: 'not-a-minnow-folder/payload.js', data: Buffer.from('boom') },
      { p: 'logs/injected.log', data: Buffer.from('boom') },
    ]);
    const home = await makeTempDir('hostile-home');
    const staged = await stageRestore({ home, archivePath: out });
    assert.equal(staged.files, 1);
    assert.ok(staged.warnings.some((warning) => /2 files from a newer Minnow were skipped/.test(warning)));
    const tree = path.join(home, 'restore-staging', staged.id, 'tree');
    assert.deepEqual(await fs.readdir(tree), ['issues']);
  });

  test('a name this system cannot store is skipped with a warning, not fatal', { skip: process.platform !== 'win32' }, async () => {
    const out = await writeSample([
      { p: 'issues/state.json', data: Buffer.from('{"version":3,"issues":[]}') },
      { p: 'issues/attachments/MIN-1/shot: final?.png', data: Buffer.from('png') },
      { p: 'issues/attachments/MIN-1/trailing-dot.', data: Buffer.from('x') },
    ]);
    const home = await makeTempDir('hostile-home');
    const staged = await stageRestore({ home, archivePath: out });
    assert.equal(staged.files, 1);
    assert.ok(staged.warnings.some((warning) => /2 files have names this system cannot store and were skipped/.test(warning)));
  });

  test('the same path twice is damage, not a merge', async () => {
    const out = await writeSample([
      { p: 'issues/state.json', data: Buffer.from('first') },
      { p: 'issues/state.json', data: Buffer.from('second') },
    ]);
    const home = await makeTempDir('hostile-home');
    await assert.rejects(() => stageRestore({ home, archivePath: out }), /EEXIST/);
    assert.equal(await homeHas(home, 'restore-staging'), false);
  });

  test('a corrupt SQLite store inside the archive is caught before it is staged', async () => {
    const out = path.join(await makeTempDir('format'), 'chats.mnbak');
    const broken = Buffer.concat([Buffer.from('SQLite format 3 '), crypto.randomBytes(4096)]);
    await writeArchive({
      outPath: out,
      header: {
        ...HEADER,
        categories: [{ id: 'chats', files: 1, bytes: broken.length }],
        roots: [{ path: 'sessions', category: 'chats', kind: 'dir' }],
      },
      entries: (async function* entries() {
        yield {
          // `q` marks a store the backup copied through SQLite, which must check out.
          meta: { p: 'sessions/sessions.db', s: broken.length, m: 0, c: 'chats', q: 1 },
          chunks: [broken],
        };
      })(),
    });
    const home = await makeTempDir('hostile-home');
    await assert.rejects(() => stageRestore({ home, archivePath: out }), /failed its integrity check/);
    assert.equal(readPendingRestore(home), null);
    assert.equal(await homeHas(home, 'restore-staging'), false);
  });
});
