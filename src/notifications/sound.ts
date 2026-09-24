/**
 * Play notification sounds via bundled sound packs under `public/sounds/packs/`.
 */

import { isMinnowElectronShell } from '../tools/minnow-shell';
import { shouldNotifyForChatTurn } from './background';
import { loadNotificationPrefs } from './prefs';
import {
  NONE_SOUND_PACK_ID,
  NOTIFICATION_SOUND_PACKS,
  resolveNotificationCueUrl,
  resolveNotificationSoundUrl,
  type NotificationSoundCue,
} from './sound-packs';
import type { NotificationKind } from './types';

/** Per-cue preview labels for the settings UI. */
export const NOTIFICATION_SOUND_CUES: readonly { id: NotificationSoundCue; label: string }[] = [
  { id: 'turn_complete', label: 'Turn complete' },
  { id: 'question', label: 'Question' },
  { id: 'tool_turn', label: 'Tool turn' },
  { id: 'timer', label: 'Timer' },
];

let audioUnlocked = false;
let notificationAudio: HTMLAudioElement | null = null;
let unlockListenersInstalled = false;

function getOrCreateNotificationAudio(): HTMLAudioElement {
  if (!notificationAudio) {
    notificationAudio = new Audio();
  }
  return notificationAudio;
}

/** Unlock autoplay after the first user gesture anywhere in the app. */
export function unlockNotificationAudio(): void {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const audio = getOrCreateNotificationAudio();
    const defaultPack = NOTIFICATION_SOUND_PACKS[0];
    const url = defaultPack?.cues.turn_complete;
    if (!url) return;
    audio.src = url;
    audio.volume = 0;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = 0.65;
      })
      .catch(() => {
      });
  } catch {}
}

/**
 * Wire one-time pointer/keyboard listeners so notification audio can autoplay later.
 * Safe to call multiple times; listeners are installed once.
 */
export function initNotificationAudioUnlock(): void {
  if (unlockListenersInstalled || typeof document === 'undefined') return;
  unlockListenersInstalled = true;
  const unlock = () => unlockNotificationAudio();
  document.addEventListener('pointerdown', unlock, { once: true, capture: true });
  document.addEventListener('keydown', unlock, { once: true, capture: true });
}

/** True when sound should play for a new notification. */
export function shouldPlayNotificationSound(
  kind?: NotificationKind,
  chatId?: string,
): boolean {
  const prefs = loadNotificationPrefs();
  if (!prefs.enabled || prefs.muted || !prefs.soundEnabled) return false;
  if (prefs.soundPackId === NONE_SOUND_PACK_ID) return false;
  if (typeof document === 'undefined') return false;

  const onActiveChat =
    prefs.soundOnActiveChat && Boolean(chatId && !shouldNotifyForChatTurn(chatId));

  if (!onActiveChat) {
    if (kind !== 'chat_question' && document.hasFocus()) return false;
  }

  if (isMinnowElectronShell()) return true;
  return document.visibilityState === 'visible';
}

/** Play the cue for a notification kind from the active sound pack. */
export function playNotificationSound(kind: NotificationKind): void {
  const prefs = loadNotificationPrefs();
  const url = resolveNotificationSoundUrl(prefs.soundPackId, kind);
  if (!url) return;

  try {
    const audio = getOrCreateNotificationAudio();
    audio.src = url;
    audio.volume = 0.65;
    void audio.play().catch(() => {
    });
  } catch {}
}

/** Preview one cue from a pack in settings (always attempts playback). */
export function previewNotificationSoundCue(packId: string, cue: NotificationSoundCue): void {
  unlockNotificationAudio();
  const url = resolveNotificationCueUrl(packId, cue);
  if (!url) return;

  try {
    const audio = getOrCreateNotificationAudio();
    audio.src = url;
    audio.volume = 0.75;
    void audio.play().catch(() => {
    });
  } catch {}
}

/** Reset module state (tests). */
export function resetNotificationSoundForTests(): void {
  audioUnlocked = false;
  notificationAudio = null;
  unlockListenersInstalled = false;
}
