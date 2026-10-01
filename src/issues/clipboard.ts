/**
 * Issue → Markdown clipboard payload (MIN-95).
 *
 * "Copy issue" is for pasting a card somewhere else — a chat, a commit body,
 * another tracker — so this spells out every stored field and truncates
 * nothing. That is the difference from the model-facing `<issue-ref>` block in
 * `src/chat/issue-mentions.ts`, which caps the description and keeps only the
 * most recent comments on purpose.
 *
 * Timestamps are ISO so a pasted card reads the same in every timezone.
 */

import type {
  IssueActivityEntry,
  IssueAttachment,
  IssueCard,
  IssueCodeRef,
  IssueComment,
  IssueGitLink,
  IssueIssueRef,
} from '../types.ts';
import { findPriority, findStatus, findType, type IssuesTaxonomy } from './taxonomy.ts';

/** Extras the detail panel resolves from the store before formatting. */
export interface IssueClipboardContext {
  /** Used to print readable type / status / priority labels instead of ids. */
  taxonomy?: IssuesTaxonomy;
  /** Resolved name for `issue.projectId`. */
  projectName?: string;
  /** Direct children, so a parent pastes with its sub-issues. */
  children?: readonly IssueCard[];
}

function stamp(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function codeRefLine(ref: IssueCodeRef): string {
  const path = ref.path?.trim().replace(/\\/g, '/');
  if (!path) return '';
  let out = path;
  if (ref.startLine != null) {
    const end = ref.endLine ?? ref.startLine;
    out += end !== ref.startLine ? `:${ref.startLine}-${end}` : `:${ref.startLine}`;
  }
  if (ref.note?.trim()) out += ` — ${ref.note.trim()}`;
  return out;
}

function gitLinkLine(link: IssueGitLink): string {
  const parts = [`${link.kind} ${link.ref}`.trim()];
  if (link.title?.trim()) parts.push(link.title.trim());
  if (link.url?.trim()) parts.push(link.url.trim());
  return parts.join(' — ');
}

function issueRefLine(ref: IssueIssueRef): string {
  const base = `${ref.kind} ${ref.issueId}`;
  return ref.note?.trim() ? `${base} — ${ref.note.trim()}` : base;
}

function attachmentLine(file: IssueAttachment): string {
  const meta = [file.mime?.trim(), file.bytes != null ? `${file.bytes} bytes` : '']
    .filter(Boolean)
    .join(', ');
  const name = file.name?.trim() || file.path;
  return meta ? `${name} (${meta}) — ${file.path}` : `${name} — ${file.path}`;
}

function activityLine(entry: IssueActivityEntry): string {
  const who = entry.actor?.trim() || entry.actorKind || '';
  const data = entry.data
    ? Object.entries(entry.data)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ')
    : '';
  const head = [stamp(entry.at), entry.kind, who].filter(Boolean).join(' · ');
  return data ? `${head} (${data})` : head;
}

function commentBlock(comment: IssueComment): string[] {
  const who = comment.author?.trim() || comment.authorKind;
  const when = stamp(comment.createdAt);
  const edited = comment.editedAt ? ` (edited ${stamp(comment.editedAt)})` : '';
  return [`### ${who} · ${when}${edited}`, '', comment.body?.trim() || '(empty)', ''];
}

function agentSummary(issue: IssueCard): string {
  const agent = issue.agent;
  if (!agent) return '';
  const parts = [`${agent.agentId} · ${agent.phase}`];
  if (agent.step?.trim()) parts.push(agent.step.trim());
  if (agent.branch?.trim()) parts.push(`branch ${agent.branch.trim()}`);
  if (agent.prNumber != null) parts.push(`PR #${agent.prNumber}`);
  if (agent.error?.trim()) parts.push(`error: ${agent.error.trim()}`);
  return parts.join(' — ');
}

function githubSummary(issue: IssueCard): string {
  const link = issue.github;
  if (!link) return '';
  const parts = [`#${link.number}`];
  if (link.repo?.trim()) parts.push(link.repo.trim());
  if (link.url?.trim()) parts.push(link.url.trim());
  return parts.join(' — ');
}

/** Full Markdown dump of one issue, suitable for the clipboard. */
export function formatIssueForClipboard(
  issue: IssueCard,
  context: IssueClipboardContext = {},
): string {
  const taxonomy = context.taxonomy;
  const typeLabel = (taxonomy && findType(taxonomy, issue.type)?.label) || issue.type;
  const statusLabel = (taxonomy && findStatus(taxonomy, issue.status)?.label) || issue.status;
  const priorityLabel =
    (taxonomy && findPriority(taxonomy, issue.priority)?.label) || issue.priority;

  const lines: string[] = [`# ${issue.id} — ${issue.title?.trim() || '(untitled)'}`, ''];

  const field = (label: string, value: string): void => {
    if (value) lines.push(`- ${label}: ${value}`);
  };
  field('Type', typeLabel);
  field('Status', statusLabel);
  field('Priority', priorityLabel);
  field('Labels', issue.labels?.join(', ') ?? '');
  field('Project', context.projectName?.trim() || issue.projectId || '');
  field('Assignee', issue.assignee ? issue.assignee.label?.trim() || issue.assignee.id : '');
  field('Agent', agentSummary(issue));
  field('Parent', issue.parentId ?? '');
  field('Source', issue.source ?? '');
  field('Severity', issue.severity ?? '');
  field('Plan', issue.planPath ?? '');
  field('Linked chats', issue.chatIds?.join(', ') ?? '');
  field('GitHub', githubSummary(issue));
  field('Workspace', issue.workspacePath ?? '');
  field('Created', stamp(issue.createdAt));
  field('Updated', stamp(issue.updatedAt));

  const section = (heading: string, body: string[]): void => {
    if (body.length === 0) return;
    lines.push('', `## ${heading}`, '', ...body);
  };

  section('Description', [issue.description?.trim() || '(none)']);
  if (issue.notes?.trim()) section('Notes', [issue.notes.trim()]);

  const codeRefs = (issue.codeRefs ?? []).map(codeRefLine).filter(Boolean);
  section('Code references', codeRefs.map((ref) => `- ${ref}`));

  section('Git links', (issue.gitLinks ?? []).map((link) => `- ${gitLinkLine(link)}`));
  section('Related issues', (issue.issueRefs ?? []).map((ref) => `- ${issueRefLine(ref)}`));
  section(
    'Sub-issues',
    (context.children ?? []).map((child) => `- ${child.id}: ${child.title} (${child.status})`),
  );
  section('Attachments', (issue.attachments ?? []).map((file) => `- ${attachmentLine(file)}`));
  section('Activity', (issue.activity ?? []).map((entry) => `- ${activityLine(entry)}`));

  const comments = issue.comments ?? [];
  if (comments.length > 0) {
    lines.push('', `## Comments (${comments.length})`, '');
    for (const comment of comments) lines.push(...commentBlock(comment));
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
