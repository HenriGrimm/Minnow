/**
 * AES-256-GCM encrypted secret storage for Minnow credentials at rest.
 * Key file: ~/.minnow/.key (32-byte random, base64, mode 0o600 on Unix).
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { renameFileWithRetry } from '../runtime/atomic-file.js';

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_SOURCE_FILE = 'file';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Cached raw key bytes for this process. */
let cachedKeyBytes = null;
let keyAcquisition = null;

/** Whether the key file was created during this process. */
let keyCreatedThisProcess = false;

/**
 * @returns {string}
 */
function secretKeyPath() {
  return path.join(getMinnowHome(), '.key');
}

/**
 * Best-effort restrictive permissions on Unix.
 * @param {string} filePath
 * @param {number} mode
 */
async function chmodSafe(filePath, mode) {
  try {
    await fs.chmod(filePath, mode);
  } catch {
    /* ignore on Windows or unsupported FS */
  }
}

/**
 * Load or create the file-based encryption key.
 * @returns {Promise<Buffer>}
 */
async function loadFileKeyBytes() {
  if (cachedKeyBytes) {
    return cachedKeyBytes;
  }

  if (!keyAcquisition) {
    keyAcquisition = acquireKey(secretKeyPath())
      .then((key) => { cachedKeyBytes = key; return key; })
      .finally(() => { keyAcquisition = null; });
  }
  return keyAcquisition;
}

async function readKey(keyPath) {
  const key = Buffer.from((await fs.readFile(keyPath, 'utf8')).trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new Error('Secret encryption key has invalid length');
  return key;
}

async function acquireKey(keyPath) {
  try {
    return await readKey(keyPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  const key = crypto.randomBytes(KEY_BYTES);
  const candidate = keyPath + '.tmp-' + crypto.randomUUID();
  // link publishes the complete key exclusively, even across independent processes.
  const file = await fs.open(candidate, 'wx', 0o600);
  try {
    try {
      await file.writeFile(key.toString('base64') + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.link(candidate, keyPath);
      keyCreatedThisProcess = true;
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await readKey(keyPath);
    }
  } finally {
    await fs.unlink(candidate);
  }
}

/**
 * Resolve the encryption key for a stored payload.
 * @param {string} keySource
 * @returns {Promise<Buffer>}
 */
async function resolveKeyForSource(keySource) {
  if (keySource === KEY_SOURCE_FILE) {
    return loadFileKeyBytes();
  }
  throw new Error(`Unsupported secret key source: ${keySource}`);
}

/**
 * Build additional authenticated data bound into the GCM tag.
 * @param {number} version
 * @param {string} keySource
 * @returns {Buffer}
 */
function buildAad(version, keySource) {
  return Buffer.from(`${version}|${keySource}|${ALGORITHM}`, 'utf8');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isEncryptedSecretPayload(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    /** @type {{ encrypted?: boolean, version?: number }} */ (value).encrypted === true &&
    /** @type {{ version?: number }} */ (value).version === ENVELOPE_VERSION
  );
}

/**
 * Metadata about the active secret encryption key (no secret material).
 * @returns {Promise<{ keySource: string, keyPath: string, exists: boolean, createdThisProcess: boolean }>}
 */
export async function loadSecretKeyMetadata() {
  const keyPath = secretKeyPath();
  let exists = false;
  try {
    await fs.access(keyPath);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    await loadFileKeyBytes();
    exists = true;
  }

  return {
    keySource: KEY_SOURCE_FILE,
    keyPath,
    exists,
    createdThisProcess: keyCreatedThisProcess,
  };
}

/**
 * Encrypt a UTF-8 plaintext string into a versioned JSON envelope.
 * @param {string} plaintext
 * @returns {Promise<object>}
 */
export async function encryptSecretPayload(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecretPayload expects a string');
  }

  const key = await loadFileKeyBytes();
  const iv = crypto.randomBytes(IV_BYTES);
  const aad = buildAad(ENVELOPE_VERSION, KEY_SOURCE_FILE);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    encrypted: true,
    keySource: KEY_SOURCE_FILE,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt a versioned envelope back to UTF-8 plaintext.
 * @param {object} box
 * @returns {Promise<string>}
 */
export async function decryptSecretPayload(box) {
  if (!isEncryptedSecretPayload(box)) {
    throw new Error('Value is not an encrypted secret payload');
  }

  const keySource =
    typeof box.keySource === 'string' && box.keySource.trim()
      ? box.keySource.trim()
      : KEY_SOURCE_FILE;

  const ivRaw = typeof box.iv === 'string' ? box.iv : '';
  const tagRaw = typeof box.tag === 'string' ? box.tag : '';
  const ciphertextRaw = typeof box.ciphertext === 'string' ? box.ciphertext : '';
  if (!ivRaw || !tagRaw || !ciphertextRaw) {
    throw new Error('Encrypted secret payload is missing required fields');
  }

  if (box.algorithm !== ALGORITHM) {
    throw new Error('Unsupported secret encryption algorithm');
  }

  const iv = Buffer.from(ivRaw, 'base64');
  const tag = Buffer.from(tagRaw, 'base64');
  const ciphertext = Buffer.from(ciphertextRaw, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new Error('Encrypted secret payload has invalid IV');
  }

  const key = await resolveKeyForSource(keySource);
  const aad = buildAad(ENVELOPE_VERSION, keySource);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored credentials could not be decrypted (wrong key or corrupt data)');
  }
}

/**
 * Read JSON from disk, decrypting when the file uses the secret envelope.
 * Plaintext legacy files are migrated to encrypted form on read.
 * @param {string} filePath
 * @param {object} [defaults]
 * @returns {Promise<object>}
 */
export async function readEncryptedJsonFile(filePath, defaults = {}) {
  let rawText;
  try {
    rawText = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { ...defaults };
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Secret file contains invalid JSON');
  }

  if (isEncryptedSecretPayload(parsed)) {
    const plaintext = await decryptSecretPayload(parsed);
    try {
      return JSON.parse(plaintext);
    } catch {
      throw new Error('Decrypted secret file contains invalid JSON');
    }
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    await writeEncryptedJsonFile(filePath, parsed);
    return parsed;
  }

  throw new Error('Secret file has unsupported format');
}

/**
 * Encrypt and atomically write JSON to disk.
 * @param {string} filePath
 * @param {object} value
 * @returns {Promise<void>}
 */
export async function writeEncryptedJsonFile(filePath, value) {
  const plaintext = JSON.stringify(value);
  const envelope = await encryptSecretPayload(plaintext);
  const content = `${JSON.stringify(envelope, null, 2)}\n`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');

  const written = await fs.readFile(tmp, 'utf8');
  const verify = JSON.parse(written);
  if (!isEncryptedSecretPayload(verify)) {
    throw new Error('Failed to verify encrypted secret write');
  }
  await decryptSecretPayload(verify);

  await renameFileWithRetry(tmp, filePath);
  await chmodSafe(filePath, 0o600);
}

/** Reset cached key state (tests only). */
export function resetSecretBoxCacheForTests() {
  cachedKeyBytes = null;
  keyCreatedThisProcess = false;
}

/**
 * Inject a fixed key for tests (tests only).
 * @param {Buffer} keyBytes
 */
export function setSecretKeyBytesForTests(keyBytes) {
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== KEY_BYTES) {
    throw new Error('Test secret key must be a 32-byte Buffer');
  }
  cachedKeyBytes = Buffer.from(keyBytes);
  keyCreatedThisProcess = false;
}
