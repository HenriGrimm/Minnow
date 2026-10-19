/**
 * Persistent, named companion devices. A device (one phone or tablet) holds one
 * credential per place it signs in from — its browser, its Home Screen app, or
 * another Minnow address — so reconnecting never duplicates the device. Secrets
 * are returned once; only SHA-256 digests are written to ~/.minnow/auth/devices.json.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';

const SCHEMA_VERSION = 2;
const DEVICE_TOKEN_RE = /^minnow_device_([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
const ID_RE = /^[0-9a-f]{24}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const ACTIVITY_FLUSH_MS = 60_000;
const DEVICE_KINDS = new Set(['phone', 'tablet', 'computer', 'unknown']);
const CREDENTIAL_LABELS = new Set(['browser', 'home-screen', 'other-origin']);

/**
 * @typedef {{
 *   id: string,
 *   tokenHash: string,
 *   label: 'browser' | 'home-screen' | 'other-origin',
 *   origin: string,
 *   createdAt: string,
 *   lastSeenAt?: string,
 * }} DeviceCredential
 * @typedef {{
 *   id: string,
 *   name: string,
 *   kind: 'phone' | 'tablet' | 'computer' | 'unknown',
 *   createdAt: string,
 *   lastSeenAt?: string,
 *   lastIngress?: string,
 *   credentials: DeviceCredential[],
 * }} DeviceRecord
 */

function authDir() {
  return path.join(getMinnowHome(), 'auth');
}

function devicesPath() {
  return path.join(authDir(), 'devices.json');
}

function chmodSafe(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* Windows and some filesystems do not implement Unix permissions. */
  }
}

function ensureAuthDir() {
  const dir = authDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSafe(dir, 0o700);
  return dir;
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, devices: [] };
}

function isV1Store(parsed) {
  return (
    parsed?.schemaVersion === 1 &&
    Array.isArray(parsed.devices) &&
    parsed.devices.every(
      (device) =>
        device &&
        typeof device.id === 'string' &&
        ID_RE.test(device.id) &&
        typeof device.name === 'string' &&
        typeof device.tokenHash === 'string' &&
        HASH_RE.test(device.tokenHash) &&
        typeof device.createdAt === 'string',
    )
  );
}

function isV2Store(parsed) {
  return (
    parsed?.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(parsed.devices) &&
    parsed.devices.every(
      (device) =>
        device &&
        typeof device.id === 'string' &&
        ID_RE.test(device.id) &&
        typeof device.name === 'string' &&
        typeof device.createdAt === 'string' &&
        Array.isArray(device.credentials) &&
        device.credentials.every(
          (credential) =>
            credential &&
            typeof credential.id === 'string' &&
            ID_RE.test(credential.id) &&
            typeof credential.tokenHash === 'string' &&
            HASH_RE.test(credential.tokenHash),
        ),
    )
  );
}

/**
 * A v1 device keeps its token: the old device id becomes the id of its single
 * credential, so `minnow_device_<id>.<secret>` still authenticates.
 */
export function migrateV1(store) {
  return {
    schemaVersion: SCHEMA_VERSION,
    devices: store.devices.map((device) => ({
      id: device.id,
      name: device.name,
      kind: 'unknown',
      createdAt: device.createdAt,
      credentials: [
        {
          id: device.id,
          tokenHash: device.tokenHash,
          label: 'browser',
          origin: '',
          createdAt: device.createdAt,
        },
      ],
    })),
  };
}

/** @type {{ file: string, mtimeMs: number, size: number, store: { schemaVersion: number, devices: DeviceRecord[] } } | null} */
let cache = null;

function writeStore(store) {
  const dir = ensureAuthDir();
  const target = devicesPath();
  const temporary = path.join(
    dir,
    `.devices.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSafe(temporary, 0o600);
    fs.renameSync(temporary, target);
    chmodSafe(target, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* The rename removed the temporary file, or creation failed. */
    }
  }
  try {
    const stat = fs.statSync(target);
    cache = { file: target, mtimeMs: stat.mtimeMs, size: stat.size, store };
  } catch {
    cache = null;
  }
}

/**
 * Read the registry. Cached by mtime+size so per-request authentication does not
 * parse JSON every time; in-process writes refresh the cache synchronously, so a
 * revocation is effective on the very next request.
 */
function readStore() {
  const file = devicesPath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      cache = null;
      return emptyStore();
    }
    throw err;
  }
  if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.store;

  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (isV2Store(parsed)) {
    cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, store: parsed };
    return parsed;
  }
  if (isV1Store(parsed)) {
    const backup = path.join(authDir(), 'devices.v1.json.bak');
    try {
      fs.writeFileSync(backup, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch {
      /* A previous migration attempt already kept the original. */
    }
    const migrated = migrateV1(parsed);
    writeStore(migrated);
    return migrated;
  }
  throw new Error('Invalid companion device store');
}

/**
 * Normalize a user-visible device name and reject empty input.
 * @param {unknown} value
 */
export function sanitizeDeviceName(value) {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
  return name || null;
}

/** @param {string} token */
export function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Best-effort device kind from a User-Agent, for the list icon and default name.
 * @param {unknown} userAgent
 * @returns {'phone' | 'tablet' | 'computer' | 'unknown'}
 */
export function guessDeviceKind(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent) return 'unknown';
  if (/iPad/i.test(userAgent)) return 'tablet';
  if (/iPhone|iPod/i.test(userAgent)) return 'phone';
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? 'phone' : 'tablet';
  // iPadOS Safari reports a Mac user agent; the client sends a touch hint.
  if (/Macintosh|Windows NT|X11|CrOS/i.test(userAgent)) return 'computer';
  return 'unknown';
}

/**
 * A name the user can keep or edit later, so connecting never asks for one.
 * @param {unknown} userAgent
 */
export function defaultDeviceName(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows NT/i.test(ua)) return 'Windows PC';
  return 'Device';
}

function randomId(randomBytes) {
  return randomBytes(12).toString('hex');
}

/**
 * Create a named device with no credential yet. Pair with {@link addCredential}.
 * @param {{ name: unknown, kind?: unknown }} input
 * @param {{ now?: () => number, randomBytes?: (size: number) => Buffer }} [deps]
 */
export function createDevice(input, deps = {}) {
  const name = sanitizeDeviceName(input?.name);
  if (!name) throw new TypeError('A device name is required');
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  const now = deps.now ?? Date.now;
  const kind = DEVICE_KINDS.has(/** @type {string} */ (input?.kind)) ? input.kind : 'unknown';
  /** @type {DeviceRecord} */
  const device = {
    id: randomId(randomBytes),
    name,
    kind: /** @type {DeviceRecord['kind']} */ (kind),
    createdAt: new Date(now()).toISOString(),
    credentials: [],
  };
  const store = readStore();
  writeStore({ ...store, devices: [...store.devices, device] });
  return { device: publicDevice(device) };
}

/**
 * Issue a new credential on an existing device, returning its secret once.
 * @param {string} deviceId
 * @param {{ label?: unknown, origin?: unknown }} [input]
 * @param {{ now?: () => number, randomBytes?: (size: number) => Buffer }} [deps]
 */
export function addCredential(deviceId, input = {}, deps = {}) {
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  const now = deps.now ?? Date.now;
  const store = readStore();
  const device = store.devices.find((candidate) => candidate.id === deviceId);
  if (!device) throw new Error('Device not found');
  const taken = new Set(store.devices.flatMap((candidate) => candidate.credentials.map((c) => c.id)));
  let id = randomId(randomBytes);
  while (taken.has(id)) id = randomId(randomBytes);
  const token = `minnow_device_${id}.${randomBytes(32).toString('base64url')}`;
  const label = CREDENTIAL_LABELS.has(/** @type {string} */ (input.label)) ? input.label : 'browser';
  /** @type {DeviceCredential} */
  const credential = {
    id,
    tokenHash: hashDeviceToken(token),
    label: /** @type {DeviceCredential['label']} */ (label),
    origin: typeof input.origin === 'string' ? input.origin.slice(0, 200) : '',
    createdAt: new Date(now()).toISOString(),
  };
  const devices = store.devices.map((candidate) =>
    candidate.id === deviceId
      ? { ...candidate, credentials: [...candidate.credentials, credential] }
      : candidate,
  );
  writeStore({ ...store, devices });
  return { token, credential: publicCredential(credential), device: publicDevice(devices.find((d) => d.id === deviceId)) };
}

/** @type {Map<string, { at: number, ingress: string, credentials: Map<string, number> }>} */
const pendingActivity = new Map();
let lastActivityFlush = 0;

function publicCredential(credential) {
  return {
    id: credential.id,
    label: credential.label,
    origin: credential.origin,
    createdAt: credential.createdAt,
    ...(credential.lastSeenAt ? { lastSeenAt: credential.lastSeenAt } : {}),
  };
}

function publicDevice(device) {
  const activity = pendingActivity.get(device.id);
  return {
    id: device.id,
    name: device.name,
    kind: device.kind ?? 'unknown',
    createdAt: device.createdAt,
    lastSeenAt: activity ? new Date(activity.at).toISOString() : device.lastSeenAt,
    lastIngress: activity?.ingress ?? device.lastIngress,
    credentials: device.credentials.map((credential) => {
      const seen = activity?.credentials.get(credential.id);
      return publicCredential(seen ? { ...credential, lastSeenAt: new Date(seen).toISOString() } : credential);
    }),
  };
}

/** List public device records, never token hashes. */
export function listDevices() {
  return readStore().devices.map(publicDevice);
}

/**
 * Authenticate against the current records.
 * @param {unknown} token
 */
export function authenticateDeviceToken(token) {
  if (typeof token !== 'string' || token.length > 256) return null;
  const match = DEVICE_TOKEN_RE.exec(token);
  if (!match) return null;
  const credentialId = match[1];
  for (const device of readStore().devices) {
    const credential = device.credentials.find((candidate) => candidate.id === credentialId);
    if (!credential) continue;
    const expected = Buffer.from(credential.tokenHash, 'hex');
    const actual = Buffer.from(hashDeviceToken(token), 'hex');
    if (!crypto.timingSafeEqual(actual, expected)) return null;
    return {
      kind: /** @type {const} */ ('device'),
      deviceId: device.id,
      credentialId,
      deviceName: device.name,
    };
  }
  return null;
}

/** Persist buffered last-seen times. Called on a timer and at shutdown. */
export function flushDeviceActivity() {
  if (pendingActivity.size === 0) return;
  const activity = new Map(pendingActivity);
  pendingActivity.clear();
  lastActivityFlush = Date.now();
  let store;
  try {
    store = readStore();
  } catch {
    return;
  }
  let changed = false;
  const devices = store.devices.map((device) => {
    const seen = activity.get(device.id);
    if (!seen) return device;
    changed = true;
    return {
      ...device,
      lastSeenAt: new Date(seen.at).toISOString(),
      lastIngress: seen.ingress,
      credentials: device.credentials.map((credential) => {
        const at = seen.credentials.get(credential.id);
        return at ? { ...credential, lastSeenAt: new Date(at).toISOString() } : credential;
      }),
    };
  });
  if (changed) {
    try {
      writeStore({ ...store, devices });
    } catch {
      /* Activity is advisory; a failed write must not break requests. */
    }
  }
}

/**
 * Note that a device was just used. Buffered in memory and written at most once
 * a minute so authenticated traffic does not rewrite the registry per request.
 * @param {string} deviceId
 * @param {string} credentialId
 * @param {string} ingress
 * @param {{ now?: () => number }} [deps]
 */
export function touchDevice(deviceId, credentialId, ingress, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const entry = pendingActivity.get(deviceId) ?? { at: now, ingress, credentials: new Map() };
  entry.at = now;
  entry.ingress = ingress;
  entry.credentials.set(credentialId, now);
  pendingActivity.set(deviceId, entry);
  if (now - lastActivityFlush >= ACTIVITY_FLUSH_MS) flushDeviceActivity();
}

/**
 * @param {string} id
 * @param {unknown} name
 */
export function renameDevice(id, name) {
  const sanitized = sanitizeDeviceName(name);
  if (!sanitized) throw new TypeError('A device name is required');
  const store = readStore();
  if (!store.devices.some((device) => device.id === id)) return null;
  const devices = store.devices.map((device) => (device.id === id ? { ...device, name: sanitized } : device));
  writeStore({ ...store, devices });
  return publicDevice(devices.find((device) => device.id === id));
}

/**
 * Remove a device and every credential it holds, synchronously.
 * @param {string} id
 */
export function revokeDevice(id) {
  const store = readStore();
  const nextDevices = store.devices.filter((device) => device.id !== id);
  if (nextDevices.length === store.devices.length) return false;
  pendingActivity.delete(id);
  writeStore({ ...store, devices: nextDevices });
  return true;
}

/**
 * Remove one credential (for example a stale browser login) from a device.
 * @param {string} deviceId
 * @param {string} credentialId
 */
export function revokeCredential(deviceId, credentialId) {
  const store = readStore();
  const device = store.devices.find((candidate) => candidate.id === deviceId);
  if (!device || !device.credentials.some((credential) => credential.id === credentialId)) return false;
  const devices = store.devices.map((candidate) =>
    candidate.id === deviceId
      ? { ...candidate, credentials: candidate.credentials.filter((c) => c.id !== credentialId) }
      : candidate,
  );
  writeStore({ ...store, devices });
  return true;
}

/** @param {string} id */
export function getDevice(id) {
  const device = readStore().devices.find((candidate) => candidate.id === id);
  return device ? publicDevice(device) : null;
}

/** Reset in-memory caches (tests only). */
export function resetDeviceStoreCache() {
  cache = null;
  pendingActivity.clear();
  lastActivityFlush = 0;
}
