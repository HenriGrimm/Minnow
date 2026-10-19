/** Issues tab root: the current workspace's issues, grouped by status. */

import { collectIssues, getIssueLabelSwatch, scheduleSaveIssues, addIssue } from '../state/issues-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import {
  defaultIssuePriorityId,
  defaultIssueTypeId,
  findPriority,
  findStatus,
  findType,
  isClosedStatus,
  isInProgressStatus,
  isReviewStatus,
  isTriageStatus,
  sortedPriorities,
  sortedStatuses,
  sortedTypes,
} from '../issues/taxonomy';
import { resolveIssuePriorityIcon, resolveIssueStatusIcon, resolveIssueTypeColor, resolveIssueTypeIcon } from '../issues/type-icons';
import { getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import type { IssueCard } from '../types';
import { attachPullToRefresh, fab, screenHeader, searchField, segmented } from './chrome';
import { el, emptyState, icon, shortTime } from './dom';
import type { MobileScreen } from './nav';
import { openSheet, pickFromSheet } from './sheet';

type IssueFilter = 'open' | 'active' | 'triage' | 'closed' | 'all';

const AGENT_LABEL: Record<string, { label: string; tone: string }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Agent working', tone: 'live' },
  awaiting_input: { label: 'Needs you', tone: 'warn' },
  review: { label: 'Ready for review', tone: 'good' },
  failed: { label: 'Agent failed', tone: 'bad' },
};

export function agentBadge(issue: IssueCard): HTMLElement | null {
  const phase = issue.agent?.phase;
  const meta = phase ? AGENT_LABEL[phase] : undefined;
  return meta ? el('span', { className: `m-pill m-pill--${meta.tone}`, text: meta.label }) : null;
}

export function labelChip(name: string): HTMLElement {
  return el('span', { className: 'm-label', text: name, dataset: { swatch: getIssueLabelSwatch(name) } });
}

/** Leading type glyph tinted with the catalog color. */
export function typeGlyph(issue: IssueCard): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = findType(taxonomy, issue.type);
  const node = el('span', { className: 'm-issue-type', attrs: { title: item?.label ?? issue.type } }, icon(resolveIssueTypeIcon(issue.type, item), 14));
  const color = resolveIssueTypeColor(issue.type, item);
  if (color) node.style.setProperty('--m-issue-color', color);
  return node;
}

export function statusGlyph(statusId: string, size = 14): HTMLElement {
  const item = findStatus(getIssuesTaxonomySync(), statusId);
  const node = el('span', { className: 'm-issue-status' }, icon(resolveIssueStatusIcon(statusId, item), size));
  if (item?.color) node.style.setProperty('--m-issue-color', item.color);
  return node;
}

export function priorityGlyph(priorityId: string): HTMLElement {
  const item = findPriority(getIssuesTaxonomySync(), priorityId);
  const node = el('span', { className: 'm-issue-priority', attrs: { title: item?.label ?? priorityId } }, icon(resolveIssuePriorityIcon(priorityId, item), 12));
  if (item?.color) node.style.setProperty('--m-issue-color', item.color);
  return node;
}

function matchesFilter(issue: IssueCard, filter: IssueFilter): boolean {
  const taxonomy = getIssuesTaxonomySync();
  const closed = isClosedStatus(taxonomy, issue.status);
  switch (filter) {
    case 'open':
      return !closed;
    case 'active':
      return isInProgressStatus(taxonomy, issue.status) || isReviewStatus(taxonomy, issue.status) || Boolean(issue.agent && !['done', 'canceled'].includes(issue.agent.phase));
    case 'triage':
      return isTriageStatus(taxonomy, issue.status);
    case 'closed':
      return closed;
    default:
      return true;
  }
}

function buildRow(issue: IssueCard, open: (id: string) => void): HTMLElement {
  const priority = findPriority(getIssuesTaxonomySync(), issue.priority);
  return el(
    'button',
    {
      className: 'm-issue-row',
      attrs: { type: 'button' },
      dataset: { issueId: issue.id },
      on: { click: () => open(issue.id) },
    },
    typeGlyph(issue),
    el(
      'span',
      { className: 'm-issue-row__main' },
      el(
        'span',
        { className: 'm-issue-row__top' },
        el('span', { className: 'm-issue-row__id', text: issue.id }),
        priorityGlyph(issue.priority),
        el('span', { className: 'm-issue-row__priority', text: priority?.label ?? '' }),
        el('span', { className: 'm-issue-row__time', text: shortTime(issue.updatedAt) }),
      ),
      el('span', { className: 'm-issue-row__title', text: issue.title || 'Untitled' }),
      issue.labels.length || issue.agent
        ? el(
            'span',
            { className: 'm-issue-row__chips' },
            agentBadge(issue),
            ...issue.labels.slice(0, 3).map(labelChip),
            issue.labels.length > 3 ? el('span', { className: 'm-muted', text: `+${issue.labels.length - 3}` }) : null,
          )
        : null,
    ),
  );
}

/** New-issue sheet: title, type, priority and an optional description. */
export function openNewIssueSheet(onCreated: (issueId: string) => void): void {
  const taxonomy = getIssuesTaxonomySync();
  let type = defaultIssueTypeId(taxonomy);
  let priority = defaultIssuePriorityId(taxonomy);
  const title = el('input', {
    className: 'm-field',
    attrs: { type: 'text', placeholder: 'Issue title', autofocus: true, enterkeyhint: 'next', 'aria-label': 'Title' },
  });
  const description = el('textarea', {
    className: 'm-field m-field--multiline',
    attrs: { rows: 4, placeholder: 'Description (optional)', 'aria-label': 'Description' },
  });
  const typeBtn = el('button', { className: 'm-prop-btn', attrs: { type: 'button' } });
  const priorityBtn = el('button', { className: 'm-prop-btn', attrs: { type: 'button' } });
  const sync = () => {
    const typeItem = findType(taxonomy, type);
    typeBtn.replaceChildren(icon(resolveIssueTypeIcon(type, typeItem), 14), el('span', { text: typeItem?.label ?? type }));
    const priorityItem = findPriority(taxonomy, priority);
    priorityBtn.replaceChildren(icon(resolveIssuePriorityIcon(priority, priorityItem), 14), el('span', { text: priorityItem?.label ?? priority }));
    submit.disabled = !title.value.trim();
  };
  typeBtn.addEventListener('click', async () => {
    const next = await pickFromSheet('Type', sortedTypes(taxonomy).map((item) => ({
      value: item.id, label: item.label, glyph: resolveIssueTypeIcon(item.id, item), selected: item.id === type,
    })));
    if (next) type = next;
    sync();
  });
  priorityBtn.addEventListener('click', async () => {
    const next = await pickFromSheet('Priority', sortedPriorities(taxonomy).map((item) => ({
      value: item.id, label: item.label, glyph: resolveIssuePriorityIcon(item.id, item), selected: item.id === priority,
    })));
    if (next) priority = next;
    sync();
  });
  const submit = el('button', { className: 'm-btn m-btn--primary m-btn--block', text: 'Create issue', attrs: { type: 'submit' } });
  const form = el('form', { className: 'm-prompt' }, title, el('div', { className: 'm-chip-row' }, typeBtn, priorityBtn), description, submit);
  const sheet = openSheet(form, { title: 'New issue' });
  title.addEventListener('input', sync);
  sync();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = title.value.trim();
    if (!text) return;
    try {
      const card = addIssue({ title: text, description: description.value, type, priority, workspacePath: getWorkspacePath() });
      scheduleSaveIssues();
      sheet.close();
      onCreated(card.id);
    } catch (error) {
      void import('../ui/toast').then((m) => m.showToast(error instanceof Error ? error.message : String(error), 'error'));
    }
  });
}

export function createIssuesScreen(deps: { openIssue(issueId: string): void }): MobileScreen {
  let filter: IssueFilter = 'open';
  let query = '';
  let visible = true;
  let frame = 0;

  const header = screenHeader({ title: 'Issues', large: true });
  const search = searchField('Search issues', (text) => {
    query = text;
    render();
  });
  const filters = segmented<IssueFilter>(
    'Issue filter',
    [
      { value: 'open', label: 'Open' },
      { value: 'active', label: 'In progress' },
      { value: 'triage', label: 'Triage' },
      { value: 'closed', label: 'Done' },
      { value: 'all', label: 'All' },
    ],
    filter,
    (value) => {
      filter = value;
      render();
    },
  );
  const list = el('div', { className: 'm-list', attrs: { role: 'list' } });
  const body = el('div', { className: 'm-screen__body' }, search.el, filters.el, list);
  const root = el(
    'section',
    { className: 'm-screen m-screen--root', dataset: { screen: 'issues' } },
    header.el,
    body,
    fab('fi-rr-plus', 'New issue', () => openNewIssueSheet(deps.openIssue)),
  );

  attachPullToRefresh(body, async () => {
    const { refreshIssuesFromStorage } = await import('../state/issues-store');
    await refreshIssuesFromStorage();
  });

  function render(): void {
    frame = 0;
    let all: IssueCard[];
    try {
      all = collectIssues({ workspacePath: getWorkspacePath(), hideDone: false, search: query });
    } catch {
      list.replaceChildren(emptyState({ glyph: 'fi-rr-hourglass-end', title: 'Loading issues…' }));
      return;
    }
    const counts: Partial<Record<IssueFilter, number>> = {};
    for (const key of ['open', 'active', 'triage', 'closed', 'all'] as IssueFilter[]) {
      counts[key] = all.filter((issue) => matchesFilter(issue, key)).length;
    }
    filters.setCounts(counts);
    const shown = all.filter((issue) => matchesFilter(issue, filter));
    if (!shown.length) {
      list.replaceChildren(
        query
          ? emptyState({ glyph: 'fi-rr-search', title: 'No matching issues' })
          : emptyState({
              glyph: 'fi-rr-ticket',
              title: filter === 'open' ? 'No open issues' : 'Nothing here',
              action: filter === 'open' ? { label: 'New issue', onClick: () => openNewIssueSheet(deps.openIssue) } : undefined,
            }),
      );
      return;
    }
    const statuses = sortedStatuses(getIssuesTaxonomySync());
    const groups = new Map<string, IssueCard[]>();
    for (const issue of shown) {
      const bucket = groups.get(issue.status) ?? [];
      bucket.push(issue);
      groups.set(issue.status, bucket);
    }
    const order = [...statuses.map((status) => status.id), ...[...groups.keys()].filter((id) => !statuses.some((s) => s.id === id))];
    const nodes: HTMLElement[] = [];
    for (const statusId of order) {
      const issues = groups.get(statusId);
      if (!issues?.length) continue;
      issues.sort((a, b) => b.updatedAt - a.updatedAt);
      const label = statuses.find((status) => status.id === statusId)?.label ?? statusId;
      nodes.push(
        el(
          'h2',
          { className: 'm-section-label m-section-label--status' },
          statusGlyph(statusId, 12),
          el('span', { text: label }),
          el('span', { className: 'm-section-label__count', text: String(issues.length) }),
        ),
      );
      for (const issue of issues) nodes.push(buildRow(issue, deps.openIssue));
    }
    list.replaceChildren(...nodes);
  }

  const schedule = () => {
    if (!visible || frame) return;
    frame = requestAnimationFrame(render);
  };
  const unsubs = [subscribeIssuesChanges(schedule), subscribeWorkspace(schedule)];
  render();

  return {
    key: 'issues',
    el: root,
    onShow() {
      visible = true;
      render();
    },
    onHide() {
      visible = false;
    },
    dispose() {
      for (const unsub of unsubs) unsub();
    },
  };
}
