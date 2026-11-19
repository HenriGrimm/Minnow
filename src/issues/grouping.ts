/**
 * Group the Issues list by status, priority, assignee, label, or project.
 *
 * Manual `rank` wins inside a group. Column-header sort is a session fallback
 * applied only when ranks are equal or missing. Alt+↑/↓ writes ranks; dropping
 * an issue onto another issue sets `parentId` instead of rank.
 */

import type { IssueCard, IssueProject } from '../types';
import {
  sortedPriorities,
  sortedStatuses,
  type IssuesTaxonomy,
} from './taxonomy';
import { compareIssueRank } from './rank';
import { nestSubIssues, type NestedIssueRow } from './hierarchy';
import {
  buildIssueColumnComparator,
  type IssuesListSort,
} from '../ui/issues-list-sort';

// ── Types ────────────────────────────────────────────────────────────────────

export type IssuesGroupBy = 'status' | 'priority' | 'assignee' | 'label' | 'project';

export const ISSUES_GROUP_BY_OPTIONS: ReadonlyArray<{ id: IssuesGroupBy; label: string }> = [
  { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'label', label: 'Label' },
  { id: 'project', label: 'Project' },
];

export type IssueListGroup = {
  id: string;
  label: string;
  issues: IssueCard[];
};

const UNASSIGNED_GROUP = 'assignee:unassigned';
const NO_LABEL_GROUP = 'label:none';
const NO_PROJECT_GROUP = 'project:none';
const LOCAL_ASSIGNEE_ID = 'me';

function assigneeGroupId(issue: IssueCard): string {
  const id = issue.assignee?.id?.trim();
  return id ? `assignee:${id}` : UNASSIGNED_GROUP;
}

function assigneeGroupLabel(issue: IssueCard): string {
  if (!issue.assignee?.id) return 'Unassigned';
  if (issue.assignee.id === LOCAL_ASSIGNEE_ID) return issue.assignee.label?.trim() || 'Me';
  return issue.assignee.label?.trim() || issue.assignee.id;
}

// ── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Sort inside a group: rank first, then the session column sort.
 *
 * Ranked rows stay ahead of unranked ones so a partial reorder does not dump
 * the moved row behind everything the user has not touched. The first
 * Alt+↑/↓ therefore materializes ranks for the whole peer set (see `rank.ts`)
 * before inserting — otherwise `"h"` on one row still sorts above leftovers.
 */
export function sortIssuesInGroup(
  issues: readonly IssueCard[],
  sessionSort: IssuesListSort,
  taxonomy: IssuesTaxonomy,
  workspaceLabel?: (issue: IssueCard) => string,
): IssueCard[] {
  const compareColumn = buildIssueColumnComparator(sessionSort, taxonomy, workspaceLabel);
  return [...issues].sort((a, b) => {
    const byRank = compareIssueRank(a.rank, b.rank);
    if (byRank !== 0) return byRank;
    const primary = compareColumn(a, b);
    if (primary !== 0) return primary;
    return a.id.localeCompare(b.id);
  });
}

function pushGroup(
  groups: Map<string, IssueListGroup>,
  order: string[],
  id: string,
  label: string,
  issue: IssueCard,
): void {
  let group = groups.get(id);
  if (!group) {
    group = { id, label, issues: [] };
    groups.set(id, group);
    order.push(id);
  }
  group.issues.push(issue);
}

// ── Group ────────────────────────────────────────────────────────────────────

/** Bucket visible issues. Empty groups are omitted. */
export function groupIssuesForList(
  issues: readonly IssueCard[],
  groupBy: IssuesGroupBy,
  options: {
    taxonomy: IssuesTaxonomy;
    projects: readonly IssueProject[];
  },
): IssueListGroup[] {
  const groups = new Map<string, IssueListGroup>();
  const order: string[] = [];
  const { taxonomy, projects } = options;

  if (groupBy === 'status') {
    for (const status of sortedStatuses(taxonomy)) {
      groups.set(`status:${status.id}`, {
        id: `status:${status.id}`,
        label: status.label,
        issues: [],
      });
      order.push(`status:${status.id}`);
    }
    for (const issue of issues) {
      const id = `status:${issue.status}`;
      const known = groups.get(id);
      if (known) {
        known.issues.push(issue);
        continue;
      }
      pushGroup(groups, order, id, issue.status.replace(/_/g, ' '), issue);
    }
  } else if (groupBy === 'priority') {
    for (const priority of sortedPriorities(taxonomy)) {
      groups.set(`priority:${priority.id}`, {
        id: `priority:${priority.id}`,
        label: priority.label,
        issues: [],
      });
      order.push(`priority:${priority.id}`);
    }
    for (const issue of issues) {
      const id = `priority:${issue.priority}`;
      const known = groups.get(id);
      if (known) {
        known.issues.push(issue);
        continue;
      }
      pushGroup(groups, order, id, issue.priority, issue);
    }
  } else if (groupBy === 'assignee') {
    for (const issue of issues) {
      pushGroup(groups, order, assigneeGroupId(issue), assigneeGroupLabel(issue), issue);
    }
    order.sort((a, b) => {
      if (a === `assignee:${LOCAL_ASSIGNEE_ID}`) return -1;
      if (b === `assignee:${LOCAL_ASSIGNEE_ID}`) return 1;
      if (a === UNASSIGNED_GROUP) return 1;
      if (b === UNASSIGNED_GROUP) return -1;
      return (groups.get(a)?.label ?? a).localeCompare(groups.get(b)?.label ?? b);
    });
  } else if (groupBy === 'label') {
    for (const issue of issues) {
      if (issue.labels.length === 0) {
        pushGroup(groups, order, NO_LABEL_GROUP, 'No label', issue);
        continue;
      }
      const label = issue.labels[0];
      pushGroup(groups, order, `label:${label.toLowerCase()}`, label, issue);
    }
    order.sort((a, b) => {
      if (a === NO_LABEL_GROUP) return 1;
      if (b === NO_LABEL_GROUP) return -1;
      return (groups.get(a)?.label ?? a).localeCompare(groups.get(b)?.label ?? b);
    });
  } else {
    const projectName = new Map(projects.map((project) => [project.id, project.name]));
    for (const project of projects) {
      if (project.archivedAt) continue;
      groups.set(`project:${project.id}`, {
        id: `project:${project.id}`,
        label: project.name,
        issues: [],
      });
      order.push(`project:${project.id}`);
    }
    for (const issue of issues) {
      if (issue.projectId && projectName.has(issue.projectId)) {
        const id = `project:${issue.projectId}`;
        const known = groups.get(id);
        if (known) {
          known.issues.push(issue);
          continue;
        }
        pushGroup(
          groups,
          order,
          id,
          projectName.get(issue.projectId) ?? issue.projectId,
          issue,
        );
        continue;
      }
      pushGroup(groups, order, NO_PROJECT_GROUP, 'No project', issue);
    }
    if (groups.has(NO_PROJECT_GROUP) && !order.includes(NO_PROJECT_GROUP)) {
      order.push(NO_PROJECT_GROUP);
    }
  }

  return order
    .map((id) => groups.get(id))
    .filter((group): group is IssueListGroup => Boolean(group && group.issues.length > 0));
}

/** Group, sort by rank then session sort, then nest visible children. */
export function buildGroupedIssueRows(
  issues: readonly IssueCard[],
  groupBy: IssuesGroupBy,
  sessionSort: IssuesListSort,
  options: {
    taxonomy: IssuesTaxonomy;
    projects: readonly IssueProject[];
    allIssues: readonly IssueCard[];
    workspaceLabel?: (issue: IssueCard) => string;
  },
): Array<IssueListGroup & { rows: NestedIssueRow[] }> {
  const nested = nestSubIssues(issues, options.allIssues, options.taxonomy);
  const nestedById = new Map(nested.map((row) => [row.issue.id, row]));
  const groups = groupIssuesForList(
    nested.map((row) => row.issue),
    groupBy,
    options,
  );
  return groups.map((group) => {
    const sorted = sortIssuesInGroup(group.issues, sessionSort, options.taxonomy, options.workspaceLabel);
    return {
      ...group,
      issues: sorted,
      rows: sorted.map((issue) => {
        const row = nestedById.get(issue.id);
        const children = sortIssuesInGroup(row?.children ?? [], sessionSort, options.taxonomy, options.workspaceLabel);
        return {
          issue,
          depth: 0 as const,
          children,
          rollup: row?.rollup ?? null,
        };
      }),
    };
  });
}
