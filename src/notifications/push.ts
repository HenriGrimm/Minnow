/**
 * Push a notification into the inbox, respecting prefs, dedupe, sound, and bell ring.
 */

import { randomUUID } from '../lib/random-id.ts';
import { findChatById } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
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
 * Capture an Activity record; preferences only gate sound and desktop delivery.
 * Also updates legacy per-app unread badges via {@link noteAgentMessage}.
 */
export function pushNotification(input: PushNotificationInput): NotificationRecord | null {
  if (input.dedupeKey) {
    if (hasDedupeKey(input.dedupeKey)) return null;
    rememberDedupeKey(input.dedupeKey);
  }

  const chat = input.chatId ? findChatById(input.chatId) : undefined;
  const run = [...(chat?.runs ?? [])].reverse().find((candidate) => candidate.status === 'running') ?? chat?.runs?.at(-1);
  const record: NotificationRecord = {
    id: input.id ?? newId(),
    kind: input.kind,
    title: input.title,
    preview: input.preview,
    chatId: input.chatId,
    appId: input.appId,
    createdAt: input.createdAt ?? Date.now(),
    read: input.silent === true,
    dedupeKey: input.dedupeKey,
    activityId: input.activityId ?? (run ? `turn:${run.runId}` : input.chatId ? `main:${input.chatId}` : undefined),
    parentActivityId: input.parentActivityId,
    workspacePath: input.workspacePath ?? chat?.workspacePath ?? getWorkspacePath(),
    activityStatus: input.activityStatus,
    jobId: input.jobId,
    resolved: input.resolved,
  };

  appendNotification(record);

  if (input.silent || !isNotificationKindEnabled(input.kind)) return record;

  const legacyMsg = input.preview.trim() || input.title;
  noteAgentMessage(input.appId, legacyMsg);

  notifyNew(record);

  if (shouldPlayNotificationSound(input.kind, input.chatId)) {
    playNotificationSound(input.kind);
  }

  if (input.os && loadNotificationPrefs().osEnabled) {
    void notifyOs({
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

  if (onActiveChat) {
    const record = pushNotification({ ...input, silent: true });
    if (!record || input.silent || !prefs.soundOnActiveChat || !isNotificationKindEnabled(input.kind)) return record;
    if (shouldPlayNotificationSound(input.kind, input.chatId)) {
      playNotificationSound(input.kind);
    }
    return record;
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
