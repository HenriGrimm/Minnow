import type { IssueCard, IssueCodeRef } from '../../types.ts';
import {
  isClosedStatus,
  isInProgressStatus,
  isReviewStatus,
} from '../../issues/taxonomy.ts';
import { getIssuesTaxonomySync } from '../../state/issues-taxonomy-store.ts';

// ── Paths ────────────────────────────────────────────────────────────────────

/** Canonical plan path for an issue id (mirrors issues-store.defaultIssuePlanPath). */
export function issuePlanPathForId(issueId: string): string {
  return `documentation/plans/issues/${issueId}.md`;
}

/** Launch-shaped code ref for Code composer attachments. */
export type IssueLaunchCodeRef = {
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
};

/** Format one code ref for seed text (path + optional line range). */
export function formatIssueCodeRefLine(ref: IssueCodeRef): string {
  const path = ref.path.trim().replace(/\\/g, '/');
  if (!path) return '';
  if (ref.startLine != null) {
    const end = ref.endLine ?? ref.startLine;
    if (end !== ref.startLine) return `${path}:${ref.startLine}-${end}`;
    return `${path}:${ref.startLine}`;
  }
  return path;
}

/** Map issue codeRefs → LaunchOptions.codeRefs (snippet or path placeholder as text). */
export function issueCodeRefsToLaunch(issue: IssueCard): IssueLaunchCodeRef[] {
  const refs = issue.codeRefs ?? [];
  const out: IssueLaunchCodeRef[] = [];
  for (const ref of refs) {
    const path = ref.path?.trim().replace(/\\/g, '/');
    if (!path) continue;
    const label = formatIssueCodeRefLine(ref) || path;
    const text = ref.snippet?.trim() || `(code reference: ${label})`;
    out.push({
      path,
      startLine: ref.startLine,
      endLine: ref.endLine ?? ref.startLine,
      text,
    });
  }
  return out;
}

/** Shared issue context block for Plan / Debug / Investigate seeds. */
export function buildIssueContextBlock(issue: IssueCard): string {
  const lines = [
    `Issue: ${issue.id}`,
    `Type: ${issue.type}`,
    `Priority: ${issue.priority}`,
    `Status: ${issue.status}`,
    `Title: ${issue.title}`,
    '',
    'Description:',
    issue.description?.trim() || '(none)',
  ];
  if (issue.notes?.trim()) {
    lines.push('', 'Notes:', issue.notes.trim());
  }
  const refs = (issue.codeRefs ?? [])
    .map((r) => formatIssueCodeRefLine(r))
    .filter(Boolean);
  if (refs.length) {
    lines.push('', 'Code links:', ...refs.map((r) => `- ${r}`));
  }
  if (issue.severity) {
    lines.push('', `Severity: ${issue.severity}`);
  }
  return lines.join('\n');
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/** Seed for interactive Plan-mode Code chat. */
export function buildIssuePlanSeed(issue: IssueCard, planPath?: string): string {
  const path = planPath?.trim() || issuePlanPathForId(issue.id);
  return [
    'Plan work for this issue. Stay in Plan mode — do not implement.',
    '',
    buildIssueContextBlock(issue),
    '',
    `Save the executable plan to exactly \`${path}\` (create documentation/plans/issues/ if needed).`,
    'Use planner structure with Context, Key Files, Waves, and todos front-matter.',
    'When the plan is saved, stop and summarize the path.',
  ].join('\n');
}

/** Seed for Debug-mode Code chat. */
export function buildIssueDebugSeed(issue: IssueCard): string {
  return [
    'Debug this issue. Reproduce, gather evidence, and narrow the root cause.',
    '',
    buildIssueContextBlock(issue),
    '',
    'Prefer read-only exploration first. Propose a fix only after the cause is clear.',
  ].join('\n');
}

/** Composer modes offered in Send to chat. */
export const ISSUE_FOREGROUND_CHAT_MODES = ['general', 'build', 'plan', 'debug'] as const;

export type IssueForegroundChatMode = (typeof ISSUE_FOREGROUND_CHAT_MODES)[number];

/** Seed for General / Build foreground chats seeded from an issue. */
export function buildIssueForegroundSeed(
  issue: IssueCard,
  modeId: 'general' | 'build',
): string {
  const lead =
    modeId === 'build'
      ? 'Work on this issue in Build mode.'
      : 'Discuss and triage this issue in General mode.';
  return [lead, '', buildIssueContextBlock(issue)].join('\n');
}

/** Map a foreground mode id to its issue seed text. */
export function buildIssueForegroundModeSeed(
  issue: IssueCard,
  modeId: IssueForegroundChatMode,
  planPath?: string,
): string {
  if (modeId === 'plan') return buildIssuePlanSeed(issue, planPath);
  if (modeId === 'debug') return buildIssueDebugSeed(issue);
  return buildIssueForegroundSeed(issue, modeId);
}

/** Resolve default plan path for an issue (existing or canonical). */
export function resolveIssuePlanPath(issue: IssueCard): string {
  return issue.planPath?.trim() || issuePlanPathForId(issue.id);
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** True when Send to board should be enabled. */
export function canSendIssueToBoard(issue: IssueCard): boolean {
  return Boolean(issue.planPath?.trim());
}

/** True when Plan / Debug actions should be offered. */
export function canRunIssueWorkflow(issue: IssueCard): boolean {
  return !isClosedStatus(getIssuesTaxonomySync(), issue.status);
}

/** What the workflow activity chip can open (pure; chat ids resolved at click time). */
export type IssueActivityTarget =
  | { kind: 'sub_agent'; runId: string }
  | { kind: 'board_chat'; chatId: string };

/** Activity chip label derived from linked runs (no extra status enum). */
export function issueActivityChip(issue: IssueCard): string | null {
  const taxonomy = getIssuesTaxonomySync();
  if (isReviewStatus(taxonomy, issue.status)) return 'In review';
  if (issue.boardChatId && isInProgressStatus(taxonomy, issue.status)) return 'On board';
  if (
    issue.planRunId &&
    isInProgressStatus(taxonomy, issue.status) &&
    !issue.boardChatId
  ) {
    return 'Planning…';
  }
  if (
    issue.investigateRunId &&
    isInProgressStatus(taxonomy, issue.status) &&
    !issue.notes?.trim() &&
    !issue.boardChatId
  ) {
    return 'Investigating…';
  }
  return null;
}

/** Resolve the activity chip to an openable target (null when the chip is display-only). */
export function issueActivityTarget(issue: IssueCard): IssueActivityTarget | null {
  const taxonomy = getIssuesTaxonomySync();
  if (issue.boardChatId && isInProgressStatus(taxonomy, issue.status)) {
    return { kind: 'board_chat', chatId: issue.boardChatId };
  }
  if (issue.planRunId && isInProgressStatus(taxonomy, issue.status) && !issue.boardChatId) {
    return { kind: 'sub_agent', runId: issue.planRunId };
  }
  if (
    issue.investigateRunId &&
    isInProgressStatus(taxonomy, issue.status) &&
    !issue.notes?.trim() &&
    !issue.boardChatId
  ) {
    return { kind: 'sub_agent', runId: issue.investigateRunId };
  }
  return null;
}
