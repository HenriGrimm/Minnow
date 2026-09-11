/**
 * Operational activity log — ring buffer, formatters, and research/plan append helpers.
 */

import type { MainTurnActivity } from '../chat/main-turn-activity';
import type { ResearchProgress } from './types';

export type ActivityLogTone = 'default' | 'warning' | 'danger';

export type ActivityLogKind =
  | 'phase'
  | 'query'
  | 'source'
  | 'tool'
  | 'stage'
  | 'sub-agent'
  | 'warning'
  | 'error'
  | 'info';

export interface ActivityLogEntry {
  id: string;
  atMs: number;
  kind: ActivityLogKind;
  label: string;
  detail?: string;
  queries?: string[];
  url?: string;
  tone?: ActivityLogTone;
}

export type ActivityLogListener = () => void;

const DEFAULT_CAP = 400;

let nextEntryId = 1;

function makeEntryId(): string {
  const id = `al-${nextEntryId}`;
  nextEntryId += 1;
  return id;
}

// ── Format ───────────────────────────────────────────────────────────────────

/** Format wall-clock time for log rows (HH:MM:SS). */
export function formatActivityTimestamp(atMs: number): string {
  const date = new Date(atMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Human label for research SSE phases. */
export function researchPhaseLabel(phase: string): string {
  switch (phase) {
    case 'probing':
      return 'Probing';
    case 'planning':
      return 'Planning';
    case 'searching':
      return 'Searching';
    case 'reading':
      return 'Reading';
    case 'analyzing':
      return 'Analyzing';
    case 'writing':
      return 'Writing';
    case 'category':
      return 'Category';
    case 'decision':
      return 'Decision';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}

function truncateText(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function hostFromUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    const pathPart = url.startsWith('file://') ? url.slice(7) : url;
    const segments = pathPart.replace(/\\/g, '/').split('/');
    return segments[segments.length - 1] || pathPart.slice(0, 40);
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * Identity of a log row by content, ignoring `id` and `atMs`.
 *
 * Replay re-derives stage and research rows with fresh ids and timestamps, so
 * only the content distinguishes "this row is already in the ledger" from a new
 * one (MIN-599).
 */
export function activityLogContentKey(entry: ActivityLogEntry): string {
  return [
    entry.kind,
    entry.label,
    entry.detail ?? '',
    entry.url ?? '',
    (entry.queries ?? []).join('\u001f'),
  ].join('\u001e');
}

/** One-line summary for clipboard export. */
export function formatActivityLogLine(entry: ActivityLogEntry): string {
  const parts = [formatActivityTimestamp(entry.atMs), entry.label];
  if (entry.detail?.trim()) {
    parts.push(entry.detail.trim());
  }
  if (entry.queries?.length) {
    for (const query of entry.queries.slice(0, 8)) {
      parts.push(`  • ${truncateText(query, 160)}`);
    }
  }
  if (entry.url?.trim()) {
    parts.push(entry.url.trim());
  }
  return parts.join(' · ');
}

// ── From events ──────────────────────────────────────────────────────────────

/** Build log entries from a research SSE progress event. */
export function entriesFromResearchProgress(event: ResearchProgress, atMs = Date.now()): ActivityLogEntry[] {
  const label = researchPhaseLabel(event.phase);
  const tone: ActivityLogTone =
    event.phase === 'error' ? 'danger' : event.phase === 'warning' ? 'warning' : 'default';

  if (event.phase === 'searching') {
    const queryList = event.queryList ?? [];
    const count = event.queryCount ?? event.queries ?? queryList.length;
    const detailParts = [`round ${event.round}`, `${count} queries`];
    if (event.queryPreview?.trim()) {
      detailParts.push(`"${truncateText(event.queryPreview, 80)}"`);
    }
    const entry: ActivityLogEntry = {
      id: makeEntryId(),
      atMs,
      kind: 'phase',
      label,
      detail: detailParts.join(' · '),
      queries: queryList.length ? queryList.slice(0, 8) : undefined,
      tone,
    };
    return [entry];
  }

  if (event.phase === 'reading' && event.url) {
    const host = hostFromUrl(event.url);
    const title = event.title?.trim() || event.url;
    const detailParts = [truncateText(title, 100), host];
    if (event.summary?.trim()) {
      detailParts.push(truncateText(event.summary, 120));
    }
    return [
      {
        id: makeEntryId(),
        atMs,
        kind: 'source',
        label,
        detail: detailParts.join(' · '),
        url: /^https?:\/\//i.test(event.url) ? event.url : undefined,
        tone,
      },
    ];
  }

  if (event.phase === 'planning' && event.planSummary?.trim()) {
    return [
      {
        id: makeEntryId(),
        atMs,
        kind: 'phase',
        label,
        detail: truncateText(event.planSummary, 200),
        tone,
      },
    ];
  }

  if (event.phase === 'planning' && !event.planSummary) {
    return [];
  }

  if (event.phase === 'category') {
    return [
      {
        id: makeEntryId(),
        atMs,
        kind: 'phase',
        label,
        detail: event.category,
        tone,
      },
    ];
  }

  if (event.phase === 'warning' || event.phase === 'error') {
    return [
      {
        id: makeEntryId(),
        atMs,
        kind: event.phase,
        label,
        detail: event.message,
        tone,
      },
    ];
  }

  if (event.phase === 'decision') {
    return [
      {
        id: makeEntryId(),
        atMs,
        kind: 'phase',
        label,
        detail: event.message,
        tone,
      },
    ];
  }

  const detailParts: string[] = [];
  if ('round' in event && typeof event.round === 'number') {
    detailParts.push(`round ${event.round}`);
  }
  if ('message' in event && typeof event.message === 'string' && event.message.trim()) {
    detailParts.push(event.message.trim());
  }
  if ('totalSources' in event && typeof event.totalSources === 'number') {
    detailParts.push(`${event.totalSources} sources`);
  }
  if ('totalFindings' in event && typeof event.totalFindings === 'number') {
    detailParts.push(`${event.totalFindings} findings`);
  }
  if ('model' in event && typeof event.model === 'string') {
    detailParts.push(event.model);
  }

  if (!detailParts.length && event.phase === 'reading') {
    return [];
  }

  return [
    {
      id: makeEntryId(),
      atMs,
      kind: 'phase',
      label,
      detail: detailParts.length ? detailParts.join(' · ') : undefined,
      tone,
    },
  ];
}

/** Append main-turn activity as a tool/thinking row. */
export function entryFromMainTurnActivity(
  activity: MainTurnActivity,
  atMs = Date.now(),
): ActivityLogEntry | null {
  if (activity.phase === 'tools' && activity.currentTool?.trim()) {
    return {
      id: makeEntryId(),
      atMs,
      kind: 'tool',
      label: 'Tool',
      detail: `tool: ${activity.currentTool.trim()}`,
    };
  }
  if (activity.phase === 'thinking') {
    return {
      id: makeEntryId(),
      atMs,
      kind: 'info',
      label: 'Model',
      detail: 'thinking…',
    };
  }
  if (activity.phase === 'generating') {
    return {
      id: makeEntryId(),
      atMs,
      kind: 'info',
      label: 'Model',
      detail: 'writing…',
    };
  }
  return null;
}

/** Append sub-agent reviewer status. */
export function entryFromSubAgentStatus(
  status: string,
  toolName?: string | null,
  atMs = Date.now(),
): ActivityLogEntry {
  const detailParts = [status];
  if (toolName?.trim()) {
    detailParts.push(`tool: ${toolName.trim()}`);
  }
  return {
    id: makeEntryId(),
    atMs,
    kind: 'sub-agent',
    label: 'Reviewer',
    detail: detailParts.join(' · '),
  };
}

// ── Buffer ───────────────────────────────────────────────────────────────────

/** Ring buffer for live operational log rows. */
export class ActivityLogBuffer {
  private entries: ActivityLogEntry[] = [];
  private readonly listeners = new Set<ActivityLogListener>();
  private readonly cap: number;
  private unread = 0;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  subscribe(listener: ActivityLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {}
    }
  }

  getEntries(): readonly ActivityLogEntry[] {
    return this.entries;
  }

  getUnreadCount(): number {
    return this.unread;
  }

  markRead(): void {
    this.unread = 0;
    this.notify();
  }

  clear(): void {
    this.entries = [];
    this.unread = 0;
    this.notify();
  }

  append(entry: ActivityLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
    this.unread += 1;
    this.notify();
  }

  appendMany(rows: ActivityLogEntry[]): void {
    for (const row of rows) {
      this.append(row);
    }
  }

  appendFromResearchProgress(event: ResearchProgress, atMs = Date.now()): void {
    this.appendMany(entriesFromResearchProgress(event, atMs));
  }

  hydrateFromResearchProgress(events: ResearchProgress[]): void {
    this.clear();
    for (const event of events) {
      this.appendMany(entriesFromResearchProgress(event));
    }
    this.unread = 0;
    this.notify();
  }
}

/** Reset entry id counter for deterministic tests. */
export function resetActivityLogIdsForTests(): void {
  nextEntryId = 1;
}
