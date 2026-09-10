/**
 * In-app notification inbox types (Minnow menubar bell).
 */

import type { AppId } from '../os/types';
import type { NotificationSoundCue } from './sound-packs';

/** Event kinds surfaced in the notification popover. */
export type NotificationKind =
  | 'chat_turn_complete'
  | 'chat_turn_error'
  | 'chat_tool_failure'
  | 'chat_question'
  | 'task_started'
  | 'task_complete'
  | 'task_failed'
  | 'task_quarantined'
  | 'board_complete'
  | 'board_blocked'
  | 'sub_agent_complete'
  | 'sub_agent_failed'
  | 'provider_quota'
  | 'scheduler'
  | 'research'
  | 'synthesis'
  | 'issue_agent_started'
  | 'issue_agent_question'
  | 'issue_agent_pr'
  | 'issue_agent_failed'
  | 'issue_triage';

/** One row in the session notification inbox. */
export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  /** Chat name, task title, or app label. */
  title: string;
  /** Snippet shown under the title in the popover. */
  preview: string;
  /** Deep-link into Code app when applicable. */
  chatId?: string;
  /** Fallback launch target when no chat is linked. */
  appId: AppId;
  createdAt: number;
  read: boolean;
  /** Optional dedupe key (not persisted). */
  dedupeKey?: string;
}

/** Input to {@link pushNotification}. */
export type PushNotificationInput = Omit<NotificationRecord, 'id' | 'createdAt' | 'read'> & {
  id?: string;
  createdAt?: number;
  dedupeKey?: string;
  /**
   * Also raise a native OS notification when the window is unfocused.
   *
   * Opt-in per push rather than per kind: only alerts the user genuinely must
   * not miss (an agent asking a question, a PR landing) earn a desktop toast,
   * and every existing caller keeps its current behaviour by not setting it.
   */
  os?: boolean;
};

/** Per-kind enable groups for notification prefs. */
export type NotificationKindGroup = 'chat' | 'tasks' | 'background';

/** User prefs persisted under `minnow.notifications.*`. */
export interface NotificationPrefs {
  enabled: boolean;
  /** Quick mute from the menubar dropdown; blocks new notifications until cleared. */
  muted: boolean;
  soundEnabled: boolean;
  /** Play cues while watching the active chat in Code (no bell alerts). */
  soundOnActiveChat: boolean;
  /** Active sound pack id (`none` disables playback). */
  soundPackId: string;
  chatEnabled: boolean;
  tasksEnabled: boolean;
  backgroundEnabled: boolean;
}

/** Labels for per-cue preview buttons in settings. */
export interface NotificationSoundCueOption {
  id: NotificationSoundCue;
  label: string;
}
