/**
 * Renderer wrapper for the auto-update bridge (MIN-384) plus pure display helpers
 * shared by Settings → General → App updates and the menubar update pill.
 */

import type {
  MinnowUpdaterApi,
  MinnowUpdaterStatus,
} from '../electron.d.ts';

export type { MinnowUpdaterApi, MinnowUpdaterStatus } from '../electron.d.ts';

/** The updater bridge, or null in browser tabs and shells built before MIN-384. */
export function getUpdaterApi(): MinnowUpdaterApi | null {
  return window.minnow?.updater ?? null;
}

/**
 * Fetch the current status once, then follow status-changed events.
 * The callback never fires after the returned cleanup runs.
 */
export function watchUpdaterStatus(
  callback: (status: MinnowUpdaterStatus) => void,
): () => void {
  const api = getUpdaterApi();
  if (!api) return () => {};

  let stopped = false;
  const unsubscribe = api.onStatusChanged((status) => {
    if (!stopped) callback(status);
  });
  void api.getStatus().then((status) => {
    if (!stopped && status) callback(status);
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

/** Visual tone for the status strip dot / menubar pill. */
export type UpdaterStripTone = 'ok' | 'busy' | 'ready' | 'warn' | 'muted';

export interface UpdaterStripView {
  tone: UpdaterStripTone;
  label: string;
}

/** Status-strip copy per MIN-384 content table. `online` comes from navigator.onLine. */
export function describeUpdaterStrip(
  status: MinnowUpdaterStatus,
  online: boolean,
): UpdaterStripView {
  switch (status.state) {
    case 'checking':
      return { tone: 'busy', label: 'Checking for updates…' };
    case 'downloading': {
      const percent = status.progressPercent ?? 0;
      const version = status.pendingVersion ?? 'update';
      return { tone: 'busy', label: `Downloading ${version} · ${percent}%` };
    }
    case 'ready':
      return {
        tone: 'ready',
        label: `Restart to update — ${status.pendingVersion ?? 'new version'} is ready`,
      };
    case 'error':
      if (!online) {
        return { tone: 'muted', label: 'Offline. Will retry when you are back online.' };
      }
      return { tone: 'warn', label: 'Could not check for updates' };
    case 'unsupported':
      return { tone: 'muted', label: 'Updates unavailable' };
    case 'idle':
      return { tone: 'ok', label: `Up to date — version ${status.installedVersion}` };
  }
}

/** "Last checked" copy: Never / Just now / Today at 11:04 PM / Jul 3 at 11:04 PM. */
export function formatLastChecked(lastCheckedAt: number | null, now = Date.now()): string {
  if (lastCheckedAt == null) return 'Never';
  const ageMs = now - lastCheckedAt;
  if (ageMs < 90_000) return 'Just now';

  const then = new Date(lastCheckedAt);
  const today = new Date(now);
  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate()
  ) {
    return `Today at ${time}`;
  }
  const day = then.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} at ${time}`;
}

/** "Next automatic check" copy: — / Within the hour / In about N hours. */
export function formatNextCheck(nextCheckAt: number | null, now = Date.now()): string {
  if (nextCheckAt == null) return '—';
  const deltaMs = nextCheckAt - now;
  if (deltaMs <= 0) return 'Soon';
  const hours = Math.round(deltaMs / 3_600_000);
  if (hours < 1) return 'Within the hour';
  return `In about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function releaseNoteLineToText(line: string): string {
  return line
    .replace(/^\s*[-*+]\s+/u, '')
    .replace(/^\s*\d+[.)]\s+/u, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`]+/gu, '')
    .trim();
}

/** First useful release-note lines for the menubar popover excerpt. */
export function releaseNotesExcerpt(notes: string | null, maxLines = 3): string[] {
  if (!notes) return [];
  const result: string[] = [];
  for (const rawLine of notes.split('\n')) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s+/u.test(line) || /^[-*_]{3,}$/u.test(line)) continue;
    const text = releaseNoteLineToText(line);
    if (!text || /^(?:full changelog|install(?:ation)?):?$/iu.test(text)) continue;
    result.push(text);
    if (result.length >= maxLines) break;
  }
  return result;
}
