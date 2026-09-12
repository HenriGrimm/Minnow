/**
 * Built-in Issues saved views and the filter shape they serialize.
 *
 * Active-view selection is session-only (no new top-level schema key). The
 * `views` array on disk holds these built-ins plus any user-created tabs.
 */

import type { IssueSavedView } from '../types';
import type { IssuesGroupBy } from './grouping';

/** Filter blob stored on {@link IssueSavedView.filters}. */
export type IssueViewFilterState = {
  type?: string;
  status?: string;
  priority?: string;
  projectId?: string | null;
  hideDone?: boolean;
  unreviewed?: boolean;
  hasAgent?: boolean;
  /** Solo-player "mine": assignee is me, or nobody yet. */
  mine?: boolean;
  assigneeId?: string | null;
};

export const BUILTIN_VIEW_TRIAGE = 'builtin:triage';
export const BUILTIN_VIEW_AGENTS = 'builtin:agents';
export const BUILTIN_VIEW_MY_OPEN = 'builtin:my-open';
/** Session-only "everything matching extra chips" — not persisted. */
export const SESSION_VIEW_ALL = 'session:all';

export const LOCAL_ASSIGNEE_ID = 'me';

/** Shipped tabs, in display order. Seeded when `views` is empty. */
export function builtInIssueViews(): IssueSavedView[] {
  return [
    {
      id: BUILTIN_VIEW_TRIAGE,
      name: 'Triage',
      filters: { unreviewed: true, hideDone: true },
      groupBy: 'status',
      order: 0,
      builtIn: true,
    },
    {
      id: BUILTIN_VIEW_AGENTS,
      name: 'Assigned to agents',
      filters: { hasAgent: true },
      groupBy: 'status',
      order: 1,
      builtIn: true,
    },
    {
      id: BUILTIN_VIEW_MY_OPEN,
      name: 'My open',
      filters: { mine: true, hideDone: true },
      groupBy: 'status',
      order: 2,
      builtIn: true,
    },
  ];
}

/**
 * Repair built-ins that shipped with a wrong filter.
 *
 * Triage originally seeded `hideDone: false`, so closed crash/agent/GitHub
 * cards that were never reviewed stayed in the lane forever. The views array
 * is on disk, so fixing the seed alone leaves every existing install broken.
 * Returns true when something changed and the store needs a save.
 */
export function migrateBuiltInIssueViews(views: IssueSavedView[]): boolean {
  let changed = false;
  for (const view of views) {
    if (view.id !== BUILTIN_VIEW_TRIAGE) continue;
    const filters = (view.filters ?? {}) as Record<string, unknown>;
    if (filters.hideDone === false) {
      view.filters = { ...filters, hideDone: true } as IssueSavedView['filters'];
      changed = true;
    }
  }
  return changed;
}

export function parseViewFilters(raw: IssueSavedView['filters'] | undefined): IssueViewFilterState {
  if (!raw || typeof raw !== 'object') return {};
  const out: IssueViewFilterState = {};
  if (typeof raw.type === 'string') out.type = raw.type;
  if (typeof raw.status === 'string') out.status = raw.status;
  if (typeof raw.priority === 'string') out.priority = raw.priority;
  if (raw.projectId === null) out.projectId = null;
  else if (typeof raw.projectId === 'string') out.projectId = raw.projectId;
  if (typeof raw.hideDone === 'boolean') out.hideDone = raw.hideDone;
  if (typeof raw.unreviewed === 'boolean') out.unreviewed = raw.unreviewed;
  if (typeof raw.hasAgent === 'boolean') out.hasAgent = raw.hasAgent;
  if (typeof raw.mine === 'boolean') out.mine = raw.mine;
  if (raw.assigneeId === null) out.assigneeId = null;
  else if (typeof raw.assigneeId === 'string') out.assigneeId = raw.assigneeId;
  return out;
}

export function isIssuesGroupBy(value: string | undefined): value is IssuesGroupBy {
  return (
    value === 'status' ||
    value === 'priority' ||
    value === 'assignee' ||
    value === 'label' ||
    value === 'project'
  );
}
