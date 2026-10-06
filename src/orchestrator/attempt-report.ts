/**
 * Shared attempt scan chrome: verdict facts, blockers, collapsed write-up.
 *
 * The task-card Work list renders the whole scan; the end-of-run report reuses
 * the blocker list and write-up so the two surfaces cannot disagree on what
 * "the attempt said."
 */

import type { Attempt } from '../../server/orchestrator/core/types';
import {
  collectAttemptFacts,
  formatAttemptFacts,
  humanizeAbandonReason,
  summaryScent,
  writeUpNeedsCollapse,
  type AttemptScanFacts,
} from './attempt-scan';
import { el } from './dom';
import { reportDisclosure } from './report-evidence';

/** Survives report remounts (git hydrate, journal ticks) so an open write-up stays open. */
const openWriteUps = new Set<string>();

export function resetAttemptWriteUps(): void {
  openWriteUps.clear();
}

export function clearAttemptReportUiForTests(): void {
  resetAttemptWriteUps();
}

export function renderTaskReason(reason: string): HTMLElement {
  return el('p', 'ov2-report-task__reason', humanizeAbandonReason(reason));
}

export function renderAttemptFacts(facts: AttemptScanFacts): HTMLElement | null {
  const parts = formatAttemptFacts(facts);
  if (!parts.length) return null;
  const line = el('p', 'ov2-attempt-facts');
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = el('span', 'ov2-attempt-facts__sep', '·');
      sep.setAttribute('aria-hidden', 'true');
      line.appendChild(sep);
    }
    line.appendChild(el('span', 'ov2-attempt-facts__item', part));
  });
  return line;
}

/** A short preview keeps logs out of the scan; every blocker remains expandable. */
export function renderBlockerList(blockers: string[]): HTMLElement | null {
  if (!blockers.length) return null;
  const wrap = el('div', 'ov2-attempt-blocker-scan');
  wrap.appendChild(el('p', 'ov2-attempt-blocker-scan__preview', summaryScent(blockers[0])));
  wrap.appendChild(reportDisclosure(
    `View ${blockers.length === 1 ? 'blocker' : `${blockers.length} blockers`}`,
    () => {
      const list = el('ul', 'ov2-attempt-blockers');
      list.tabIndex = 0;
      for (const item of blockers) list.appendChild(el('li', '', item));
      return list;
    },
  ));
  return wrap;
}

export function renderCollapsedWriteUp(
  text: string,
  options: { key: string; scentClass?: string; compact?: boolean },
): HTMLElement {
  const wrap = el('div', options.compact ? 'ov2-attempt-writeup ov2-attempt-writeup--compact' : 'ov2-attempt-writeup');
  const trimmed = text.trim();
  const collapse = writeUpNeedsCollapse(trimmed);
  wrap.appendChild(
    el(
      'p',
      options.scentClass ?? 'ov2-attempt-writeup__scent',
      collapse ? summaryScent(trimmed) : trimmed,
    ),
  );
  if (!collapse) return wrap;

  const details = el(
    'details',
    options.compact
      ? 'ov2-attempt-writeup__full ov2-attempt-writeup__full--compact'
      : 'ov2-report-disclosure ov2-attempt-writeup__full',
  );
  details.open = openWriteUps.has(options.key);
  details.appendChild(el('summary', '', 'Write-up'));
  const mountBody = (): void => {
    if (details.querySelector('.ov2-attempt-writeup__body')) return;
    details.appendChild(el('p', 'ov2-attempt-writeup__body', trimmed));
  };
  if (details.open) mountBody();
  details.addEventListener('toggle', () => {
    if (details.open) {
      openWriteUps.add(options.key);
      mountBody();
    } else {
      openWriteUps.delete(options.key);
    }
  });
  wrap.appendChild(details);
  return wrap;
}

/**
 * Verdict block for one attempt on the task-card Work list: the leading
 * blocker, fact chips, then a collapsed write-up. Outcome stays on the badge.
 */
export function renderAttemptScan(attempt: Attempt): HTMLElement | null {
  const scan = el('div', 'ov2-work__scan');
  const facts = collectAttemptFacts(attempt.evidence);
  if (facts.blockers[0]) scan.appendChild(el('p', 'ov2-work__blocker', facts.blockers[0]));
  const factsLine = renderAttemptFacts(facts);
  if (factsLine) scan.appendChild(factsLine);
  if (attempt.summary) {
    scan.appendChild(
      renderCollapsedWriteUp(attempt.summary, {
        key: `work:${attempt.attemptId}`,
        scentClass: 'ov2-work__scent',
        compact: true,
      }),
    );
  }
  return scan.childElementCount ? scan : null;
}
