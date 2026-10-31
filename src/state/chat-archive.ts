import { sendRemoteChatCommand, shouldRelayChat } from '../chat/remote-chat-client';
import type { Chat } from '../types';
import { setStatus } from '../ui/status';
import { markChatDirty, scheduleSaveSessions } from './sessions';
import { isChatArchived } from './session-workspace-scope';

export { isChatArchived };

/** Archive placement preserves activity order, group membership and the transcript. */
export function setChatArchived(chat: Chat, archived: boolean): void {
  if (shouldRelayChat(chat.id)) {
    void sendRemoteChatCommand(chat.id, 'configure', { patch: { archived } })
      .catch(error => setStatus('err', String(error?.message || error)));
    return;
  }
  if (archived === isChatArchived(chat)) return;
  if (archived) chat.archivedAt = Date.now();
  else delete chat.archivedAt;
  markChatDirty(chat);
  scheduleSaveSessions();
}
