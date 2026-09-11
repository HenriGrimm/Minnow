import { APPEARANCE_STORAGE_KEYS } from './types';
import { scheduleAppearancePersist } from './persist-schedule';

export type ChatView = 'compact' | 'full';
export const CHAT_VIEW_CHANGED = 'minnow:chat-view-changed';

export function getChatView(): ChatView {
  try {
    return localStorage.getItem(APPEARANCE_STORAGE_KEYS.chatView) === 'full' ? 'full' : 'compact';
  } catch {
    return 'compact';
  }
}

export function setChatView(view: ChatView): void {
  try { localStorage.setItem(APPEARANCE_STORAGE_KEYS.chatView, view); } catch {}
  scheduleAppearancePersist();
  window.dispatchEvent(new window.CustomEvent(CHAT_VIEW_CHANGED));
}
