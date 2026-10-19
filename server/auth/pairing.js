/**
 * Memory-only connect sessions. The host opens one from Settings → Devices; it
 * carries a single-use QR ticket and, for the home network only, a 6-digit code
 * typed by hand. Opening a session also opens the pairing window that lets
 * internet-reachable (Funnel) devices ask for access.
 */

import crypto from 'node:crypto';
import {
  addCredential,
  createDevice,
  defaultDeviceName,
  guessDeviceKind,
  sanitizeDeviceName,
} from './device-store.js';

export const CONNECT_SESSION_TTL_MS = 10 * 60 * 1000;
export const PAIRING_WINDOW_MS = 10 * 60 * 1000;
export const PAIRING_CODE_DIGITS = 6;
const PAIRING_CODE_RE = /^\d{6}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{22}$/;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS_PER_SOURCE = 10;
/** Internet-facing bootstrap calls share one budget, whatever their source. */
const MAX_FUNNEL_ATTEMPTS = 30;
const MAX_ACTIVE_SESSIONS = 20;
const MAX_CODE_ALLOCATION_ATTEMPTS = 32;

/**
 * @typedef {{
 *   id: string,
 *   ticket: string,
 *   code: string,
 *   createdAt: number,
 *   expiresAt: number,
 *   claimed: null | { deviceId: string, deviceName: string, at: number },
 * }} ConnectSession
 */

/** @type {Map<string, ConnectSession>} */
const sessions = new Map();
/** @type {Map<string, string>} ticket → session id */
const sessionsByTicket = new Map();
/** @type {Map<string, string>} code → session id */
const sessionsByCode = new Map();
/** @type {Map<string, number[]>} */
const attempts = new Map();
let pairingWindowUntil = 0;

export class PairingError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'PairingError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function prune(now) {
  for (const [id, session] of sessions) {
    // Keep claimed sessions until expiry so the host's sheet can report them.
    if (session.expiresAt > now) continue;
    sessions.delete(id);
    sessionsByTicket.delete(session.ticket);
    sessionsByCode.delete(session.code);
  }
  for (const [source, timestamps] of attempts) {
    const recent = timestamps.filter((timestamp) => timestamp > now - ATTEMPT_WINDOW_MS);
    if (recent.length) attempts.set(source, recent);
    else attempts.delete(source);
  }
}

/**
 * Throttle unauthenticated pairing calls per source, plus a global budget for
 * the internet-facing ingress.
 * @param {{ source?: string, ingress?: string }} input
 * @param {number} now
 */
export function recordPairingAttempt(input, now = Date.now()) {
  prune(now);
  const keys = [`source:${input.source || 'unknown'}`];
  if (input.ingress === 'funnel') keys.push('funnel:*');
  for (const key of keys) {
    const limit = key === 'funnel:*' ? MAX_FUNNEL_ATTEMPTS : MAX_ATTEMPTS_PER_SOURCE;
    if ((attempts.get(key) ?? []).length >= limit) {
      throw new PairingError('Too many attempts. Wait a minute and try again.', 429, 'pairing_throttled');
    }
  }
  for (const key of keys) attempts.set(key, [...(attempts.get(key) ?? []), now]);
}

/** Strip non-digits and require exactly six numeric characters. */
export function normalizePairingCode(value) {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  return PAIRING_CODE_RE.test(digits) ? digits : '';
}

/** @param {{ randomInt?: (min: number, max: number) => number }} deps */
function allocatePairingCode(deps = {}) {
  const randomInt = deps.randomInt ?? ((min, max) => crypto.randomInt(min, max));
  const upper = 10 ** PAIRING_CODE_DIGITS;
  for (let attempt = 0; attempt < MAX_CODE_ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = String(randomInt(0, upper)).padStart(PAIRING_CODE_DIGITS, '0');
    if (!sessionsByCode.has(code)) return code;
  }
  throw new PairingError('Could not allocate pairing code', 503, 'pairing_capacity');
}

/**
 * Open a connect session (host only).
 * @param {{
 *   now?: () => number,
 *   randomInt?: (min: number, max: number) => number,
 *   randomBytes?: (size: number) => Buffer,
 * }} [deps]
 */
export function createConnectSession(deps = {}) {
  const now = (deps.now ?? Date.now)();
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  prune(now);
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    throw new PairingError('Too many open connect sessions', 429, 'pairing_capacity');
  }
  const id = randomBytes(12).toString('hex');
  const ticket = randomBytes(16).toString('base64url');
  const code = allocatePairingCode(deps);
  const expiresAt = now + CONNECT_SESSION_TTL_MS;
  /** @type {ConnectSession} */
  const session = { id, ticket, code, createdAt: now, expiresAt, claimed: null };
  sessions.set(id, session);
  sessionsByTicket.set(ticket, id);
  sessionsByCode.set(code, id);
  pairingWindowUntil = Math.max(pairingWindowUntil, now + PAIRING_WINDOW_MS);
  return { id, ticket, code, expiresAt };
}

/**
 * Host-side status of a session it opened.
 * @param {string} id
 * @param {{ now?: () => number }} [deps]
 */
export function getConnectSession(id, deps = {}) {
  const now = (deps.now ?? Date.now)();
  prune(now);
  const session = sessions.get(id);
  if (!session) return { id, status: /** @type {const} */ ('expired') };
  if (session.claimed) {
    return {
      id,
      status: /** @type {const} */ ('claimed'),
      expiresAt: session.expiresAt,
      device: { id: session.claimed.deviceId, name: session.claimed.deviceName },
    };
  }
  return { id, status: /** @type {const} */ ('waiting'), expiresAt: session.expiresAt };
}

/** Whether internet-reachable devices may currently request access. */
export function isPairingWindowOpen(now = Date.now()) {
  return pairingWindowUntil > now;
}

/**
 * Claim a session with its QR ticket or (home network only) its code. The
 * ticket is consumed before the device is persisted, so a storage failure
 * cannot make a secret reusable.
 * @param {{
 *   ticket?: unknown,
 *   code?: unknown,
 *   name?: unknown,
 *   userAgent?: unknown,
 *   installed?: unknown,
 *   ingress?: string,
 *   origin?: string,
 *   source?: string,
 * }} input
 * @param {{ now?: () => number }} [deps]
 */
export function claimConnectSession(input, deps = {}) {
  const now = (deps.now ?? Date.now)();
  recordPairingAttempt(input, now);

  let sessionId;
  if (typeof input.ticket === 'string' && input.ticket) {
    if (!TICKET_RE.test(input.ticket)) {
      throw new PairingError('This connect link is invalid or has expired.', 401, 'invalid_ticket');
    }
    sessionId = sessionsByTicket.get(input.ticket);
  } else {
    if (input.ingress !== 'lan') {
      throw new PairingError('Codes only work on your home network. Scan the QR instead.', 403, 'code_entry_disabled');
    }
    const code = normalizePairingCode(input.code);
    if (!code) throw new PairingError('Enter the 6-digit code from your computer.', 400, 'invalid_pairing_request');
    sessionId = sessionsByCode.get(code);
  }

  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.claimed || session.expiresAt <= now) {
    throw new PairingError('This connect link is invalid or has expired.', 401, 'invalid_ticket');
  }

  sessionsByTicket.delete(session.ticket);
  sessionsByCode.delete(session.code);
  const name = sanitizeDeviceName(input.name) ?? defaultDeviceName(input.userAgent);
  const { device } = createDevice({ name, kind: guessDeviceKind(input.userAgent) });
  const issued = addCredential(device.id, {
    label: input.installed === true ? 'home-screen' : 'browser',
    origin: input.origin,
  });
  session.claimed = { deviceId: device.id, deviceName: device.name, at: now };
  return { token: issued.token, credentialId: issued.credential.id, device: issued.device };
}

/** Reset memory-only state (tests only). */
export function resetPairingState() {
  sessions.clear();
  sessionsByTicket.clear();
  sessionsByCode.clear();
  attempts.clear();
  pairingWindowUntil = 0;
}
