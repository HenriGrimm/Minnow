import { isServerStorageMode } from '../config/storage-mode';
import { randomUUID } from '../lib/random-id';
import { isChatRunningRemotely, setRemoteChatTurns } from './remote-turn-state';

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

async function request(action: string, chatId: string, ownerId: string): Promise<boolean> {
  const response = await fetch('/api/chat-turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, chatId, ownerId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error('Could not check which device is running this chat.');
  return true;
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
  const controller = new AbortController();
  if (!isServerStorageMode()) return localChatTurnLease();
  // sessionStorage survives a reload in this view, without granting another
  // device ownership of its running turn.
  const ownerId = rememberedOwner(chatId) ?? randomUUID();
  if (!await request('claim', chatId, ownerId)) {
    await refreshRemoteChatTurns(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    return null;
  }
  owners.set(chatId, ownerId);
  rememberOwner(chatId, ownerId);
  let released = false;
  let renewedAt = Date.now();
  let renewing: Promise<void> | null = null;
  const renew = (): Promise<void> => {
    if (renewing) return renewing;
    renewing = (async () => {
      try {
        if (!await request('renew', chatId, ownerId)) throw new Error('Chat ownership was lost.');
        renewedAt = Date.now();
      } catch (error) {
        controller.abort();
        throw error;
      } finally { renewing = null; }
    })();
    return renewing;
  };
  const timer = setInterval(() => { void renew().catch(() => {}); }, 5_000);
  return {
    signal: controller.signal,
    async check() {
      if (!released && !controller.signal.aborted && Date.now() - renewedAt >= 5_000) {
        await renew().catch(() => {});
      }
      if (released || controller.signal.aborted) throw new DOMException('Chat ownership was lost', 'AbortError');
    },
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await renewing?.catch(() => {});
      if (owners.get(chatId) === ownerId) owners.delete(chatId);
      if (rememberedOwner(chatId) === ownerId) rememberOwner(chatId, null);
      await request('release', chatId, ownerId).catch(() => {});
    },
  };
}
