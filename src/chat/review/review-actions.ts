import { appConfirm } from '../../ui/app-dialog.ts';
import { prMerge, prView, type CheckState } from '../../state/forge-api.ts';
import {
  addIssueComment,
  appendIssueLinks,
  findIssueById,
  requireIssueStatusForRole,
  updateIssue,
  updateIssueAgentRun,
} from '../../state/issues-store.ts';
import { draftIssueGitLink } from '../issues/git-helpers.ts';
import type { PrReviewRecord } from '../../state/pr-review-store.ts';

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface ConfirmAndMergePrInput {
  cwd?: string;
  number: number;
  method: MergeMethod;
  baseRef: string;
  headRef: string;
  checks?: CheckState;
}

export type ConfirmAndMergePrResult = 'merged' | 'cancelled' | 'failed';

/** Double-confirm merge, then optional delete-branch. Shared by SCC and the review panel. */
export async function confirmAndMergePr(
  input: ConfirmAndMergePrInput,
): Promise<{ result: ConfirmAndMergePrResult; error?: string }> {
  const warning =
    input.checks === 'failure'
      ? ' Checks are failing.'
      : input.checks === 'pending'
        ? ' Checks are still running.'
        : '';

  const methodLabel =
    input.method === 'squash'
      ? 'Squash and merge'
      : input.method === 'rebase'
        ? 'Rebase and merge'
        : 'Merge';

  const confirmed = await appConfirm(
    `${methodLabel} #${input.number} into ${input.baseRef}?${warning}`,
    {
      title: 'Merge pull request',
      confirmLabel: 'Merge',
      danger: input.checks === 'failure',
    },
  );
  if (!confirmed) return { result: 'cancelled' };

  const deleteBranch = await appConfirm(`Delete ${input.headRef} after merging?`, {
    title: 'Delete branch',
    confirmLabel: 'Delete branch',
    cancelLabel: 'Keep branch',
  });

  const merge = await prMerge({
    cwd: input.cwd,
    number: input.number,
    method: input.method,
    deleteBranch,
  });
  if (!merge.ok) {
    return { result: 'failed', error: merge.error ?? 'Could not merge the pull request' };
  }
  return { result: 'merged' };
}

/** Squash-merge the reviewed PR (panel Merge action). */
export async function mergeReviewedPr(
  record: PrReviewRecord,
  cwd?: string,
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const view = await prView({ cwd, number: record.number });
  const checks = view.ok ? view.pr?.checks : undefined;
  const baseRef = view.pr?.baseRef || record.baseRef;
  const headRef = view.pr?.headRef || record.headRef;

  const { result, error } = await confirmAndMergePr({
    cwd,
    number: record.number,
    method: 'squash',
    baseRef,
    headRef,
    checks,
  });
  if (result === 'cancelled') return { ok: true, cancelled: true };
  if (result === 'failed') return { ok: false, error };
  return { ok: true };
}

/** Seed a new Build chat with the findings that still need a fix. */
export async function sendPrReviewToBuilder(record: PrReviewRecord): Promise<void> {
  await ensureCodeChatSurface();
  const { createChatWithMode } = await import('../../ui/sidebar.ts');
  await createChatWithMode({
    modeId: 'build',
    initialUserMessage: buildPrReviewFixSeed(record),
  });
}

/** Write the review onto the issue: comment, git link, and the previously-dead agent PR fields. */
export function applyPrReviewToIssue(record: PrReviewRecord, issueId: string): boolean {
  const issue = findIssueById(issueId);
  if (!issue) return false;

  const body = formatReviewComment(record);
  addIssueComment(issueId, {
    body,
    authorKind: 'agent',
    author: 'pr-reviewer',
  });

  appendIssueLinks(issueId, {
    gitLinks: [
      draftIssueGitLink('pr', String(record.number), {
        url: record.url || undefined,
        title: `PR #${record.number}`,
      }),
    ],
  });

  updateIssue(issueId, { status: requireIssueStatusForRole('review') });

  if (issue.agent) {
    updateIssueAgentRun(issueId, {
      prNumber: record.number,
      prUrl: record.url || undefined,
    });
  }

  return true;
}

function buildPrReviewFixSeed(record: PrReviewRecord): string {
  const actionable = record.findings.filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'warn',
  );
  const lines: string[] = [
    `Fix the findings from the in-app review of PR #${record.number} (${record.headRef} → ${record.baseRef}).`,
    '',
    record.summary.trim() || 'No summary.',
    '',
  ];
  if (record.url) lines.push(`PR: ${record.url}`, '');

  if (actionable.length === 0) {
    lines.push('No blocker or should-fix findings. Confirm the change still matches the PR intent, then stop.');
    return lines.join('\n');
  }

  lines.push('Findings to fix:');
  for (const finding of actionable) {
    const paths = finding.paths?.length ? ` (${finding.paths.join(', ')})` : '';
    lines.push(`- [${finding.severity}] ${finding.title}${paths}`);
    lines.push(`  ${finding.detail}`);
  }
  lines.push(
    '',
    'Apply the suggested fixes. Keep the diff scoped to these findings. Do not merge the PR.',
  );
  return lines.join('\n');
}

function formatReviewComment(record: PrReviewRecord): string {
  const counts = countBySeverity(record.findings);
  const parts = [
    `PR review #${record.number}: ${record.summary.trim() || 'Review complete.'}`,
    `Findings: ${counts.blocker} blocker, ${counts.warn} should-fix, ${counts.info} nit.`,
  ];
  return parts.join('\n');
}

function countBySeverity(findings: PrReviewRecord['findings']): {
  blocker: number;
  warn: number;
  info: number;
} {
  let blocker = 0;
  let warn = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === 'blocker') blocker += 1;
    else if (finding.severity === 'warn') warn += 1;
    else info += 1;
  }
  return { blocker, warn, info };
}

/** Ensure the Code chat composer is visible before starting a fixer chat. */
async function ensureCodeChatSurface(): Promise<void> {
  const { isCodeOverviewOpen } = await import('../../ui/code-overview.ts');
  if (!isCodeOverviewOpen()) return;
  const { closeCodeOverview } = await import('../../ui/code-overview.ts');
  const { navigateToCodeChat } = await import('../../os/router.ts');
  closeCodeOverview({ skipNavigate: true, restoreChat: false });
  navigateToCodeChat();
}
