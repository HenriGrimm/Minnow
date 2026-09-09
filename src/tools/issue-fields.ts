/**
 * Field projection shared by issue_search and issue_get_state.
 *
 * Both tools read the same store; without a projection an unfiltered read returns
 * every description, comment thread, and activity log at once, which is enough
 * text on its own to fill a small model's context window.
 */

import type { IssueCard } from '../types.ts';

/** Fields the issue read tools will return. Anything else is rejected, not ignored. */
export const SELECTABLE_ISSUE_FIELDS = [
  'id',
  'title',
  'description',
  'status',
  'priority',
  'type',
  'labels',
  'assignee',
  'agent',
  'parentId',
  'projectId',
  'rank',
  'source',
  'createdAt',
  'updatedAt',
  'workspacePath',
  'codeRefs',
  'gitLinks',
  'issueRefs',
  'attachments',
  'comments',
  'activity',
] as const;

/** Compact default: enough to decide what to open, small enough to page. */
export const DEFAULT_ISSUE_FIELDS = [
  'id',
  'title',
  'status',
  'priority',
  'type',
  'updatedAt',
] as const;

export const DEFAULT_ISSUE_LIMIT = 25;
export const MAX_ISSUE_LIMIT = 100;

/** Validate a caller-supplied `fields` array, or fall back to the compact default. */
export function resolveIssueFields(
  raw: unknown,
): { ok: true; fields: string[] } | { ok: false; error: string } {
  const requested = Array.isArray(raw)
    ? raw.filter((field): field is string => typeof field === 'string')
    : null;

  if (requested) {
    const unknown = requested.filter(
      (field) => !(SELECTABLE_ISSUE_FIELDS as readonly string[]).includes(field),
    );
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `Error: unknown fields: ${unknown.join(', ')}. Allowed: ${SELECTABLE_ISSUE_FIELDS.join(', ')}`,
      };
    }
  }

  const fields = requested && requested.length > 0 ? requested : [...DEFAULT_ISSUE_FIELDS];
  // Reading the description includes its image context, even with a narrow projection.
  if (fields.includes('description') && !fields.includes('attachments')) fields.push('attachments');
  return { ok: true, fields };
}

/** Clamp a caller-supplied page size into the allowed range. */
export function resolveIssueLimit(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_ISSUE_LIMIT;
  return Math.min(MAX_ISSUE_LIMIT, Math.max(1, Math.floor(value)));
}

/** Clamp a caller-supplied page offset. */
export function resolveIssueOffset(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function withAttachmentPaths(issue: IssueCard, out: Record<string, unknown>): void {
  if (!('attachments' in out)) return;
  out.attachments = (issue.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path,
    mime: attachment.mime,
    bytes: attachment.bytes,
  }));
}

/** Project one issue down to the requested fields. */
export function projectIssueFields(
  issue: IssueCard,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = (issue as unknown as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  withAttachmentPaths(issue, out);
  return out;
}

/** Project a page of issues. */
export function projectIssuePage(
  issues: readonly IssueCard[],
  fields: readonly string[],
): Record<string, unknown>[] {
  return issues.map((issue) => projectIssueFields(issue, fields));
}
