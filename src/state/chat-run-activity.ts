import { randomUUID } from '../lib/random-id';
import type { Chat } from '../types';

export type ChatRunActivityStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
interface Activity { version: 1; status: ChatRunActivityStatus; updatedAt: number }
const local = new Map<string, Activity>();
const remote = new Map<string, Map<string, Activity>>();
const revisions = new Map<string, number>();
const seenAt = new Map<string, number>();
const listeners = new Set<() => void>();
const owner = randomUUID();
let revision = 0;
let lastPublishedAt = 0;
let channel: BroadcastChannel | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const storageKey = (id: string) => `minnow.chatRunActivity.${id}`;
const valid = (value: unknown): value is Activity => {
  const activity = value as Activity | null;
  return Boolean(activity && activity.version === 1 && ['running', 'completed', 'failed', 'stopped', 'interrupted'].includes(activity.status)
    && Number.isFinite(activity.updatedAt));
};
function emit(): void { for (const listener of listeners) { try { listener(); } catch {} } }
function publish(): void {
  channel?.postMessage({ kind: 'snapshot', owner, revision: ++revision, entries: [...local] });
}
function init(): void {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('minnow.chat-run-activity');
  channel.onmessage = ({ data }) => {
    if (!data || typeof data.owner !== 'string' || data.owner === owner) return;
    if (data.kind === 'request') publish();
    if (data.kind !== 'snapshot' || !Array.isArray(data.entries) || typeof data.revision !== 'number'
      || data.revision <= (revisions.get(data.owner) ?? -1)) return;
    revisions.set(data.owner, data.revision);
    seenAt.set(data.owner, Date.now());
    const entries = new Map<string, Activity>();
    for (const entry of data.entries) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && valid(entry[1])) entries.set(entry[0], entry[1]);
    }
    remote.set(data.owner, entries);
    ensureHeartbeat();
    emit();
  };
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.postMessage({ kind: 'request', owner });
  window.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', disposeChatRunActivity, { once: true });
}
function onStorage(event: StorageEvent): void {
  if (event.key?.startsWith('minnow.chatRunActivity.')) emit();
}
function hasRunning(entries: Map<string, Activity>): boolean {
  return [...entries.values()].some((item) => item.status === 'running');
}
function ensureHeartbeat(): void {
  if (heartbeat || (!hasRunning(local) && ![...remote.values()].some(hasRunning))) return;
  heartbeat = setInterval(() => tickChatRunActivity(), 10_000);
  (heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
}
/** Active owners refresh their lease; a crashed renderer cannot leave a running badge forever. */
export function tickChatRunActivity(now = Date.now()): void {
  if (hasRunning(local)) publish();
  let expired = false;
  for (const [source, entries] of remote) {
    if (now - (seenAt.get(source) ?? now) < 30_000) continue;
    for (const [id, activity] of entries) {
      if (activity.status !== 'running') continue;
      entries.set(id, { version: 1, status: 'interrupted', updatedAt: now });
      expired = true;
    }
  }
  if (expired) emit();
  if (!hasRunning(local) && ![...remote.values()].some(hasRunning)) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
}
/** Publish once at turn boundaries; prose deltas need no cross-window messages. */
export function setChatRunActivity(id: string, status: ChatRunActivityStatus): void {
  init();
  const activity: Activity = { version: 1, status, updatedAt: Math.max(Date.now(), lastPublishedAt + 1) };
  lastPublishedAt = activity.updatedAt;
  local.set(id, activity);
  ensureHeartbeat();
  const settled = [...local].filter(([, item]) => item.status !== 'running').sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [chatId] of settled.slice(100)) local.delete(chatId);
  if (status !== 'running') {
    try {
      window.localStorage.setItem(storageKey(id), JSON.stringify(activity));
      const saved: { key: string; updatedAt: number }[] = [];
      for (let index = 0; index < window.localStorage.length; index++) {
        const key = window.localStorage.key(index);
        if (!key?.startsWith('minnow.chatRunActivity.')) continue;
        const value = JSON.parse(window.localStorage.getItem(key) ?? 'null');
        saved.push({ key, updatedAt: valid(value) ? value.updatedAt : 0 });
      }
      for (const item of saved.sort((a, b) => b.updatedAt - a.updatedAt).slice(100)) window.localStorage.removeItem(item.key);
    } catch {}
  }
  publish();
  emit();
}
export function getChatRunActivity(id: string, chat?: Chat): ChatRunActivityStatus | null {
  init();
  const candidates: Activity[] = [];
  const current = local.get(id);
  if (current) candidates.push(current);
  for (const entries of remote.values()) {
    const activity = entries.get(id);
    if (activity) candidates.push(activity);
  }
  // A leased live turn always takes precedence over a cached prior outcome.
  if (candidates.some((item) => item.status === 'running')) return 'running';
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(id)) ?? 'null');
    if (valid(saved)) candidates.push(saved);
  } catch {}
  const run = chat?.runs?.filter((item) => item.status !== 'superseded').sort((a, b) => a.createdAt - b.createdAt).at(-1);
  // Persisted running records alone cannot prove the originating window is alive.
  if (run && run.status !== 'running' && run.status !== 'superseded') candidates.push({ version: 1, status: run.status, updatedAt: run.endedAt ?? run.createdAt });
  return candidates.filter((item) => !run || item.updatedAt >= run.createdAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.status ?? null;
}
export function subscribeChatRunActivity(listener: () => void): () => void {
  init();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function disposeChatRunActivity(): void {
  for (const [id, activity] of local) {
    if (activity.status === 'running') setChatRunActivity(id, 'interrupted');
  }
  channel?.close();
  channel = undefined;
  local.clear();
  remote.clear();
  revisions.clear();
  seenAt.clear();
  clearInterval(heartbeat);
  heartbeat = undefined;
  window.removeEventListener('storage', onStorage);
  window.removeEventListener('pagehide', disposeChatRunActivity);
}
