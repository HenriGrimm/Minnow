/**
 * "Out of usage" notice — the provider refused because the allowance is spent.
 *
 * This is the one failure a long unattended run cannot recover from on its own,
 * so it earns an OS notification as well as an inbox row: the board halts, and
 * whoever left it running overnight needs to know why it stopped.
 */

import {
  formatOutOfUsageMessage,
  OUT_OF_USAGE_TITLE,
  parseQuotaResetHint,
} from '../../server/generations/quota-error.js';
import type { GenerationEndEvent } from '../api/generations';
import { showToast } from '../ui/toast';
import { pushNotification } from './push';

/**
 * One notice per reset window, not one per failed request.
 *
 * A board with two workers can burn several attempts against a spent allowance
 * before it halts; without this the user would get a notification for each.
 */
const REPEAT_SILENCE_MS = 15 * 60 * 1000;

/** null, not 0 — a zero would silence any clock whose epoch is inside the window. */
let lastAnnouncedAt: number | null = null;

/** Clear the repeat window (tests). */
export function resetOutOfUsageNoticeForTests(): void {
  lastAnnouncedAt = null;
}

function withinRepeatWindow(now: number): boolean {
  return lastAnnouncedAt !== null && now - lastAnnouncedAt < REPEAT_SILENCE_MS;
}

/**
 * Raise the "Out of usage" notice for a spent provider allowance.
 * Returns false when the notice was suppressed as a repeat.
 */
export function noticeOutOfUsage(event: GenerationEndEvent, now = Date.now()): boolean {
  if (withinRepeatWindow(now)) return false;
  lastAnnouncedAt = now;

  const detail = event.errorMessage?.trim() ?? '';
  const providerLabel = event.chosenProviderId?.trim() || null;
  const hint = parseQuotaResetHint(detail);

  pushNotification({
    kind: 'provider_quota',
    title: OUT_OF_USAGE_TITLE,
    preview: formatOutOfUsageMessage({ detail, providerLabel }),
    appId: 'code',
    dedupeKey: `provider-quota:${providerLabel ?? 'unknown'}:${Math.floor(now / REPEAT_SILENCE_MS)}`,
    os: true,
  });

  showToast(
    hint ? `${OUT_OF_USAGE_TITLE} — resets in ${hint}` : OUT_OF_USAGE_TITLE,
    'error',
    8_000,
  );
  return true;
}

/**
 * A journal event is only news while it is fresh. Opening yesterday's board
 * replays its `board.stopped` through the same path, and that is history.
 */
const BOARD_EVENT_FRESH_MS = 5 * 60 * 1000;

/**
 * Raise the notice for a board that halted because the provider is out of usage.
 * Returns false for a replayed (stale) event or a suppressed repeat.
 */
export function noticeBoardOutOfUsage(
  boardId: string,
  eventTs: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(eventTs) || now - eventTs > BOARD_EVENT_FRESH_MS) return false;
  if (withinRepeatWindow(now)) return false;
  lastAnnouncedAt = now;

  pushNotification({
    kind: 'provider_quota',
    title: OUT_OF_USAGE_TITLE,
    preview: `${boardId} stopped: the model provider is out of usage. Reopen it once the allowance resets.`,
    appId: 'code',
    dedupeKey: `provider-quota-board:${boardId}:${eventTs}`,
    os: true,
  });
  showToast(`${OUT_OF_USAGE_TITLE} — board stopped`, 'error', 8_000);
  return true;
}
