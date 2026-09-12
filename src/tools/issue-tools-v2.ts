import {
  addIssueComment,
  appendIssueActivity,
  clearIssueAgentRun,
  collectIssues,
  findIssueById,
  isIssueStatus,
  listIssues,
  startIssueAgentRun,
  updateIssue,
} from '../state/issues-store.ts';
import { rankBetween } from '../issues/rank.ts';
import {
  projectIssuePage,
  resolveIncludeClosedIssues,
  resolveIssueFields,
  resolveIssueLimit,
  resolveIssueOffset,
} from './issue-fields.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import type { IssueCard, IssueStatus } from '../types.ts';

// ── Names ────────────────────────────────────────────────────────────────────

/** Tool names this module owns. */
export const ISSUE_V2_TOOL_NAMES = [
  'issue_search',
  'issue_comment',
  'issue_assign',
  'issue_unlink',
  'issue_move',
] as const;

export type IssueV2ToolName = (typeof ISSUE_V2_TOOL_NAMES)[number];

/** True when a name belongs to this module. */
export function isIssueV2Tool(name: string): name is IssueV2ToolName {
  return (ISSUE_V2_TOOL_NAMES as readonly string[]).includes(name);
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Case-insensitive substring match over the fields a human would search. */
function matchesQuery(issue: IssueCard, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (issue.id.toLowerCase().includes(needle)) return true;
  if (issue.title.toLowerCase().includes(needle)) return true;
  if (issue.description.toLowerCase().includes(needle)) return true;
  return issue.labels.some((label) => label.toLowerCase().includes(needle));
}

// ── Search ───────────────────────────────────────────────────────────────────

function runSearch(args: Record<string, unknown>): string {
  const query = str(args, 'query');
  const statusRaw = str(args, 'status');
  const status = statusRaw && isIssueStatus(statusRaw) ? (statusRaw as IssueStatus) : 'all';
  const scope = args.scope === 'all' ? 'all' : 'current_workspace';

  const resolved = resolveIssueFields(args.fields);
  if (resolved.ok === false) return resolved.error;
  const { fields } = resolved;

  const limit = resolveIssueLimit(args.limit);
  const offset = resolveIssueOffset(args.offset);

  let matches = collectIssues({
    scope,
    workspacePath: getWorkspacePath(),
    status,
    hideDone: !resolveIncludeClosedIssues(args, status),
  }).filter((issue) => matchesQuery(issue, query));

  const assignee = str(args, 'assignee');
  if (assignee) matches = matches.filter((issue) => issue.assignee?.id === assignee);
  const label = str(args, 'label');
  if (label) matches = matches.filter((issue) => issue.labels.includes(label));
  const parentId = str(args, 'parent_id');
  if (parentId) matches = matches.filter((issue) => issue.parentId === parentId);
  const projectId = str(args, 'project_id');
  if (projectId) matches = matches.filter((issue) => issue.projectId === projectId);

  const page = matches.slice(offset, offset + limit);
  const issues = projectIssuePage(page, fields);

  return JSON.stringify(
    {
      total: matches.length,
      offset,
      limit,
      hasMore: offset + page.length < matches.length,
      fields,
      issues,
    },
    null,
    2,
  );
}

function runComment(args: Record<string, unknown>): string {
  const issueId = str(args, 'issue_id');
  if (!issueId) return 'Error: issue_comment requires "issue_id"';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!body.trim()) return 'Error: issue_comment requires a non-empty "body"';

  const comment = addIssueComment(issueId, {
    body,
    authorKind: 'agent',
    author: str(args, 'author') || undefined,
  });
  if (!comment) return `Error: unknown issue_id "${issueId}"`;
  return JSON.stringify({ issue_id: issueId, comment }, null, 2);
}

function runAssign(args: Record<string, unknown>): string {
  const issueId = str(args, 'issue_id');
  if (!issueId) return 'Error: issue_assign requires "issue_id"';
  const issue = findIssueById(issueId);
  if (!issue) return `Error: unknown issue_id "${issueId}"`;

  const assignee = str(args, 'assignee');
  const agentId = str(args, 'agent');
  const clear = args.clear_agent === true;

  if (!assignee && !agentId && !clear) {
    return 'Error: issue_assign requires "assignee", "agent", or clear_agent';
  }

  if (assignee) {
    updateIssue(issueId, {
      assignee: {
        id: assignee,
        label: str(args, 'assignee_label') || undefined,
        assignedAt: Date.now(),
      },
    });
    appendIssueActivity(issueId, {
      kind: 'assigned',
      actorKind: 'agent',
      data: { to: assignee },
    });
  }

  if (clear) {
    clearIssueAgentRun(issueId);
  } else if (agentId) {
    startIssueAgentRun(issueId, { agentId });
    updateIssue(issueId, {});
    const current = findIssueById(issueId);
    if (current?.agent) current.agent.phase = 'queued';
  }

  const updated = findIssueById(issueId);
  return JSON.stringify(
    { issue_id: issueId, assignee: updated?.assignee, agent: updated?.agent },
    null,
    2,
  );
}

function runUnlink(args: Record<string, unknown>): string {
  const issueId = str(args, 'issue_id');
  if (!issueId) return 'Error: issue_unlink requires "issue_id"';
  const issue = findIssueById(issueId);
  if (!issue) return `Error: unknown issue_id "${issueId}"`;

  const path = str(args, 'path');
  const ref = str(args, 'ref');
  const targetIssueId = str(args, 'target_issue_id');
  const chatId = str(args, 'chat_id');
  if (!path && !ref && !targetIssueId && !chatId) {
    return 'Error: issue_unlink requires one of "path", "ref", "target_issue_id", "chat_id"';
  }

  let removed = 0;
  if (path) {
    const before = issue.codeRefs?.length ?? 0;
    issue.codeRefs = (issue.codeRefs ?? []).filter((entry) => entry.path !== path);
    removed += before - issue.codeRefs.length;
  }
  if (ref) {
    const before = issue.gitLinks?.length ?? 0;
    issue.gitLinks = (issue.gitLinks ?? []).filter((entry) => entry.ref !== ref);
    removed += before - issue.gitLinks.length;
  }
  if (chatId) {
    const before = issue.chatIds?.length ?? 0;
    issue.chatIds = (issue.chatIds ?? []).filter((entry) => entry !== chatId);
    removed += before - issue.chatIds.length;
  }
  if (targetIssueId) {
    const before = issue.issueRefs?.length ?? 0;
    issue.issueRefs = (issue.issueRefs ?? []).filter((entry) => entry.issueId !== targetIssueId);
    removed += before - issue.issueRefs.length;
    const target = findIssueById(targetIssueId);
    if (target?.issueRefs) {
      target.issueRefs = target.issueRefs.filter((entry) => entry.issueId !== issueId);
    }
  }

  updateIssue(issueId, {});
  return JSON.stringify({ issue_id: issueId, removed }, null, 2);
}

function runMove(args: Record<string, unknown>): string {
  const issueId = str(args, 'issue_id');
  if (!issueId) return 'Error: issue_move requires "issue_id"';
  const issue = findIssueById(issueId);
  if (!issue) return `Error: unknown issue_id "${issueId}"`;

  const statusRaw = str(args, 'status');
  if (statusRaw && !isIssueStatus(statusRaw)) {
    return `Error: unknown status "${statusRaw}"`;
  }
  const status = statusRaw ? (statusRaw as IssueStatus) : issue.status;

  const beforeId = str(args, 'before_issue_id');
  const afterId = str(args, 'after_issue_id');

  const peers = listIssues()
    .filter((card) => card.id !== issueId && card.status === status && card.rank)
    .sort((a, b) => (a.rank ?? '').localeCompare(b.rank ?? ''));

  let rank: string | undefined;
  if (beforeId || afterId) {
    const beforeIndex = peers.findIndex((card) => card.id === beforeId);
    const afterIndex = peers.findIndex((card) => card.id === afterId);
    const lower = afterIndex >= 0 ? peers[afterIndex].rank ?? null : null;
    const upper = beforeIndex >= 0 ? peers[beforeIndex].rank ?? null : null;
    rank = rankBetween(lower, upper);
  } else if (args.to_top === true) {
    rank = rankBetween(null, peers[0]?.rank ?? null);
  } else if (peers.length > 0) {
    rank = rankBetween(peers[peers.length - 1].rank ?? null, null);
  }

  const updated = updateIssue(issueId, { status, ...(rank ? { rank } : {}) });
  if (!updated) return `Error: unknown issue_id "${issueId}"`;
  appendIssueActivity(issueId, {
    kind: 'moved',
    actorKind: 'agent',
    data: { status, rank: rank ?? null },
  });
  return JSON.stringify({ issue_id: issueId, status: updated.status, rank: updated.rank }, null, 2);
}

// ── Execute ──────────────────────────────────────────────────────────────────

/** Execute one of the v2 issue tools. */
export async function executeIssueV2Tool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'issue_search':
      return runSearch(args);
    case 'issue_comment':
      return runComment(args);
    case 'issue_assign':
      return runAssign(args);
    case 'issue_unlink':
      return runUnlink(args);
    case 'issue_move':
      return runMove(args);
    default:
      return `Error: unknown issue tool "${name}"`;
  }
}
