/**
 * What the Issues rail tile's badge counts.
 *
 * Two things, and deliberately only two: unreviewed Triage items, and agents
 * that are blocked waiting on you. Both are queues that drain by you looking at
 * them. A running agent is *not* counted — a badge that never goes down while
 * work is in flight teaches the user to ignore it.
 *
 * Pure so the rail can call it on every board and store change without pulling
 * the app in.
 *
 * Phase 4 of `documentation/plans/issues-app-v2.md`.
 */

import type { IssueCard } from '../types';
import { isUnreviewedTriageIssue } from './triage';

export interface IssuesDockBadgeOptions {
  /**
   * True when the card's status is closed. Closed work is done work: a fixed
   * crash nobody triaged, or an agent that stopped asking because the issue was
   * closed under it, must not hold the badge up.
   */
  isClosed?: (issue: IssueCard) => boolean;
}

export interface IssuesDockBadge {
  /** Total shown on the tile. Zero hides the badge. */
  count: number;
  triage: number;
  awaitingInput: number;
  /** Waiting on you outranks a triage queue and paints as "needs you". */
  urgent: boolean;
}

/** Count the two queues that deserve a badge. */
export function computeIssuesDockBadge(
  issues: readonly IssueCard[],
  options: IssuesDockBadgeOptions = {},
): IssuesDockBadge {
  let triage = 0;
  let awaitingInput = 0;

  for (const issue of issues) {
    if (options.isClosed?.(issue) === true) continue;
    if (isUnreviewedTriageIssue(issue)) triage += 1;
    if (issue.agent?.phase === 'awaiting_input') awaitingInput += 1;
  }

  return {
    count: triage + awaitingInput,
    triage,
    awaitingInput,
    urgent: awaitingInput > 0,
  };
}

/** Accessible label for the badge; empty when there is nothing to say. */
export function issuesDockBadgeLabel(badge: IssuesDockBadge): string {
  const parts: string[] = [];
  if (badge.awaitingInput > 0) {
    parts.push(
      badge.awaitingInput === 1
        ? '1 agent waiting on you'
        : `${badge.awaitingInput} agents waiting on you`,
    );
  }
  if (badge.triage > 0) {
    parts.push(badge.triage === 1 ? '1 issue to triage' : `${badge.triage} issues to triage`);
  }
  return parts.join(', ');
}

/** Badge text, capped so the tile never grows. */
export function issuesDockBadgeText(badge: IssuesDockBadge): string {
  if (badge.count <= 0) return '';
  return badge.count > 99 ? '99+' : String(badge.count);
}
