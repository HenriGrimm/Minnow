/**
 * Where the Issues app was when you left it.
 *
 * The app is one surface among many in the shell, and switching to Code and
 * back used to drop you on "All / list / group by status" no matter which tab,
 * grouping, or board you had open. The chosen view is not a document — it is
 * how you work — so it survives app switches, window reloads, and restarts.
 *
 * Deliberately not persisted: the search box. A stale query restored days later
 * reads as an empty issue list, not as a remembered filter.
 */

import {
  DEFAULT_ISSUES_LIST_SORT,
  type IssuesListSort,
  type IssuesSortDirection,
  type IssuesSortKey,
} from '../ui/issues-list-sort';
import { isIssuesGroupBy } from './saved-views';
import type { IssuesGroupBy } from './grouping';

const STORAGE_KEY = 'minnow.issues.uiState';

export type IssuesViewMode = 'list' | 'board';

/** Filters the chip bar and scope selector own, minus the search box. */
export interface IssuesPersistedFilters {
  scope: 'all' | 'current_workspace';
  type: string;
  status: string;
  priority: string;
  projectId: string;
  hideDone: boolean;
}

export interface IssuesPersistedUiState {
  viewMode: IssuesViewMode;
  groupBy: IssuesGroupBy;
  /** Saved-view tab id, including the session-only "All" pseudo-view. */
  activeViewId: string;
  listSort: IssuesListSort;
  filters: IssuesPersistedFilters;
}

const SORT_KEYS: readonly IssuesSortKey[] = [
  'id',
  'type',
  'title',
  'status',
  'priority',
  'labels',
  'created',
];

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseListSort(raw: unknown): IssuesListSort {
  const row = readRecord(raw);
  const key = SORT_KEYS.includes(row.key as IssuesSortKey)
    ? (row.key as IssuesSortKey)
    : DEFAULT_ISSUES_LIST_SORT.key;
  const direction: IssuesSortDirection =
    row.direction === 'asc' || row.direction === 'desc'
      ? row.direction
      : DEFAULT_ISSUES_LIST_SORT.direction;
  return { key, direction };
}

function parseFilters(raw: unknown, fallback: IssuesPersistedFilters): IssuesPersistedFilters {
  const row = readRecord(raw);
  return {
    scope: row.scope === 'all' ? 'all' : 'current_workspace',
    type: str(row.type, fallback.type),
    status: str(row.status, fallback.status),
    priority: str(row.priority, fallback.priority),
    projectId: str(row.projectId, fallback.projectId),
    hideDone: typeof row.hideDone === 'boolean' ? row.hideDone : fallback.hideDone,
  };
}

/** Normalize whatever is on disk against the caller's defaults. */
export function parseIssuesUiState(
  raw: unknown,
  defaults: IssuesPersistedUiState,
): IssuesPersistedUiState {
  const row = readRecord(raw);
  const groupBy = typeof row.groupBy === 'string' ? row.groupBy : undefined;
  return {
    viewMode: row.viewMode === 'board' ? 'board' : 'list',
    groupBy: isIssuesGroupBy(groupBy) ? (groupBy as IssuesGroupBy) : defaults.groupBy,
    activeViewId: str(row.activeViewId, defaults.activeViewId),
    listSort: parseListSort(row.listSort),
    filters: parseFilters(row.filters, defaults.filters),
  };
}

/** Read the saved state, or the defaults when storage is empty or unreadable. */
export function loadIssuesUiState(defaults: IssuesPersistedUiState): IssuesPersistedUiState {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaults;
  }
  if (!raw) return defaults;
  try {
    return parseIssuesUiState(JSON.parse(raw) as unknown, defaults);
  } catch {
    return defaults;
  }
}

/** Serialize for the dirty check in {@link saveIssuesUiState}. */
export function serializeIssuesUiState(state: IssuesPersistedUiState): string {
  return JSON.stringify(state);
}

let lastWritten: string | null = null;

/**
 * Persist, skipping the write when nothing changed.
 *
 * Every render calls this, so the dedupe is what keeps a store-change storm
 * from turning into a localStorage write per issue update.
 */
export function saveIssuesUiState(state: IssuesPersistedUiState): void {
  const serialized = serializeIssuesUiState(state);
  if (serialized === lastWritten) return;
  lastWritten = serialized;
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {}
}

/** Tests: forget what was last written so the next save always lands. */
export function resetIssuesUiStateCacheForTests(): void {
  lastWritten = null;
}
