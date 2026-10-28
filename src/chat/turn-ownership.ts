import { isServerStorageMode } from '../config/storage-mode';
import { randomUUID } from '../lib/random-id';
import { isChatRunningRemotely, setRemoteChatTurns } from './remote-turn-state';
import { isPairedDevice } from '../api/session-token';
import { getChatHostId } from './remote-chat-client';
import { createTurnLease, ChatLeaseRequestError, type LeaseGrant } from './turn-lease';
import { reportBackgroundError } from '../boot/report-background-error';

const owners = new Map<string, string>();
const REQUEST_TIMEOUT_MS = 5_000;

function rememberedOwner(chatId: string): string | undefined {
  try { return sessionStorage.getItem(`minnow.chatTurnOwner.${chatId}`) || undefined; }
  catch { return undefined; }
}

function rememberOwner(chatId: string, ownerId: string | null): void {
  try {
    if (ownerId) sessionStorage.setItem(`minnow.chatTurnOwner.${chatId}`, ownerId);
    else sessionStorage.removeItem(`minnow.chatTurnOwner.${chatId}`);
  } catch { /* A storage-disabled viewer can still run; reload waits for expiry. */ }
}

export interface ChatTurnLease {
  signal: AbortSignal;
  check(): Promise<void>;
  release(): Promise<void>;
}

export function localChatTurnLease(): ChatTurnLease {
  return { signal: new AbortController().signal, async check() {}, async release() {} };
}

async function request(action: string, chatId: string, ownerId: string, signal?: AbortSignal): Promise<LeaseGrant | null> {
  const startedAt = performance.now();
  const response = await fetch('/api/chat-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, chatId, ownerId, hostId: getChatHostId() }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 409) return null;
  if (!response.ok) throw new ChatLeaseRequestError(response.status >= 500 || response.status === 408 || response.status === 429);
  if (action === 'release') return { startedAt, leaseMs: 0 };
  const grant = await response.json().catch(() => { throw new ChatLeaseRequestError(false); });
  if (grant?.ok !== true || !Number.isFinite(grant.leaseMs) || grant.leaseMs <= 0) throw new ChatLeaseRequestError(false);
  return { startedAt, leaseMs: grant.leaseMs };
}

/** Refresh observer status without running, cancelling, or writing any chat. */
export async function refreshRemoteChatTurns(signal?: AbortSignal): Promise<boolean> {
  if (!isServerStorageMode()) return false;
  const response = await fetch('/api/chat-turns', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Could not check running chats.');
  const data = await response.json() as { turns: { chatId: string; ownerId: string }[] };
  if (!Array.isArray(data.turns)) throw new Error('Invalid running chats response.');
  return setRemoteChatTurns(data.turns.filter(turn => (owners.get(turn.chatId) ?? rememberedOwner(turn.chatId)) !== turn.ownerId)
    .map(turn => turn.chatId));
}

export async function isChatOwnedElsewhere(chatId: string): Promise<boolean> {
  if (!isServerStorageMode() || owners.has(chatId)) return false;
  await refreshRemoteChatTurns(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  return isChatRunningRemotely(chatId);
}

/** Claim before any history, model, tool, or recovery mutation. Conflicts are passive. */
export async function acquireChatTurn(chatId: string): Promise<ChatTurnLease | null> {
  if (isPairedDevice()) return null;
  if (!isServerStorageMode()) return localChatTurnLease();
  // sessionStorage survives a reload in this view, without granting another
  // device ownership of its running turn.
  const ownerId = rememberedOwner(chatId) ?? randomUUID();
  const grant = await request('claim', chatId, ownerId);
  if (!grant) {
    await refreshRemoteChatTurns(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    return null;
  }
  owners.set(chatId, ownerId);
  rememberOwner(chatId, ownerId);
  return createTurnLease({
    chatId, grant,
    request: signal => request('renew', chatId, ownerId, signal),
    diagnose: event => reportBackgroundError('chat-ownership', `Chat ${chatId}: ${event}`),
    async release() {
      if (owners.get(chatId) === ownerId) owners.delete(chatId);
      if (rememberedOwner(chatId) === ownerId) rememberOwner(chatId, null);
      await request('release', chatId, ownerId).catch(() => {});
    },
  });
}
