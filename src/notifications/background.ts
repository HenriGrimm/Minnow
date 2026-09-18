/**
 * Decide when a chat turn event should surface as a menubar notification.
 */

import { isStreamDomVisible } from '../chat/streaming-state';
import { getForegroundAppId, getOsView } from '../os/instances';
import { getActiveChat } from '../state/sessions';
import { isWindowUnfocused } from './os-notification';

/**
 * True when the user is not actively watching this chat's transcript in Code/Chat.
 * Differs from {@link isStreamDomVisible}: that helper also returns true on Desktop
 * and non-Code apps when the active sidebar chat matches, which would wrongly suppress alerts.
 * An unfocused window counts as not watching: the chat may be on screen, but the
 * user has switched to another app and is waiting to be told it is done.
 */
export function shouldNotifyForChatTurn(chatId: string): boolean {
  if (isWindowUnfocused()) return true;

  const active = getActiveChat();
  if (active.id !== chatId) return true;

  if (getOsView() === 'workspaces') return true;

  const fgApp = getForegroundAppId();
  if (getOsView() === 'app' && fgApp && fgApp !== 'code') {
    return true;
  }

  return !isStreamDomVisible(chatId);
}
