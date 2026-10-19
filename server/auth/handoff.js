/**
 * Handoff tickets move a device's sign-in into a place with its own cookie jar:
 * an iOS Home Screen app (install) or another Minnow address (move). A ticket is
 * bound to one device and exchanged for a new credential on that same device.
 *
 * Install tickets ride the Home Screen app's start URL, and the app can first
 * launch days later, possibly after a host restart, so only their SHA-256
 * digests are persisted in ~/.minnow/auth/handoff.json.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { addCredential, getDevice } from './device-store.js';

export const INSTALL_TICKET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MOVE_TICKET_TTL_MS = 10 * 60 * 1000;
/** Reuse an in-memory install ticket while it has at least this long left. */
const INSTALL_REUSE_MIN_MS = 24 * 60 * 60 * 1000;
const MAX_TICKETS_PER_DEVICE = 3;
const TICKET_RE = /^[A-Za-z0-9_-]{32}$/;

/** @typedef {'install' | 'move'} HandoffPurpose */
/** @typedef {{ hash: string, deviceId: string, purpose: HandoffPurpose, createdAt: number, expiresAt: number }} StoredTicket */

/** @type {Map<string, { ticket: string, expiresAt: number }>} deviceId → reusable install ticket */
const reusableInstall = new Map();

function storePath() {
  return path.join(getMinnowHome(), 'auth', 'handoff.json');
}

function hashTicket(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/** @returns {StoredTicket[]} */
function readTickets() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(parsed?.tickets) ? parsed.tickets.filter((t) => t && typeof t.hash === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {StoredTicket[]} tickets */
function writeTickets(tickets) {
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, tickets }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
}

function live(tickets, now) {
  return tickets.filter((ticket) => ticket.expiresAt > now && getDevice(ticket.deviceId));
}

/**
 * @param {string} deviceId
 * @param {{ purpose: HandoffPurpose }} opts
 * @param {{ now?: () => number, randomBytes?: (size: number) => Buffer }} [deps]
 */
export function createHandoffTicket(deviceId, opts, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const randomBytes = deps.randomBytes ?? crypto.randomBytes;
  const purpose = opts.purpose === 'move' ? 'move' : 'install';
  if (!getDevice(deviceId)) throw new Error('Device not found');
  const ticket = randomBytes(24).toString('base64url');
  const expiresAt = now + (purpose === 'install' ? INSTALL_TICKET_TTL_MS : MOVE_TICKET_TTL_MS);
  const others = live(readTickets(), now);
  const mine = others.filter((stored) => stored.deviceId === deviceId);
  // Keep the newest few per device; an older install ticket simply stops working.
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - (MAX_TICKETS_PER_DEVICE - 1))).map((t) => t.hash));
  writeTickets([
    ...others.filter((stored) => !drop.has(stored.hash)),
    { hash: hashTicket(ticket), deviceId, purpose, createdAt: now, expiresAt },
  ]);
  if (purpose === 'install') reusableInstall.set(deviceId, { ticket, expiresAt });
  return { ticket, purpose, expiresAt };
}

/**
 * The install ticket embedded in pages served to a signed-in device, reused so
 * every page load does not mint a new one.
 * @param {string} deviceId
 * @param {{ now?: () => number }} [deps]
 */
export function getOrCreateInstallTicket(deviceId, deps = {}) {
  const now = (deps.now ?? Date.now)();
  const cached = reusableInstall.get(deviceId);
  if (cached && cached.expiresAt - now >= INSTALL_REUSE_MIN_MS) {
    const stillStored = readTickets().some((stored) => stored.hash === hashTicket(cached.ticket));
    if (stillStored) return cached;
  }
  const created = createHandoffTicket(deviceId, { purpose: 'install' }, deps);
  return { ticket: created.ticket, expiresAt: created.expiresAt };
}

/**
 * Look at a ticket without using it (the manifest embeds it in start_url).
 * @param {unknown} ticket
 * @param {{ now?: () => number }} [deps]
 */
export function peekHandoffTicket(ticket, deps = {}) {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null;
  const now = (deps.now ?? Date.now)();
  const hash = hashTicket(ticket);
  const stored = live(readTickets(), now).find((candidate) => candidate.hash === hash);
  return stored ? { deviceId: stored.deviceId, purpose: stored.purpose, expiresAt: stored.expiresAt } : null;
}

/**
 * Exchange a ticket for a new credential on its device. Single use.
 * @param {unknown} ticket
 * @param {{ origin?: string }} [opts]
 * @param {{ now?: () => number }} [deps]
 */
export function consumeHandoffTicket(ticket, opts = {}, deps = {}) {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null;
  const now = (deps.now ?? Date.now)();
  const hash = hashTicket(ticket);
  const tickets = live(readTickets(), now);
  const stored = tickets.find((candidate) => candidate.hash === hash);
  if (!stored) return null;
  writeTickets(tickets.filter((candidate) => candidate.hash !== hash));
  const cached = reusableInstall.get(stored.deviceId);
  if (cached?.ticket === ticket) reusableInstall.delete(stored.deviceId);
  const issued = addCredential(stored.deviceId, {
    label: stored.purpose === 'install' ? 'home-screen' : 'other-origin',
    origin: opts.origin,
  });
  return { token: issued.token, credentialId: issued.credential.id, device: issued.device, purpose: stored.purpose };
}

/** Reset in-memory state (tests only). */
export function resetHandoffState() {
  reusableInstall.clear();
}
