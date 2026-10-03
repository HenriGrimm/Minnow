// Shared hooks avoid importing subprocess implementations into storage modules.
const adapters = new Map();
const capabilities = new Map();
const pools = new Map();
const lockedChats = new Set();
import { forgetCliCheckpoints } from './checkpoints.js';
/** The manager owns bindings/admission; adapters own native protocol state. */
export function createCliSessionPool(adapter, closing, close) {
  const sessions = new Map();
  pools.set(adapter, { sessions, closing, close });
  return sessions;
}
export function lockCliChat(key) {
  if (lockedChats.has(key)) throw new Error('CLI session is already running for this chat.');
  lockedChats.add(key);
  return () => lockedChats.delete(key);
}
export function noteCliCapability(providerId, value) {
  capabilities.set(providerId, value);
  while (capabilities.size > 64) capabilities.delete(capabilities.keys().next().value);
}
export function getCliCapability(providerId) { return capabilities.get(providerId); }
export function registerCliDisposal(kind, dispose) { adapters.set(kind, dispose); }
export async function disposeCliSessions(filter = () => true, options = {}) {
  await Promise.all([...adapters.values()].map(dispose => dispose(filter, options)));
  if (options.forget) await forgetCliCheckpoints(filter);
}

export const CLI_IDLE_MS = 300_000;
export const CLI_IDLE_LIMIT = 8;
function managedSessions() {
  return [...new Set([...pools.values()].flatMap(entry => [...entry.sessions.values(), ...entry.closing]))];
}
function closeManagedSession(session, fallback) {
  const owner = [...pools.values()].find(entry => entry.sessions.get(session.key) === session || entry.closing.has(session));
  return (owner?.close ?? fallback)(session);
}

/** Reserve closing children until their exit is confirmed. */
export async function reserveCliProcess(pool, closing, providerId, concurrency, close) {
  const limit = Math.max(1, Math.min(16, Number(concurrency) || 1)) + CLI_IDLE_LIMIT;
  const owned = () => [...new Set([...pool.values(), ...closing, ...managedSessions()])]
    .filter(row => row.providerId === providerId);
  const idle = owned().filter(row => !row.active && !row.waiting && !row.closed && !lockedChats.has(row.key)).sort((a, b) => a.idleAt - b.idleAt);
  while (owned().length >= limit && idle.length) await closeManagedSession(idle.shift(), close);
  if (owned().length >= limit) throw new Error('CLI process limit reached; finish or stop a pending chat.');
}

export function retainCliSession(session, pool, close, deadline = CLI_IDLE_MS) {
  clearTimeout(session.timer);
  session.idleAt = Date.now();
  session.timer = setTimeout(() => { void close(session).catch(() => {}); }, deadline);
  session.timer.unref?.();
  if (session.waiting) return;
  const idle = [...new Set([...pool.values(), ...managedSessions()])].filter(row => row.providerId === session.providerId && !row.active && !row.waiting && !row.closed
    && (row === session || !lockedChats.has(row.key)))
    .sort((a, b) => a.idleAt - b.idleAt);
  while (idle.length > CLI_IDLE_LIMIT) void closeManagedSession(idle.shift(), close).catch(() => {});
}
