import type { ChatArchive, ChatArchiveImportReceipt } from '../../server/chats/archive.js';

/** Explicit contributor API; Settings backups continue to use the .mnbak flow. */
export async function exportManagedChatArchive(): Promise<ChatArchive> {
  const response = await fetch('/api/chats/archive/export', { headers: { 'X-Minnow-Chat-Protocol': '1' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Conversation export failed');
  return body.archive;
}
export async function importManagedChatArchive(input: ChatArchive | { conversationArchive: ChatArchive }): Promise<ChatArchiveImportReceipt> {
  const archive = 'conversationArchive' in input ? input.conversationArchive : input;
  const response = await fetch('/api/chats/archive/import', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Minnow-Chat-Protocol': '1' }, body: JSON.stringify({ archive }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Conversation import failed');
  return body.receipt;
}
