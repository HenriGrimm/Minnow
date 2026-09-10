/**
 * Notification prefs persisted in localStorage (`minnow.notifications.*`).
 */

import { NONE_SOUND_PACK_ID } from './sound-packs';
import type { NotificationKind, NotificationKindGroup, NotificationPrefs } from './types';

const STORAGE_PREFIX = 'minnow.notifications.';

export const NOTIFICATION_PREFS_KEYS = {
  enabled: `${STORAGE_PREFIX}enabled`,
  muted: `${STORAGE_PREFIX}muted`,
  soundEnabled: `${STORAGE_PREFIX}soundEnabled`,
  soundOnActiveChat: `${STORAGE_PREFIX}soundOnActiveChat`,
  soundPackId: `${STORAGE_PREFIX}soundPackId`,
  /** @deprecated Migrated to `soundPackId` on read. */
  soundId: `${STORAGE_PREFIX}soundId`,
  chatEnabled: `${STORAGE_PREFIX}chatEnabled`,
  tasksEnabled: `${STORAGE_PREFIX}tasksEnabled`,
  backgroundEnabled: `${STORAGE_PREFIX}backgroundEnabled`,
} as const;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  muted: false,
  soundEnabled: true,
  soundOnActiveChat: false,
  soundPackId: 'default',
  chatEnabled: true,
  tasksEnabled: true,
  backgroundEnabled: true,
};

type PrefsListener = (prefs: NotificationPrefs) => void;

const listeners = new Set<PrefsListener>();
let cachedPrefs: NotificationPrefs | null = null;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
  } catch {}
  return fallback;
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {}
}

function readString(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null && raw.trim()) return raw.trim();
  } catch {}
  return fallback;
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Migrate legacy single-sound `soundId` to `soundPackId`. */
function readSoundPackId(): string {
  const packId = readString(
    NOTIFICATION_PREFS_KEYS.soundPackId,
    DEFAULT_NOTIFICATION_PREFS.soundPackId,
  );
  if (localStorage.getItem(NOTIFICATION_PREFS_KEYS.soundPackId)) {
    return packId;
  }

  const legacySoundId = readString(NOTIFICATION_PREFS_KEYS.soundId, '');
  if (legacySoundId === 'none') return NONE_SOUND_PACK_ID;
  if (legacySoundId) return 'default';
  return DEFAULT_NOTIFICATION_PREFS.soundPackId;
}

/** Load notification prefs (cached after first read). */
export function loadNotificationPrefs(): NotificationPrefs {
  if (cachedPrefs) return { ...cachedPrefs };

  const legacySoundId = readString(NOTIFICATION_PREFS_KEYS.soundId, '');
  const soundPackId = readSoundPackId();
  const legacySoundWasNone = legacySoundId === 'none' && !localStorage.getItem(NOTIFICATION_PREFS_KEYS.soundPackId);

  const prefs: NotificationPrefs = {
    enabled: readBool(NOTIFICATION_PREFS_KEYS.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    muted: readBool(NOTIFICATION_PREFS_KEYS.muted, DEFAULT_NOTIFICATION_PREFS.muted),
    soundEnabled: legacySoundWasNone
      ? false
      : readBool(NOTIFICATION_PREFS_KEYS.soundEnabled, DEFAULT_NOTIFICATION_PREFS.soundEnabled),
    soundOnActiveChat: readBool(
      NOTIFICATION_PREFS_KEYS.soundOnActiveChat,
      DEFAULT_NOTIFICATION_PREFS.soundOnActiveChat,
    ),
    soundPackId,
    chatEnabled: readBool(
      NOTIFICATION_PREFS_KEYS.chatEnabled,
      DEFAULT_NOTIFICATION_PREFS.chatEnabled,
    ),
    tasksEnabled: readBool(
      NOTIFICATION_PREFS_KEYS.tasksEnabled,
      DEFAULT_NOTIFICATION_PREFS.tasksEnabled,
    ),
    backgroundEnabled: readBool(
      NOTIFICATION_PREFS_KEYS.backgroundEnabled,
      DEFAULT_NOTIFICATION_PREFS.backgroundEnabled,
    ),
  };
  cachedPrefs = prefs;
  return { ...prefs };
}

function emitPrefs(): void {
  const prefs = loadNotificationPrefs();
  for (const fn of listeners) {
    try {
      fn({ ...prefs });
    } catch {}
  }
}

/** Persist all notification prefs and notify subscribers. */
export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  writeBool(NOTIFICATION_PREFS_KEYS.enabled, prefs.enabled);
  writeBool(NOTIFICATION_PREFS_KEYS.muted, prefs.muted);
  writeBool(NOTIFICATION_PREFS_KEYS.soundEnabled, prefs.soundEnabled);
  writeBool(NOTIFICATION_PREFS_KEYS.soundOnActiveChat, prefs.soundOnActiveChat);
  writeString(NOTIFICATION_PREFS_KEYS.soundPackId, prefs.soundPackId);
  writeBool(NOTIFICATION_PREFS_KEYS.chatEnabled, prefs.chatEnabled);
  writeBool(NOTIFICATION_PREFS_KEYS.tasksEnabled, prefs.tasksEnabled);
  writeBool(NOTIFICATION_PREFS_KEYS.backgroundEnabled, prefs.backgroundEnabled);
  cachedPrefs = { ...prefs };
  emitPrefs();
}

/** Persist one pref key and notify subscribers. */
export function saveNotificationPref<K extends keyof NotificationPrefs>(
  key: K,
  value: NotificationPrefs[K],
): void {
  const next = { ...loadNotificationPrefs(), [key]: value };
  saveNotificationPrefs(next);
}

/** Subscribe to pref changes; returns unsubscribe. */
export function subscribeNotificationPrefs(listener: PrefsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const KIND_GROUP: Record<NotificationKind, NotificationKindGroup> = {
  chat_turn_complete: 'chat',
  chat_turn_error: 'chat',
  chat_tool_failure: 'chat',
  chat_question: 'chat',
  task_started: 'tasks',
  task_complete: 'tasks',
  task_failed: 'tasks',
  task_quarantined: 'tasks',
  board_complete: 'tasks',
  board_blocked: 'tasks',
  sub_agent_complete: 'tasks',
  sub_agent_failed: 'tasks',
  provider_quota: 'background',
  scheduler: 'background',
  research: 'background',
  synthesis: 'background',
  issue_agent_started: 'tasks',
  issue_agent_question: 'tasks',
  issue_agent_pr: 'tasks',
  issue_agent_failed: 'tasks',
  issue_triage: 'background',
};

/** True when prefs allow pushing this notification kind. */
export function isNotificationKindEnabled(kind: NotificationKind, prefs = loadNotificationPrefs()): boolean {
  if (!prefs.enabled || prefs.muted) return false;
  const group = KIND_GROUP[kind];
  if (group === 'chat') return prefs.chatEnabled;
  if (group === 'tasks') return prefs.tasksEnabled;
  return prefs.backgroundEnabled;
}

/** Clear cached prefs and listeners (tests). */
export function resetNotificationPrefsForTests(): void {
  cachedPrefs = null;
  listeners.clear();
}
