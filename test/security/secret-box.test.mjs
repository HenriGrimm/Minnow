/**
 * Unit tests for server/security/secret-box.js.
 */

import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import {
  decryptSecretPayload,
  encryptSecretPayload,
  isEncryptedSecretPayload,
  loadSecretKeyMetadata,
  readEncryptedJsonFile,
  resetSecretBoxCacheForTests,
  setSecretKeyBytesForTests,
  writeEncryptedJsonFile,
} from '../../server/security/secret-box.js';

const FIXED_KEY_A = Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'utf8');
const FIXED_KEY_B = Buffer.from('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'utf8');
const PLAINTEXT_FIXTURE = '{"apiKey":"sk-fixed-test","bearerToken":""}';

function setTestHome() {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  const dir = path.join('/tmp', `minnow-secret-box-${process.pid}-${Date.now()}`);
  process.env.MINNOW_HOME = dir;
  return dir;
}

async function rmTestHome(dir) {
  resetMinnowHomeCache();
  resetSecretBoxCacheForTests();
  delete process.env.MINNOW_HOME;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('isEncryptedSecretPayload', () => {
  test('returns true for version 1 envelope', () => {
    assert.equal(
      isEncryptedSecretPayload({ version: 1, encrypted: true, keySource: 'file' }),
      true,
    );
  });

  test('returns false for plaintext secrets object', () => {
    assert.equal(isEncryptedSecretPayload({ apiKey: 'x', bearerToken: '' }), false);
  });

  test('returns false for wrong version', () => {
    assert.equal(isEncryptedSecretPayload({ version: 2, encrypted: true }), false);
  });
});

describe('encryptSecretPayload / decryptSecretPayload', () => {
  /** @type {string | undefined} */
  let home;

  beforeEach(() => {
    home = setTestHome();
    setSecretKeyBytesForTests(FIXED_KEY_A);
  });

  afterEach(async () => {
    if (home) await rmTestHome(home);
  });

  test('round-trip preserves plaintext', async () => {
    const plaintext = PLAINTEXT_FIXTURE;
    const box = await encryptSecretPayload(plaintext);
    assert.equal(isEncryptedSecretPayload(box), true);
    assert.equal(box.algorithm, 'aes-256-gcm');
    assert.equal(box.keySource, 'file');
    const decrypted = await decryptSecretPayload(box);
    assert.equal(decrypted, plaintext);
  });

  test('tampered ciphertext fails decrypt', async () => {
    const box = await encryptSecretPayload(PLAINTEXT_FIXTURE);
    const bytes = Buffer.from(box.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...box, ciphertext: bytes.toString('base64') };
    await assert.rejects(
      () => decryptSecretPayload(tampered),
      /could not be decrypted/,
    );
  });

  test('tampered auth tag fails decrypt', async () => {
    const box = await encryptSecretPayload(PLAINTEXT_FIXTURE);
    const bytes = Buffer.from(box.tag, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...box, tag: bytes.toString('base64') };
    await assert.rejects(
      () => decryptSecretPayload(tampered),
      /could not be decrypted/,
    );
  });

  test('wrong key fails decrypt', async () => {
    const box = await encryptSecretPayload(PLAINTEXT_FIXTURE);
    setSecretKeyBytesForTests(FIXED_KEY_B);
    await assert.rejects(
      () => decryptSecretPayload(box),
      /could not be decrypted/,
    );
  });

  test('malformed envelope missing fields throws', async () => {
    await assert.rejects(
      () => decryptSecretPayload({ version: 1, encrypted: true, keySource: 'file' }),
      /missing required fields/,
    );
  });

  test('unsupported algorithm throws', async () => {
    const box = await encryptSecretPayload(PLAINTEXT_FIXTURE);
    await assert.rejects(
      () => decryptSecretPayload({ ...box, algorithm: 'aes-128-gcm' }),
      /Unsupported secret encryption algorithm/,
    );
  });
});

describe('readEncryptedJsonFile / writeEncryptedJsonFile', () => {
  /** @type {string | undefined} */
  let home;

  beforeEach(() => {
    home = setTestHome();
    setSecretKeyBytesForTests(FIXED_KEY_A);
  });

  afterEach(async () => {
    if (home) await rmTestHome(home);
  });

  test('missing file returns defaults', async () => {
    const file = path.join(home, 'missing.json');
    const value = await readEncryptedJsonFile(file, { apiKey: '', bearerToken: '' });
    assert.deepEqual(value, { apiKey: '', bearerToken: '' });
  });

  test('write then read round-trip', async () => {
    const file = path.join(home, 'secrets.json');
    const payload = { apiKey: 'sk-fixed', bearerToken: 'tok-fixed', headerOverrides: {} };
    await writeEncryptedJsonFile(file, payload);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(isEncryptedSecretPayload(raw), true);
    const readBack = await readEncryptedJsonFile(file, {});
    assert.deepEqual(readBack, payload);
  });

  test('a sharing lock retains the previous secret until encrypted replacement succeeds', async t => {
    const file = path.join(home, 'secrets.json');
    await writeEncryptedJsonFile(file, { apiKey: 'previous-fixture-secret' });
    const previous = await fs.readFile(file, 'utf8');
    const rename = fs.rename;
    let attempts = 0;
    const mocked = t.mock.method(fs, 'rename', async (source, destination) => {
      if (destination !== file) return rename(source, destination);
      attempts++;
      assert.equal(await fs.readFile(file, 'utf8'), previous);
      const pending = await fs.readFile(source, 'utf8');
      assert.equal(isEncryptedSecretPayload(JSON.parse(pending)), true);
      assert.equal(pending.includes('replacement-fixture-secret'), false);
      if (attempts < 3) throw Object.assign(new Error('Scanner lock'), { code: 'EPERM' });
      return rename(source, destination);
    });
    try { await writeEncryptedJsonFile(file, { apiKey: 'replacement-fixture-secret' }); }
    finally { mocked.mock.restore(); }
    assert.equal(attempts, 3);
    assert.deepEqual(await readEncryptedJsonFile(file, {}), { apiKey: 'replacement-fixture-secret' });
  });
});

describe('loadSecretKeyMetadata', () => {
  /** @type {string | undefined} */
  let home;

  beforeEach(() => {
    home = setTestHome();
  });

  afterEach(async () => {
    if (home) await rmTestHome(home);
  });

  test('creates key file on first use', async () => {
    const meta = await loadSecretKeyMetadata();
    assert.equal(meta.keySource, 'file');
    assert.equal(meta.exists, true);
    assert.equal(meta.createdThisProcess, true);
    const raw = (await fs.readFile(meta.keyPath, 'utf8')).trim();
    const decoded = Buffer.from(raw, 'base64');
    assert.equal(decoded.length, 32);
  });

  test('generated key uses restrictive permissions when supported', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const meta = await loadSecretKeyMetadata();
    const stat = await fs.stat(meta.keyPath);
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

describe('key generation', () => {
  /** @type {string | undefined} */
  let home;

  beforeEach(() => {
    home = setTestHome();
    resetSecretBoxCacheForTests();
  });

  afterEach(async () => {
    if (home) await rmTestHome(home);
  });

  test('concurrent processes and callers use the same durable key', async () => {
    const moduleUrl = new URL('../../server/security/secret-box.js', import.meta.url).href;
    const script = `import { encryptSecretPayload } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await Promise.all(Array.from({length: 8}, () => encryptSecretPayload('first')))));`;
    const groups = await Promise.all(Array.from({length: 4}, async () => {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
      return JSON.parse(stdout);
    }));
    for (const box of groups.flat()) assert.equal(await decryptSecretPayload(box), 'first');
    assert.deepEqual(await fs.readdir(home), ['.key']);
  });

  test('creates random 32-byte key', async () => {
    await encryptSecretPayload('test');
    const keyPath = path.join(home, '.key');
    const raw = (await fs.readFile(keyPath, 'utf8')).trim();
    const decoded = Buffer.from(raw, 'base64');
    assert.equal(decoded.length, 32);
  });
});
