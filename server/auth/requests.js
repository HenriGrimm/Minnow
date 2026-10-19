/**
 * Approve-on-host access requests. An unconnected phone or Home Screen app asks
 * for access and shows a 4-digit number; the host approves after checking the
 * same number. No code is typed anywhere.
 */

import crypto from 'node:crypto';
import {
  addCredential,
  createDevice,
  defaultDeviceName,
  getDevice,
  guessDeviceKind,
  sanitizeDeviceName,
} from './device-store.js';
import { isPairingWindowOpen, PairingError, recordPairingAttempt } from './pairing.js';

export const ACCESS_REQUEST_TTL_MS = 3 * 60 * 1000;
/** After approval the phone has this long to pick up its credential. */
const PICKUP_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 5;
const ID_RE = /^[0-9a-f]{24}$/;

/**
 * @typedef {{
 *   id: string,
 *   secretHash: Buffer,
 *   verifyCode: string,
 *   name: string,
 *   kind: string,
 *   installed: boolean,
 *   ingress: string,
 *   origin: string,
 *   createdAt: number,
 *   expiresAt: number,
 *   status: 'pending' | 'approved' | 'denied',
 *   token: string | null,
 *   credentialId: string | null,
 *   device: { id: string, name: string } | null,
 * }} AccessRequest
 */

/** @type {Map<string, AccessRequest>} */
const requests = new Map();

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

function prune(now) {
  for (const [id, request] of requests) {
    if (request.expiresAt <= now) requests.delete(id);
  }
}

/**
 * @param {{
 *   name?: unknown,
 *   userAgent?: unknown,
 *   installed?: unknown,
 *   ingress?: string,
 *   origin?: string,
 *   source?: string,
 * }} input
 * @param {{ now?: () => number, randomBytes?: (size: number) => Buffer, randomInt?: (min: number, max: number) => number }} [deps]
 */
export function createAccessRequest(input, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  const randomInt = deps.randomInt ?? ((min, max) => crypto.randomInt(min, max));
  // On the public tailnet address, strangers could otherwise spam the host with
  // prompts. Requests open only while the host is actively connecting a device.
  if (input.ingress === 'funnel' && !isPairingWindowOpen(now)) {
    throw new PairingError(
      'On your computer, open Settings → Devices → Connect a phone, then try again.',
      403,
      'requests_closed',
    );
  }
  recordPairingAttempt(input, now);
  prune(now);
  const pending = [...requests.values()].filter((request) => request.status === 'pending').length;
  if (pending >= MAX_PENDING) {
    throw new PairingError('Too many devices are waiting. Try again in a few minutes.', 429, 'requests_full');
  }
  const id = randomBytes(12).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const verifyCode = String(randomInt(0, 10_000)).padStart(4, '0');
  /** @type {AccessRequest} */
  const request = {
    id,
    secretHash: hashSecret(secret),
    verifyCode,
    name: sanitizeDeviceName(input.name) ?? defaultDeviceName(input.userAgent),
    kind: guessDeviceKind(input.userAgent),
    installed: input.installed === true,
    ingress: input.ingress ?? 'lan',
    origin: typeof input.origin === 'string' ? input.origin : '',
    createdAt: now,
    expiresAt: now + ACCESS_REQUEST_TTL_MS,
    status: 'pending',
    token: null,
    credentialId: null,
    device: null,
  };
  requests.set(id, request);
  return { id, secret, verifyCode, expiresAt: request.expiresAt };
}

/**
 * Phone-side poll. The credential is handed out exactly once.
 * @param {unknown} id
 * @param {unknown} secret
 * @param {{ now?: () => number }} [deps]
 */
export function pollAccessRequest(id, secret, deps = {}) {
  const now = (deps.now ?? Date.now)();
  prune(now);
  const request = typeof id === 'string' && ID_RE.test(id) ? requests.get(id) : undefined;
  if (!request || typeof secret !== 'string' || !crypto.timingSafeEqual(hashSecret(secret), request.secretHash)) {
    return { status: /** @type {const} */ ('expired') };
  }
  if (request.status === 'approved' && request.token) {
    const token = request.token;
    request.token = null;
    return {
      status: /** @type {const} */ ('approved'),
      token,
      credentialId: request.credentialId,
      device: request.device,
    };
  }
  return { status: request.status, expiresAt: request.expiresAt, device: request.device ?? undefined };
}

/** Pending requests for the host. */
export function listAccessRequests(deps = {}) {
  const now = (deps.now ?? Date.now)();
  prune(now);
  return [...requests.values()]
    .filter((request) => request.status === 'pending')
    .map((request) => ({
      id: request.id,
      name: request.name,
      kind: request.kind,
      verifyCode: request.verifyCode,
      installed: request.installed,
      ingress: request.ingress,
      createdAt: new Date(request.createdAt).toISOString(),
      expiresAt: new Date(request.expiresAt).toISOString(),
    }));
}

function requirePending(id, now) {
  prune(now);
  const request = requests.get(id);
  if (!request) throw new PairingError('This request has expired', 404, 'request_not_found');
  if (request.status !== 'pending') throw new PairingError('This request was already answered', 409, 'request_answered');
  return request;
}

/**
 * Approve a request, either as a new device or as another login on a device
 * the host already knows (so reconnecting never duplicates it).
 * @param {string} id
 * @param {{ attachToDeviceId?: unknown, name?: unknown }} [opts]
 * @param {{ now?: () => number }} [deps]
 */
export function approveAccessRequest(id, opts = {}, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const request = requirePending(id, now);
  let deviceId;
  if (typeof opts.attachToDeviceId === 'string' && opts.attachToDeviceId) {
    if (!getDevice(opts.attachToDeviceId)) throw new PairingError('Device not found', 404, 'device_not_found');
    deviceId = opts.attachToDeviceId;
  } else {
    const name = sanitizeDeviceName(opts.name) ?? request.name;
    deviceId = createDevice({ name, kind: request.kind }).device.id;
  }
  const issued = addCredential(deviceId, {
    label: request.installed ? 'home-screen' : 'browser',
    origin: request.origin,
  });
  request.status = 'approved';
  request.token = issued.token;
  request.credentialId = issued.credential.id;
  request.device = { id: issued.device.id, name: issued.device.name };
  request.expiresAt = now + PICKUP_TTL_MS;
  return { device: issued.device };
}

/**
 * @param {string} id
 * @param {{ now?: () => number }} [deps]
 */
export function denyAccessRequest(id, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const request = requirePending(id, now);
  request.status = 'denied';
  request.expiresAt = now + PICKUP_TTL_MS;
  return { denied: true };
}

/** Reset memory-only state (tests only). */
export function resetAccessRequests() {
  requests.clear();
}
