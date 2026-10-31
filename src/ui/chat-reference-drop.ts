import { CHAT_DRAG_MIME } from '../attachments/chat-drag';
import { chatLink, chatReadOnlyReason } from '../state/chat-relationships';
import { sessionState } from '../state/sessions';
import { flushComposerDraftSessionSave, persistComposerDraftOnChat } from './composer-draft';
import { getActiveComposerSurface } from './composer-surface';

export function hasChatDrag(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && Array.from(transfer.types).includes(CHAT_DRAG_MIME));
}

/** Add a reference to an unsent draft without opening or sending either chat. */
export function applyChatReferenceDrop(
  transfer: DataTransfer | null,
  targetId = sessionState?.activeId,
  input?: HTMLTextAreaElement | null,
): boolean {
  if (!hasChatDrag(transfer)) return false;
  const sourceId = transfer!.getData(CHAT_DRAG_MIME).trim();
  const source = sessionState?.chats.find(chat => chat.id === sourceId);
  const target = sessionState?.chats.find(chat => chat.id === targetId);
  if (!source || !target || source.id === target.id || chatReadOnlyReason(target)) return false;
  const field = target.id === sessionState?.activeId ? input ?? getActiveComposerSurface().inputEl : null;
  if (field?.disabled || field?.readOnly) return false;
  const link = chatLink(source.id);
  if (field) {
    const value = field.value;
    if (!value.split(/\s+/).includes(link)) {
      const start = field.selectionStart;
      const before = value.slice(0, start);
      const after = value.slice(field.selectionEnd);
      const insert = `${before && !/\s$/.test(before) ? '\n' : ''}${link}${after && !/^\s/.test(after) ? '\n' : ''}`;
      field.setRangeText(insert, start, field.selectionEnd, 'end');
      field.dispatchEvent(new (field.ownerDocument.defaultView!).Event('input', { bubbles: true }));
    }
    persistComposerDraftOnChat(target, field.value);
    field.focus();
  } else {
    const draft = target.composerDraft ?? '';
    if (!draft.split(/\s+/).includes(link)) {
      persistComposerDraftOnChat(target, `${draft}${draft && !draft.endsWith('\n') ? '\n' : ''}${link}`);
    }
  }
  flushComposerDraftSessionSave(target.id);
  return true;
}
