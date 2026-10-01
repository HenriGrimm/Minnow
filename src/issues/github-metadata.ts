import type { IssueComment } from '../types';
import { TAXONOMY_SLUG_RE, ISSUE_STATUS_ROLES, type TaxonomyItem, type StatusItem } from './taxonomy';

/** Portable Minnow fields, carried in the issue body rather than machine-local ids. */
export interface GithubIssueMetadata {
  version: 1;
  type: TaxonomyItem;
  priority: TaxonomyItem;
  status: StatusItem;
  project: { id: string; name: string } | null;
  parent: number | null;
  comments: IssueComment[];
}

const MARKER = '\n\n<!-- minnow-issue:v1\n';

/** Object property order is not a content change (notably after parsing comments). */
export function githubMetadataKey(metadata: GithubIssueMetadata): string {
  return JSON.stringify(metadata, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  });
}

export function encodeGithubIssueBody(body: string, metadata?: GithubIssueMetadata): string {
  if (!metadata) return body;
  // Untrusted comment text must never terminate the HTML comment.
  const json = JSON.stringify(metadata).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${decodeGithubIssueBody(body).body}${MARKER}${json}\n-->`;
}

/** Invalid/unknown blocks remain ordinary text; never erase a user's description. */
export function decodeGithubIssueBody(body: string): { body: string; metadata?: GithubIssueMetadata } {
  let decoded = decodeTrailingMetadata(body);
  if (!decoded.metadata) return decoded;
  // Older clients could push a transport block as description, then append another.
  // The last block is authoritative; peel older valid copies without restoring them.
  const metadata = decoded.metadata;
  while (true) {
    const previous = decodeTrailingMetadata(decoded.body);
    if (!previous.metadata) return { body: decoded.body, metadata };
    decoded = previous;
  }
}

function decodeTrailingMetadata(body: string): { body: string; metadata?: GithubIssueMetadata } {
  const markers = [...body.matchAll(/\r?\n\r?\n<!-- minnow-issue:v1\r?\n/g)];
  const marker = markers[markers.length - 1];
  if (!marker) return { body };
  const start = marker.index!;
  const payload = body.slice(start + marker[0].length);
  const end = /\r?\n-->[ \t\r\n]*$/.exec(payload);
  if (!end) return { body };
  try {
    const raw = JSON.parse(payload.slice(0, end.index));
    const item = (value: any): TaxonomyItem => {
      if (!value || !TAXONOMY_SLUG_RE.test(value.id) || typeof value.label !== 'string' || !value.label.trim()) throw new Error('Invalid taxonomy');
      return { id: value.id, label: value.label, order: 0 };
    };
    if (raw.version !== 1 || !Array.isArray(raw.comments)) return { body };
    const status: StatusItem = item(raw.status);
    if (raw.status.role !== undefined) {
      if (!ISSUE_STATUS_ROLES.includes(raw.status.role)) return { body };
      status.role = raw.status.role;
    }
    if (raw.status.isClosed !== undefined && typeof raw.status.isClosed !== 'boolean') return { body };
    status.isClosed = Boolean(raw.status.isClosed);
    const comments: IssueComment[] = raw.comments.map((c: any) => {
      if (!c || typeof c.id !== 'string' || !c.id || typeof c.body !== 'string' || !['user', 'agent', 'system'].includes(c.authorKind) || !Number.isFinite(c.createdAt)) throw new Error('Invalid comment');
      return { id: c.id, body: c.body, authorKind: c.authorKind, createdAt: c.createdAt,
        ...(typeof c.author === 'string' ? { author: c.author } : {}),
        ...(Number.isFinite(c.editedAt) ? { editedAt: c.editedAt } : {}) };
    });
    if (raw.project !== null && (!raw.project || typeof raw.project.id !== 'string' || !raw.project.id || typeof raw.project.name !== 'string' || !raw.project.name.trim())) return { body };
    if (raw.parent !== null && (!Number.isSafeInteger(raw.parent) || raw.parent <= 0)) return { body };
    return { body: body.slice(0, start), metadata: {
      version: 1, type: item(raw.type), priority: item(raw.priority), status,
      project: raw.project === null ? null : { id: raw.project.id, name: raw.project.name },
      parent: raw.parent, comments,
    } };
  } catch {
    return { body };
  }
}
