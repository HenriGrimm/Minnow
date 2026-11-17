import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { runState, type PullRequestDetail, type PullRequestSummary } from '../state/forge-api';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { createIcon } from './icon';
import { chip, detailHead, diffStat, el, emptyState, pathLabel, relativeTime, stateDot, stateLabel, statePill, type PillTone } from './scc-shared';

export type PrDetailTab = 'overview' | 'checks' | 'files' | 'commits';

export const PR_REVIEW_LABEL: Record<string, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required',
};

export function prStateLabel(pr: Pick<PullRequestSummary, 'state' | 'draft'>): string {
  if (pr.state === 'merged') return 'Merged';
  if (pr.state === 'closed') return 'Closed';
  return pr.draft ? 'Draft' : 'Open';
}

export function prCheckLabel(pr: Pick<PullRequestSummary, 'checks'>): string {
  return { success: 'Checks passing', failure: 'Checks failing', pending: 'Checks running', none: 'No checks' }[pr.checks];
}

export function prMergeLabel(pr: PullRequestSummary): string {
  if (pr.state !== 'open') return prStateLabel(pr);
  if (pr.draft) return 'Draft pull request';
  if (pr.mergeable === 'conflicting') return 'Merge conflicts';
  if (pr.reviewDecision === 'changes_requested') return 'Changes requested';
  if (pr.checks === 'failure') return 'Checks failing';
  if (pr.checks === 'pending') return 'Checks running';
  if (pr.mergeable === 'mergeable') return 'No merge conflicts';
  return 'Mergeability unknown';
}

/** Resolve remote content links without sending the app to a new route. */
export function prContentUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Render GitHub prose, keeping task lists inert and all remote markup sanitized. */
export function renderPrMarkdown(container: HTMLElement, markdown: string, base: string): void {
  const purifier = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(window);
  try {
    const html = marked.parse(markdown, { async: false, gfm: true, breaks: false });
    container.innerHTML = purifier.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['style', 'id', 'name'],
    });
  } catch {
    container.textContent = markdown;
    return;
  }
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = prContentUrl(link.getAttribute('href') ?? '', base);
    if (!href) link.removeAttribute('href');
    else {
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  for (const image of container.querySelectorAll<HTMLImageElement>('img')) {
    const src = prContentUrl(image.getAttribute('src') ?? '', base);
    if (!src) image.remove();
    else {
      image.src = src;
      image.loading = 'lazy';
    }
  }
  for (const input of container.querySelectorAll<HTMLInputElement>('input')) {
    if (input.type !== 'checkbox') input.remove();
    else {
      input.disabled = true;
      input.setAttribute('aria-label', input.parentElement?.textContent?.trim() || 'Task');
    }
  }
}

export function buildPrDetail(
  pr: PullRequestDetail,
  options: {
    actions: HTMLElement;
    mergeActions: HTMLElement;
    reviewHost: HTMLElement;
    activeTab: PrDetailTab;
    onTab: (tab: PrDetailTab) => void;
    /** Narrow panes: return to the list. */
    onBack?: () => void;
  },
): HTMLElement {
  const wrap = el('article', 'scc-detail scc-prdetail');
  wrap.setAttribute('aria-label', `Pull request #${pr.number}`);
  const tone: PillTone = pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open';
  const eyebrow: HTMLElement[] = [statePill(prStateLabel(pr), tone), el('span', 'scc-prdetail__number', `#${pr.number}`)];
  if (pr.author) eyebrow.push(el('span', 'scc-prdetail__author', pr.author));
  const age = relativeTime(pr.updatedAt);
  if (age) {
    const time = el('time', undefined, age === 'now' ? 'updated just now' : `updated ${age} ago`);
    time.dateTime = pr.updatedAt;
    time.title = new Date(pr.updatedAt).toLocaleString();
    eyebrow.push(time);
  }
  const branches = el('div', 'scc-prdetail__branches');
  branches.append(chip(pr.headRef), createIcon('chevronRight', { size: 12 }), chip(pr.baseRef));
  branches.title = `${pr.headRef} into ${pr.baseRef}`;
  const facts: HTMLElement[] = [branches];
  if (pr.crossRepository) facts.push(el('span', 'scc-tag', 'Fork'));
  for (const label of pr.labels) facts.push(el('span', 'scc-tag', label.name));
  const head = detailHead({
    eyebrow,
    title: pr.title,
    titleClass: 'scc-prdetail__title',
    facts,
    actions: options.actions,
    onBack: options.onBack,
    backLabel: 'Pull requests',
  });
  wrap.append(head.root);

  const tabs = el('div', 'scc-tabs scc-prdetail__tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Pull request details');
  const panels = el('div', 'scc-prdetail__panels');
  const definitions: { id: PrDetailTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'checks', label: 'Checks', count: pr.statusChecks.length },
    { id: 'files', label: 'Files', count: pr.changedFiles },
    { id: 'commits', label: 'Commits', count: pr.commits.length },
  ];
  const selectTab = (id: PrDetailTab, focus = false) => {
    for (const tab of tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const active = tab.dataset.tab === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const panel of panels.children) (panel as HTMLElement).hidden = (panel as HTMLElement).dataset.tab !== id;
    options.onTab(id);
  };
  for (const [index, definition] of definitions.entries()) {
    const tab = el('button', 'scc-tab scc-prdetail__tab', definition.label);
    tab.type = 'button';
    tab.addEventListener('click', () => selectTab(definition.id));
    tab.id = `scc-pr-${pr.number}-${definition.id}-tab`;
    tab.dataset.tab = definition.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `scc-pr-${pr.number}-${definition.id}-panel`);
    if (definition.count !== undefined) tab.appendChild(el('span', 'scc-tab__count scc-prdetail__tab-count', String(definition.count)));
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % definitions.length
        : event.key === 'ArrowLeft' ? (index + definitions.length - 1) % definitions.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? definitions.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      event.stopPropagation();
      selectTab(definitions[next]!.id, true);
    });
    tabs.appendChild(tab);
    const panel = el('section', 'scc-prdetail__panel');
    panel.id = `scc-pr-${pr.number}-${definition.id}-panel`;
    panel.dataset.tab = definition.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.tabIndex = 0;
    if (definition.id === 'overview') {
      const summary = el('div', 'scc-prdetail__summary');
      const checks = el('button', 'scc-prdetail__signal');
      checks.type = 'button';
      checks.addEventListener('click', () => selectTab('checks', true));
      const dot = stateDot(pr.checks);
      dot.setAttribute('aria-hidden', 'true');
      const checksValue = el('span', 'scc-prdetail__signal-value');
      checksValue.append(dot, el('span', undefined, prCheckLabel(pr)));
      checks.append(el('span', 'scc-prdetail__signal-label', 'Checks'), checksValue);
      const review = el('div', 'scc-prdetail__signal');
      review.append(el('span', 'scc-prdetail__signal-label', 'Review'), el('span', 'scc-prdetail__signal-value', PR_REVIEW_LABEL[pr.reviewDecision] ?? 'No decision yet'));
      const merge = el('div', 'scc-prdetail__signal');
      merge.append(el('span', 'scc-prdetail__signal-label', 'Merge'), el('span', 'scc-prdetail__signal-value', prMergeLabel(pr)));
      summary.append(checks, review, merge);
      panel.append(summary, options.mergeActions, sectionTitle('Description'));
      const body = el('div', 'scc-prdetail__body');
      if (pr.body.trim()) renderPrMarkdown(body, pr.body.trim(), pr.url);
      else body.appendChild(el('p', 'scc-prdetail__muted', 'No description provided.'));
      panel.append(body, sectionTitle('Reviews', pr.reviews.length), options.reviewHost);
      const reviews = el('div', 'scc-lines scc-prdetail__reviews');
      for (const review of pr.reviews) {
        const row = el('div', 'scc-reviewrow');
        row.append(el('span', 'scc-reviewrow__author', review.author), chip(PR_REVIEW_LABEL[review.state] ?? sentenceCase(review.state), review.state === 'approved' ? 'approved' : review.state === 'changes_requested' ? 'attention' : undefined));
        if (review.body) {
          const body = el('div', 'scc-reviewrow__body scc-prdetail__body');
          renderPrMarkdown(body, review.body, pr.url);
          row.appendChild(body);
        }
        reviews.appendChild(row);
      }
      if (!pr.reviews.length) reviews.appendChild(el('p', 'scc-prdetail__muted', 'No GitHub reviews yet. Use Review PR to get an agent review.'));
      panel.appendChild(reviews);
    } else if (definition.id === 'checks') {
      if (!pr.statusChecks.length) panel.appendChild(emptyState({ icon: 'statusPending', title: 'No checks reported', body: 'Checks appear here when GitHub Actions or another CI service reports a result.' }));
      else {
        panel.appendChild(sectionTitle(prCheckLabel(pr), pr.statusChecks.length));
        const checks = el('div', 'scc-lines scc-prdetail__checks');
        for (const check of pr.statusChecks) {
          const state = ['pending', 'expected'].includes(check.conclusion) ? 'pending' : runState(check);
          const url = prContentUrl(check.url, pr.url);
          const row = el('div', 'scc-checkrow');
          const dot = stateDot(state);
          dot.setAttribute('aria-hidden', 'true');
          row.append(dot, el('span', 'scc-checkrow__name', check.name), el('span', 'scc-checkrow__state', state === 'failure' ? sentenceCase(check.conclusion) : stateLabel(state)));
          if (check.url && url) {
            const link = el('a', 'scc-prdetail__check-link', 'Details');
            link.href = url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.setAttribute('aria-label', `Details for ${check.name}`);
            row.appendChild(link);
          }
          checks.appendChild(row);
        }
        panel.appendChild(checks);
      }
    } else if (definition.id === 'files') {
      const heading = sectionTitle('Changed files', pr.changedFiles);
      heading.appendChild(diffStat(pr.additions, pr.deletions));
      panel.appendChild(heading);
      const files = el('div', 'scc-lines scc-prdetail__files');
      for (const file of pr.files) {
        const row = el('div', 'scc-prfile');
        row.append(createIcon('fileText', { size: 14 }), pathLabel(file.path), diffStat(file.additions, file.deletions));
        files.appendChild(row);
      }
      if (!pr.files.length) files.appendChild(el('p', 'scc-prdetail__muted', 'No changed files reported.'));
      panel.appendChild(files);
    } else {
      panel.appendChild(sectionTitle('Commits', pr.commits.length));
      const commits = el('div', 'scc-lines scc-prdetail__commits');
      for (const commit of pr.commits) {
        const row = el('div', 'scc-prcommit');
        row.append(chip(commit.sha, 'sha'), el('span', 'scc-prcommit__subject', expandGitmojiShortcodes(commit.subject)));
        if (commit.author) row.appendChild(el('span', 'scc-prcommit__author', commit.author));
        commits.appendChild(row);
      }
      if (!pr.commits.length) commits.appendChild(el('p', 'scc-prdetail__muted', 'No commits reported.'));
      panel.appendChild(commits);
    }
    panels.appendChild(panel);
  }
  wrap.append(tabs, panels);
  selectTab(options.activeTab);
  return wrap;
}

function sectionTitle(title: string, count?: number): HTMLElement {
  const head = el('div', 'scc-section scc-prdetail__section');
  head.appendChild(el('h3', 'scc-section__title scc-prdetail__section-title', title));
  if (count !== undefined) head.appendChild(el('span', 'scc-section__count scc-prdetail__section-count', String(count)));
  return head;
}

function sentenceCase(value: string): string {
  const label = value.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
