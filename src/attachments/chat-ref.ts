import type { Attachment } from './types';
import { getPendingAttachments, replacePendingAttachments } from './store';
import { chatLink } from '../state/chat-relationships';

/** Keep draft persistence and text-only follow-ups readable without a new storage format. */
export function withComposerChatReferences(text: string, attachments: readonly Attachment[] = getPendingAttachments()): string {
  const links = attachments.filter(item => item.kind === 'chatRef' && item.chatId)
    .map(item => chatLink(item.chatId!));
  return [text, ...links].filter(part => part.trim()).join('\n\n');
}

export function clearComposerChatReferences(): void {
  replacePendingAttachments(getPendingAttachments().filter(item => item.kind !== 'chatRef'));
}
