/**
 * User-facing copy for GitHub issue import/sync failures (MIN-660).
 *
 * Internal codes such as `server_off` must never reach the SPA as raw text —
 * that both reads as a broken backend and was the error the import dialog
 * used to show right before the rest of the shell looked frozen.
 */

import { OPEN_MINNOW_RETRY } from '../copy/local-session';

/** Re-export so call sites can compare against the same MIN-529 sentence. */
export { OPEN_MINNOW_RETRY };

/**
 * True when a raw error means Minnow's local backend is unreachable, not a
 * GitHub/`gh` problem the user can fix in the repo.
 */
export function isLocalServerOfflineError(message: string | undefined): boolean {
  const text = (message ?? '').trim();
  if (!text) return false;
  if (text === OPEN_MINNOW_RETRY) return true;
  if (/^server[_ -]?off$/i.test(text)) return true;
  if (/^failed to fetch$/i.test(text)) return true;
  if (/^load failed$/i.test(text)) return true;
  if (/networkerror/i.test(text)) return true;
  if (/^HTTP 50[023]$/i.test(text)) return true;
  return false;
}

/**
 * Map a forge/`gh`/network error into copy that is safe to show in a dialog.
 * Offline codes become OPEN_MINNOW_RETRY; everything else is passed through.
 */
export function userFacingGithubError(
  error: string | undefined,
  fallback = OPEN_MINNOW_RETRY,
): string {
  const text = (error ?? '').trim();
  if (!text || isLocalServerOfflineError(text)) return fallback;
  if (/timed out after/i.test(text)) {
    return 'GitHub did not respond in time. Try again.';
  }
  if (/issuesState is not initialized/i.test(text)) {
    return 'Issues are still loading. Try again in a moment.';
  }
  return text;
}
