export type UpdaterChannel = 'stable' | 'beta';

export type UpdaterUnsupportedReason = 'dev' | 'macos-signing';

export type UpdaterStateName =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdaterStatus {
  state: UpdaterStateName;
  supported: boolean;
  unsupportedReason: UpdaterUnsupportedReason | null;
  installedVersion: string;
  channel: UpdaterChannel;
  pendingVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number | null;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  errorMessage: string | null;
}

export type UpdaterEvent =
  | { kind: 'check-started'; manual: boolean; at: number }
  | { kind: 'update-available'; version: string; notes: string | null; at: number }
  | { kind: 'update-not-available'; at: number }
  | { kind: 'download-progress'; percent: number }
  | { kind: 'update-downloaded'; version: string; notes: string | null; at: number }
  | { kind: 'check-error'; message: string; manual: boolean; at: number }
  | { kind: 'channel-changed'; channel: UpdaterChannel }
  | { kind: 'next-check-scheduled'; at: number };

export const UPDATER_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function normalizeUpdaterChannel(value: unknown): UpdaterChannel {
  return value === 'beta' ? 'beta' : 'stable';
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, (entity, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(point) && point >= 0 && point <= 0x10ffff) {
        return String.fromCodePoint(point);
      }
      return entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function htmlReleaseNotesToMarkdown(value: string): string {
  return value
    .replace(/<\s*br\s*\/?\s*>/giu, '\n')
    .replace(/<\s*li(?:\s[^>]*)?>/giu, '- ')
    .replace(/<\s*\/\s*li\s*>/giu, '\n')
    .replace(/<\s*h([1-6])(?:\s[^>]*)?>/giu, (_match, level: string) => `${'#'.repeat(Number(level))} `)
    .replace(/<\s*\/\s*(?:h[1-6]|p|div|section|ul|ol)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
}

export function releaseNotesToText(notes: unknown): string | null {
  const parts: string[] = [];
  if (typeof notes === 'string') {
    parts.push(notes);
  } else if (Array.isArray(notes)) {
    for (const item of notes) {
      if (item && typeof item === 'object' && typeof (item as { note?: unknown }).note === 'string') {
        parts.push((item as { note: string }).note);
      }
    }
  }
  const text = decodeHtmlEntities(htmlReleaseNotesToMarkdown(parts.join('\n')))
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

export function createInitialUpdaterStatus(options: {
  supported: boolean;
  unsupportedReason?: UpdaterUnsupportedReason | null;
  installedVersion: string;
  channel: UpdaterChannel;
}): UpdaterStatus {
  return {
    state: options.supported ? 'idle' : 'unsupported',
    supported: options.supported,
    unsupportedReason: options.supported ? null : (options.unsupportedReason ?? 'dev'),
    installedVersion: options.installedVersion,
    channel: options.channel,
    pendingVersion: null,
    releaseNotes: null,
    progressPercent: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    errorMessage: null,
  };
}

export function reduceUpdaterStatus(status: UpdaterStatus, event: UpdaterEvent): UpdaterStatus {
  if (!status.supported) {
    if (event.kind === 'channel-changed') return { ...status, channel: event.channel };
    return status;
  }

  switch (event.kind) {
    case 'check-started':
      if (status.state === 'ready' || status.state === 'downloading') return status;
      return { ...status, state: 'checking', errorMessage: null };

    case 'update-available':
      if (status.state === 'ready') return status;
      return {
        ...status,
        state: 'downloading',
        pendingVersion: event.version,
        releaseNotes: event.notes,
        progressPercent: 0,
        lastCheckedAt: event.at,
        errorMessage: null,
      };

    case 'update-not-available':
      if (status.state === 'ready' || status.state === 'downloading') {
        return { ...status, lastCheckedAt: event.at };
      }
      return {
        ...status,
        state: 'idle',
        pendingVersion: null,
        releaseNotes: null,
        progressPercent: null,
        lastCheckedAt: event.at,
        errorMessage: null,
      };

    case 'download-progress':
      if (status.state === 'ready') return status;
      return {
        ...status,
        state: 'downloading',
        progressPercent: Math.max(0, Math.min(100, Math.round(event.percent))),
      };

    case 'update-downloaded':
      return {
        ...status,
        state: 'ready',
        pendingVersion: event.version,
        releaseNotes: event.notes ?? status.releaseNotes,
        progressPercent: 100,
        lastCheckedAt: event.at,
        errorMessage: null,
      };

    case 'check-error':
      if (status.state === 'ready') return { ...status, lastCheckedAt: event.at };
      if (!event.manual) {
        return {
          ...status,
          state: 'idle',
          progressPercent: null,
          lastCheckedAt: event.at,
          errorMessage: null,
        };
      }
      return {
        ...status,
        state: 'error',
        progressPercent: null,
        lastCheckedAt: event.at,
        errorMessage: event.message,
      };

    case 'channel-changed':
      return { ...status, channel: event.channel };

    case 'next-check-scheduled':
      return { ...status, nextCheckAt: event.at };
  }
}
