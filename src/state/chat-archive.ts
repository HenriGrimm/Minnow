import { sendRemoteChatCommand, shouldRelayChat } from '../chat/remote-chat-client';
import type { Chat } from '../types';
import { setStatus } from '../ui/status';
import { findChatById, markChatDirty, scheduleSaveSessions } from './sessions';
import { isChatArchived, setPendingChatArchive } from './session-workspace-scope';

export { isChatArchived };

const pending = new Map<string, Promise<void>>();

/** Archive placement preserves activity order, group membership and the transcript. */
export function setChatArchived(chat: Chat, archived: boolean): void {
  if (archived === isChatArchived(chat)) return;
  if (shouldRelayChat(chat.id)) {
    setPendingChatArchive(chat.id, archived);
    // Serialize Undo with its archive; responses must commit in click order.
    const work = (pending.get(chat.id) ?? Promise.resolve()).then(async () => {
      try {
        await sendRemoteChatCommand(chat.id, 'configure', { patch: { archived } });
        const current = findChatById(chat.id) ?? chat;
        if (archived) current.archivedAt ||= Date.now();
        else delete current.archivedAt;
      } catch (error) {
        setStatus('err', String((error as Error)?.message || error));
      }
    }).finally(() => {
      if (pending.get(chat.id) !== work) return;
      pending.delete(chat.id);
      setPendingChatArchive(chat.id, undefined);
      void import('../ui/sidebar').then(({ scheduleRenderSidebar }) => scheduleRenderSidebar());
    });
    pending.set(chat.id, work);
    return;
  }
  if (archived) chat.archivedAt = Date.now();
  else delete chat.archivedAt;
  markChatDirty(chat);
  scheduleSaveSessions();
}
