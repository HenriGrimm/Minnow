/**
 * Notification sound packs: bundled assets under `public/sounds/packs/<packId>/`.
 * Each pack maps event cues to audio files; notification kinds resolve to a cue.
 */

import type { NotificationKind } from './types';

/** Playback roles within a sound pack. */
export type NotificationSoundCue = 'turn_complete' | 'question' | 'tool_turn';

/** One installable notification sound pack. */
export interface NotificationSoundPack {
  id: string;
  label: string;
  /** Relative URLs under `public/` for each cue. */
  cues: Record<NotificationSoundCue, string>;
}

/** Sentinel value when the user disables sound packs. */
export const NONE_SOUND_PACK_ID = 'none';

/** Built-in packs shipped with Minnow. Add entries + assets to extend. */
export const NOTIFICATION_SOUND_PACKS: readonly NotificationSoundPack[] = [
  {
    id: 'default',
    label: 'Minnow',
    cues: {
      turn_complete: './sounds/packs/default/turn-complete.wav',
      question: './sounds/packs/default/question.wav',
      tool_turn: './sounds/packs/default/tool-turn.mp3',
    },
  },
];

/** Picker options for settings (includes "None"). */
export const NOTIFICATION_SOUND_PACK_OPTIONS: readonly {
  id: string;
  label: string;
}[] = [
  ...NOTIFICATION_SOUND_PACKS.map((pack) => ({ id: pack.id, label: pack.label })),
  { id: NONE_SOUND_PACK_ID, label: 'None' },
];

/** Map each notification kind to the cue played from the active pack. */
export const NOTIFICATION_KIND_TO_CUE: Record<NotificationKind, NotificationSoundCue> = {
  chat_turn_complete: 'turn_complete',
  chat_turn_error: 'tool_turn',
  chat_tool_failure: 'tool_turn',
  chat_question: 'question',
  task_started: 'tool_turn',
  task_complete: 'turn_complete',
  task_failed: 'tool_turn',
  task_quarantined: 'tool_turn',
  board_complete: 'turn_complete',
  board_blocked: 'tool_turn',
  sub_agent_complete: 'turn_complete',
  sub_agent_failed: 'tool_turn',
  provider_quota: 'tool_turn',
  scheduler: 'turn_complete',
  research: 'turn_complete',
  synthesis: 'turn_complete',
  issue_agent_started: 'tool_turn',
  issue_agent_question: 'question',
  issue_agent_pr: 'turn_complete',
  issue_agent_failed: 'tool_turn',
  issue_triage: 'tool_turn',
};

/** Resolve a pack by id. */
export function getNotificationSoundPack(id: string): NotificationSoundPack | undefined {
  return NOTIFICATION_SOUND_PACKS.find((pack) => pack.id === id);
}

/** Resolve the audio URL for a notification kind within a pack. */
export function resolveNotificationSoundUrl(
  packId: string,
  kind: NotificationKind,
): string | undefined {
  if (packId === NONE_SOUND_PACK_ID) return undefined;
  const pack = getNotificationSoundPack(packId);
  if (!pack) return undefined;
  const cue = NOTIFICATION_KIND_TO_CUE[kind];
  return pack.cues[cue];
}

/** Resolve preview URL for a cue within a pack (settings preview buttons). */
export function resolveNotificationCueUrl(
  packId: string,
  cue: NotificationSoundCue,
): string | undefined {
  if (packId === NONE_SOUND_PACK_ID) return undefined;
  const pack = getNotificationSoundPack(packId);
  return pack?.cues[cue];
}
