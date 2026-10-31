import type { Attachment } from './types';
import { getPendingAttachments, pushAttachment, replacePendingAttachments } from './store';
import { chatLink } from '../state/chat-relationships';
import { chatReferenceTitle } from '../state/chat-reference-titles';
import { chatReferencesInText } from '../ui/chat-reference-chip';
import { randomUUID } from '../lib/random-id';

/** Keep draft persistence and text-only follow-ups readable without a new storage format. */
export function withComposerChatReferences(text: string, attachments: readonly Attachment[] = getPendingAttachments()): string {
  const links = attachments.filter(item => item.kind === 'chatRef' && item.chatId)
    .map(item => chatLink(item.chatId!));
  return [text, ...links].filter(part => part.trim()).join('\n\n');
}

export function clearComposerChatReferences(): void {
  replacePendingAttachments(getPendingAttachments().filter(item => item.kind !== 'chatRef'));
}

/** Extract references into the shared chip row, preserving all other pasted text. */
export function attachChatReferences(text: string): string | null {
  const references = chatReferencesInText(text);
  if (!references.length) return null;
  const existing = new Set(getPendingAttachments().filter(item => item.kind === 'chatRef').map(item => item.chatId));
  let remaining = '';
  let end = 0;
  for (const reference of references) {
    remaining += text.slice(end, reference.start);
    end = reference.end;
    if (existing.has(reference.chatId)) continue;
    existing.add(reference.chatId);
    const attachment: Attachment = {
      id: randomUUID(), kind: 'chatRef', chatId: reference.chatId,
      name: chatReferenceTitle(reference.chatId) || `Chat · ${reference.chatId.slice(0, 8)}`,
      mimeType: 'text/uri-list', size: 0,
    };
    pushAttachment(attachment);
  }
  remaining += text.slice(end);
  return remaining.trim() ? remaining : '';
}
