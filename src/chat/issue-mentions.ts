/**
 * Issue ids typed in chat (`MIN-42`): found in the user's prose, resolved
 * against the issues store at send time, and persisted as `<issue-ref>` blocks
 * so the model sees the issue without an issue_* lookup. The bubble strips the
 * blocks and links the ids instead.
 */

import type { IssueCard } from '../types';

/** Most issues injected for one message — a pasted changelog shouldn't flood context. */
export const MAX_ISSUE_MENTIONS = 5;

const DESCRIPTION_CAP = 4000;
const COMMENT_CAP = 600;
const RECENT_COMMENTS = 3;

/**
 * `KEY-n` with a 2–10 char uppercase key (see project-key.ts). The lookarounds
 * keep ids inside paths, branch names and longer tokens (`a/MIN-1`, `MIN-1-x`) out.
 */
const ISSUE_ID_TOKEN_RE = /(?<![\w/.-])([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-])/g;

export const ISSUE_REF_BLOCK_RE = /<issue-ref id="([A-Z0-9]+-\d+)">\n([\s\S]*?)\n<\/issue-ref>/g;

/** Candidate issue ids in `text`, first-seen order, deduped. Unresolved — may not exist. */
export function findIssueIdTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(ISSUE_ID_TOKEN_RE)) seen.add(match[1]);
  return [...seen];
}

/** Split `text` into prose and the given issue ids, for linking. */
export function splitIssueIdTokens(
  text: string,
  ids: ReadonlySet<string>,
): Array<{ kind: 'text' | 'issue'; value: string }> {
  const parts: Array<{ kind: 'text' | 'issue'; value: string }> = [];
  let last = 0;
  for (const match of text.matchAll(ISSUE_ID_TOKEN_RE)) {
    if (!ids.has(match[1])) continue;
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: 'text', value: text.slice(last, at) });
    parts.push({ kind: 'issue', value: match[1] });
    last = at + match[1].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

function cap(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}… (truncated)` : trimmed;
}

function isoDate(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

/** Model-facing `<issue-ref>` block for one issue. */
export function issueRefHistoryBlock(issue: IssueCard): string {
  const lines: string[] = [
    `${issue.id}: ${issue.title}`,
    `Type: ${issue.type} · Status: ${issue.status} · Priority: ${issue.priority}`,
  ];
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.join(', ')}`);
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.label || issue.assignee.id}`);
  if (issue.parentId) lines.push(`Parent: ${issue.parentId}`);
  if (issue.issueRefs?.length) {
    lines.push(`Related: ${issue.issueRefs.map((r) => `${r.kind} ${r.issueId}`).join(', ')}`);
  }
  if (issue.planPath) lines.push(`Plan: ${issue.planPath}`);
  if (issue.codeRefs?.length) {
    const refs = issue.codeRefs.map((r) =>
      r.startLine != null
        ? `${r.path}:${r.startLine}${r.endLine != null && r.endLine !== r.startLine ? `-${r.endLine}` : ''}`
        : r.path,
    );
    lines.push(`Code: ${refs.join(', ')}`);
  }
  const description = cap(issue.description, DESCRIPTION_CAP);
  lines.push('', 'Description:', description || '(none)');
  const comments = (issue.comments ?? []).slice(-RECENT_COMMENTS);
  if (comments.length) {
    lines.push('', 'Recent comments:');
    for (const c of comments) {
      const who = c.author || c.authorKind;
      lines.push(`- ${who} (${isoDate(c.createdAt)}): ${cap(c.body, COMMENT_CAP)}`);
    }
  }
  // A literal closing tag in the body would end the block early for the parser.
  const body = lines.join('\n').replace(/<\/issue-ref>/g, '<\\/issue-ref>');
  return `<issue-ref id="${issue.id}">\n${body}\n</issue-ref>`;
}

/** `content` without its `<issue-ref>` blocks — for copy and edit, which re-attach on send. */
export function stripIssueRefBlocks(content: string): string {
  return content.replace(ISSUE_REF_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Ids of the `<issue-ref>` blocks already in `content`. */
export function issueRefIdsInContent(content: string): string[] {
  return [...content.matchAll(ISSUE_REF_BLOCK_RE)].map((m) => m[1]);
}

/**
 * Append an `<issue-ref>` block for each issue id in `userText` that `resolve`
 * finds, skipping ids already attached. Returns `content` unchanged when none resolve.
 */
export function appendIssueRefBlocks(
  content: string,
  userText: string,
  resolve: (id: string) => IssueCard | undefined,
): string {
  const already = new Set(issueRefIdsInContent(content));
  const blocks: string[] = [];
  for (const id of findIssueIdTokens(userText)) {
    if (blocks.length >= MAX_ISSUE_MENTIONS) break;
    if (already.has(id)) continue;
    const issue = resolve(id);
    if (!issue) continue;
    already.add(id);
    blocks.push(issueRefHistoryBlock(issue));
  }
  if (!blocks.length) return content;
  return [content, ...blocks].filter((part) => part.trim()).join('\n\n');
}
