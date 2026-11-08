// Viewer state only: observing a turn never sets the local runner's streaming flag.
const remoteChatIds = new Set<string>();
const managedChatIds = new Set<string>();
type RemoteChatSource = 'legacy' | 'managed';
let revision = 0;

export function remoteChatTurnsRevision(): number { return revision; }

export function isChatRunningRemotely(chatId: string): boolean {
  return remoteChatIds.has(chatId) || managedChatIds.has(chatId);
}

export function setRemoteChatRunning(chatId: string, running: boolean, source: RemoteChatSource = 'legacy'): void {
  const ids = source === 'managed' ? managedChatIds : remoteChatIds;
  if (ids.has(chatId) === running) return;
  if (running) ids.add(chatId);
  else ids.delete(chatId);
  revision += 1;
}

/** Combined ownership reads also include managed executions, whose lifecycle comes from /api/chats/events. */
export function setRemoteChatPresence(turns: Iterable<{ chatId: string; ownerId?: string; hostId?: string }>): boolean {
  return setRemoteChatTurns([...turns]
    .filter(turn => turn.hostId !== 'minnow-server' && turn.ownerId !== 'minnow-server')
    .map(turn => turn.chatId));
}

/** A legacy lease snapshot has no authority over server-owned executions. */
export function setRemoteChatTurns(ids: Iterable<string>, source: RemoteChatSource = 'legacy'): boolean {
  const current = source === 'managed' ? managedChatIds : remoteChatIds;
  const next = new Set(ids);
  const changed = next.size !== current.size || [...next].some(id => !current.has(id));
  if (changed) revision += 1;
  current.clear();
  for (const id of next) current.add(id);
  return changed;
}
