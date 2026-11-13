let mountedChatId = '';
const listeners = new Set<(chatId: string) => void>();
export interface ManagedChatMetadataChange { baseline?: boolean }
const metadataListeners = new Set<(chatId: string, metadata?: ManagedChatMetadataChange) => void>();
export function notifyManagedChatMetadata(chatId: string, metadata?: ManagedChatMetadataChange): void {
  for (const listener of metadataListeners) { try { listener(chatId, metadata); } catch (error) { console.error('[chats] metadata view update failed', error); } }
}
export function subscribeManagedChatMetadata(listener: (chatId: string, metadata?: ManagedChatMetadataChange) => void): () => void {
  metadataListeners.add(listener); return () => metadataListeners.delete(listener);
}
export function notifyManagedChatView(chatId: string): void {
  if (mountedChatId === chatId) return;
  mountedChatId = chatId;
  for (const listener of listeners) listener(chatId);
}
export function getManagedChatView(): string { return mountedChatId; }
export function subscribeManagedChatView(listener: (chatId: string) => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}

let embeddedChatId = '';
const embeddedListeners = new Set<() => void>();
export function getEmbeddedManagedChatView(): string { return embeddedChatId; }
export function setEmbeddedManagedChatView(chatId: string): void {
  if (embeddedChatId === chatId) return;
  embeddedChatId = chatId;
  for (const listener of embeddedListeners) listener();
}
export function subscribeEmbeddedManagedChatView(listener: () => void): () => void {
  embeddedListeners.add(listener);
  return () => embeddedListeners.delete(listener);
}
