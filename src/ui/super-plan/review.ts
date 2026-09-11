/** The Review tab: every review round and its findings, with what was resolved. */

import type { SuperPlanFinding, SuperPlanRunView } from '../../chat/super-plan/types';
import { el } from './dom';

const SEVERITY_LABEL: Record<SuperPlanFinding['severity'], string> = {
  blocker: 'Blocker',
  warn: 'Warning',
  info: 'Note',
};

const EXIT_COPY: Record<string, string> = {
  clean: 'The last round found nothing that needs another revision.',
  'round-cap': 'Stopped at the round limit. The last revision was not reviewed again.',
  'no-progress': 'Stopped because a round repeated the previous one. Check the open findings yourself.',
  skipped: 'Review was skipped.',
  failed: 'Review kept failing and was skipped.',
};

/** Signature of what the tab shows, so unchanged views do not repaint it. */
export function reviewKey(view: SuperPlanRunView): string {
  return `${view.reviews.length}:${view.reviewCycle}:${view.reviewExit?.reason ?? ''}:${view.disputedClaims.join(',')}`;
}

export function renderReview(host: HTMLElement, view: SuperPlanRunView): void {
  host.replaceChildren();
  if (!view.reviews.length) {
    const copy = view.config.reviewRounds
      ? 'No review yet. A separate reviewer reads the plan after the first draft and reports what it finds here.'
      : 'Review is off for this plan. You can still ask for a round at the plan checkpoint.';
    host.append(el('p', 'sp-empty', copy));
    if (view.reviewExit && view.reviewExit.reason !== 'clean') host.append(el('p', 'sp-empty', EXIT_COPY[view.reviewExit.reason] ?? ''));
    return;
  }

  const open = new Set(view.openFindings);
  const resolved = new Set(view.resolvedFindings);
  const disputed = new Set(view.disputedClaims);
  const latest = view.reviews[view.reviews.length - 1];

  if (view.reviewExit && view.reviewExit.cycle === view.reviewCycle) {
    const note = el('p', 'sp-review__exit', EXIT_COPY[view.reviewExit.reason] ?? '');
    host.append(note);
  }

  for (const round of [...view.reviews].reverse()) {
    const block = el('section', 'sp-review__round');
    const head = el('h3', 'sp-review__head');
    head.append(document.createTextNode(`Review ${round.round}`));
    if (round.cycle > 1) head.append(el('span', 'sp-review__cycle', `pass ${round.cycle}`));
    head.append(el('span', 'sp-review__counts', counts(round.findings)));
    block.append(head);
    if (round.summary) block.append(el('p', 'sp-review__summary', round.summary));
    if (!round.findings.length) {
      block.append(el('p', 'sp-empty', 'No findings in this round.'));
    } else {
      const list = el('ol', 'sp-findings');
      const isLatest = round === latest;
      for (const finding of sortFindings(round.findings)) {
        const status = isLatest && round.cycle === view.reviewCycle
          ? open.has(finding.id) ? 'open' : ''
          : round.cycle === view.reviewCycle && resolved.has(finding.id) ? 'resolved' : '';
        list.append(renderFinding(finding, status, isLatest && disputed.has(finding.id)));
      }
      block.append(list);
    }
    host.append(block);
  }
}

function counts(findings: SuperPlanFinding[]): string {
  if (!findings.length) return 'clean';
  const by = (severity: SuperPlanFinding['severity']) => findings.filter((f) => f.severity === severity).length;
  const parts: string[] = [];
  const blockers = by('blocker');
  const warnings = by('warn');
  const notes = by('info');
  if (blockers) parts.push(`${blockers} blocker${blockers === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (notes) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function sortFindings(findings: SuperPlanFinding[]): SuperPlanFinding[] {
  const rank = { blocker: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function renderFinding(finding: SuperPlanFinding, status: 'open' | 'resolved' | '', disputed: boolean): HTMLElement {
  const item = el('li', `sp-finding sp-finding--${finding.severity}${status ? ` is-${status}` : ''}`);
  const head = el('div', 'sp-finding__head');
  head.append(el('span', 'sp-finding__severity', SEVERITY_LABEL[finding.severity]));
  head.append(el('span', 'sp-finding__title', finding.title));
  if (status === 'resolved') head.append(el('span', 'sp-finding__tag', 'resolved'));
  if (disputed) head.append(el('span', 'sp-finding__tag sp-finding__tag--disputed', 'claimed fixed'));
  item.append(head);
  if (finding.detail && finding.detail !== finding.title) item.append(el('p', 'sp-finding__detail', finding.detail));
  if (finding.fix) {
    const fix = el('p', 'sp-finding__fix');
    fix.append(el('span', 'sp-finding__fixlabel', 'Suggested fix'), document.createTextNode(` ${finding.fix}`));
    item.append(fix);
  }
  if (finding.paths.length) {
    const paths = el('p', 'sp-finding__paths');
    for (const path of finding.paths) paths.append(el('code', undefined, path));
    item.append(paths);
  }
  return item;
}
