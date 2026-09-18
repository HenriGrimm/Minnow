/**
 * Push a notification into the inbox, respecting prefs, dedupe, sound, and bell ring.
 */

import { randomUUID } from '../lib/random-id.ts';
import { noteAgentMessage } from '../os/instances';
import { shouldNotifyForChatTurn } from './background';
import { notifyOs } from './os-notification';
import { isNotificationKindEnabled, loadNotificationPrefs } from './prefs';
import { playNotificationSound, shouldPlayNotificationSound } from './sound';
import {
  appendNotification,
  hasDedupeKey,
  rememberDedupeKey,
} from './store';
import type { PushNotificationInput, NotificationRecord } from './types';

type NewNotificationListener = (record: NotificationRecord) => void;

const newListeners = new Set<NewNotificationListener>();

function newId(): string {
  return randomUUID();
}

/** Subscribe to newly pushed unread notifications (menubar bell ring). */
export function onNewNotification(listener: NewNotificationListener): () => void {
  newListeners.add(listener);
  return () => {
    newListeners.delete(listener);
  };
}

function notifyNew(record: NotificationRecord): void {
  for (const fn of newListeners) {
    try {
      fn(record);
    } catch {}
  }
}

/**
 * Insert a notification row when prefs allow it.
 * Also updates legacy per-app unread badges via {@link noteAgentMessage}.
 */
export function pushNotification(input: PushNotificationInput): NotificationRecord | null {
  if (!isNotificationKindEnabled(input.kind)) return null;

  if (input.dedupeKey) {
    if (hasDedupeKey(input.dedupeKey)) return null;
    rememberDedupeKey(input.dedupeKey);
  }

  const record: NotificationRecord = {
    id: input.id ?? newId(),
    kind: input.kind,
    title: input.title,
    preview: input.preview,
    chatId: input.chatId,
    appId: input.appId,
    createdAt: input.createdAt ?? Date.now(),
    read: false,
    dedupeKey: input.dedupeKey,
  };

  appendNotification(record);

  const legacyMsg = input.preview.trim() || input.title;
  noteAgentMessage(input.appId, legacyMsg);

  notifyNew(record);

  if (shouldPlayNotificationSound(input.kind, input.chatId)) {
    playNotificationSound(input.kind);
  }

  if (input.os && loadNotificationPrefs().osEnabled) {
    notifyOs({
      title: record.title,
      body: record.preview,
      tag: record.dedupeKey ?? record.id,
      onClick: () => {
        void import('./navigate').then((m) => m.openNotificationTarget(record));
      },
    });
  }

  return record;
}

/**
 * Push a bell alert, or play a sound only when the user is watching this chat in Code.
 * Turn-complete and error events stay silent on the active chat unless
 * {@link NotificationPrefs.soundOnActiveChat} is enabled.
 */
export function pushNotificationOrActiveChatSound(
  input: PushNotificationInput,
): NotificationRecord | null {
  const onActiveChat = Boolean(input.chatId && !shouldNotifyForChatTurn(input.chatId));
  const prefs = loadNotificationPrefs();

  if (onActiveChat && prefs.soundOnActiveChat) {
    if (!isNotificationKindEnabled(input.kind)) return null;
    if (shouldPlayNotificationSound(input.kind, input.chatId)) {
      playNotificationSound(input.kind);
    }
    return null;
  }

  if (
    onActiveChat &&
    (input.kind === 'chat_turn_complete' || input.kind === 'chat_turn_error')
  ) {
    return null;
  }

  return pushNotification(input);
}

/** Convenience wrapper matching legacy `noteAgentMessage` signature. */
export function pushLegacyAgentNotification(
  appId: PushNotificationInput['appId'],
  msg: string,
  kind: PushNotificationInput['kind'] = 'scheduler',
  title?: string,
): NotificationRecord | null {
  return pushNotification({
    kind,
    title: title ?? appId,
    preview: msg,
    appId,
  });
}

/** Expose prefs gate for tests. */
export function isPushEnabled(): boolean {
  const prefs = loadNotificationPrefs();
  return prefs.enabled && !prefs.muted;
}
