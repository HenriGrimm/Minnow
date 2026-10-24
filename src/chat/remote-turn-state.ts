// Viewer state only: observing a turn never sets the local runner's streaming flag.
const remoteChatIds = new Set<string>();
let revision = 0;

export function remoteChatTurnsRevision(): number { return revision; }

export function isChatRunningRemotely(chatId: string): boolean {
  return remoteChatIds.has(chatId);
}

export function setRemoteChatTurns(ids: Iterable<string>): boolean {
  const next = new Set(ids);
  const changed = next.size !== remoteChatIds.size || [...next].some(id => !remoteChatIds.has(id));
  if (changed) revision += 1;
  remoteChatIds.clear();
  for (const id of next) remoteChatIds.add(id);
  return changed;
}
