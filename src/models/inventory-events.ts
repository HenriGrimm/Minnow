const listeners = new Set<() => void>();

export function subscribeModelInventory(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyModelInventory(): void {
  for (const listener of listeners) listener();
}
