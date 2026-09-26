/**
 * Ephemeral provenance for instructions delivered by a paired device to a host-owned turn.
 * While marked, mutating tools keep the companion's per-call approval policy even though
 * execution is physically happening in the privileged desktop renderer.
 */

const REMOTE_AUTHORITY_IDLE_GRACE_MS = 10_000;
const remotelyControlledChats = new Map<string, number>();

export function markCompanionControlledChat(chatId: string, now = Date.now()): void {
  const id = chatId.trim();
  if (!id) return;
  remotelyControlledChats.set(id, now);
}

export function companionCommandRequiresApproval(chatId?: string): boolean {
  const id = chatId?.trim();
  return Boolean(id && remotelyControlledChats.has(id));
}

/** Clear provenance after the controlled turn and any queued follow-up are safely idle. */
export function clearCompanionControlledChatIfIdle(
  chatId: string,
  idle: boolean,
  now = Date.now(),
): boolean {
  const markedAt = remotelyControlledChats.get(chatId);
  if (markedAt == null || !idle || now - markedAt < REMOTE_AUTHORITY_IDLE_GRACE_MS) return false;
  remotelyControlledChats.delete(chatId);
  return true;
}

export function resetCompanionRemoteAuthorityForTests(): void {
  remotelyControlledChats.clear();
}
