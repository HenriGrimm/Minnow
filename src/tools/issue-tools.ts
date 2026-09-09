import {
  addIssue,
  appendIssueLinks,
  collectIssues,
  deleteIssue,
  deleteIssues,
  findIssueById,
  getIssuesSnapshot,
  getNextIssueIdPreview,
  getWorkspaceProjectKey,
  isIssuePriority,
  isIssueRelationKind,
  isIssueStatus,
  isIssueType,
  normalizeIssueCodeRef,
  normalizeIssueGitLink,
  normalizeIssueIssueRef,
  updateIssue,
} from '../state/issues-store.ts';
import { formatAllowedIds } from '../issues/taxonomy.ts';
import {
  projectIssuePage,
  resolveIssueFields,
  resolveIssueLimit,
  resolveIssueOffset,
} from './issue-fields.ts';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store.ts';
import { getWorkspacePath } from '../state/workspace.ts';
import type {
  IssueCodeRef,
  IssueGitLink,
  IssueIssueRef,
  IssuePriority,
  IssueStatus,
  IssueType,
} from '../types.ts';

export type ValidateIssueAddResult =
  | {
      ok: true;
      title: string;
      description: string;
      type: IssueType;
      priority: IssuePriority;
      labels: string[];
    }
  | { ok: false; error: string };

// ── Add ──────────────────────────────────────────────────────────────────────

/** Validate issue_add arguments (exported for tests). */
export function validateIssueAddArgs(args: Record<string, unknown>): ValidateIssueAddResult {
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return { ok: false, error: 'Error: issue_add requires "title"' };
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  const typeRaw = typeof args.type === 'string' ? args.type.trim() : 'task';
  if (!isIssueType(typeRaw)) {
    const taxonomy = getIssuesTaxonomySync();
    return {
      ok: false,
      error: `Error: type must be one of: ${formatAllowedIds(taxonomy.types)} (configure in Settings → Issues)`,
    };
  }
  const priorityRaw = typeof args.priority === 'string' ? args.priority.trim() : 'none';
  if (!isIssuePriority(priorityRaw)) {
    const taxonomy = getIssuesTaxonomySync();
    return {
      ok: false,
      error: `Error: priority must be one of: ${formatAllowedIds(taxonomy.priorities)} (configure in Settings → Issues)`,
    };
  }
  const labels = Array.isArray(args.labels)
    ? args.labels
        .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
        .map((l) => l.trim())
    : [];
  return { ok: true, title, description, type: typeRaw, priority: priorityRaw, labels };
}

export type ValidateIssueUpdateResult =
  | { ok: true; issueId: string; patch: Parameters<typeof updateIssue>[1] }
  | { ok: false; error: string };

// ── Update ───────────────────────────────────────────────────────────────────

/** Validate issue_update arguments (exported for tests). */
export function validateIssueUpdateArgs(args: Record<string, unknown>): ValidateIssueUpdateResult {
  const issueId =
    typeof args.issue_id === 'string'
      ? args.issue_id.trim()
      : typeof args.issueId === 'string'
        ? args.issueId.trim()
        : '';
  if (!issueId) return { ok: false, error: 'Error: issue_update requires "issue_id"' };

  const patch: Parameters<typeof updateIssue>[1] = {};
  if (typeof args.title === 'string') patch.title = args.title;
  if (typeof args.description === 'string') patch.description = args.description;
  if (typeof args.notes === 'string') patch.notes = args.notes;
  if (typeof args.plan_path === 'string' && args.plan_path.trim()) {
    patch.planPath = args.plan_path.trim();
  }
  if (typeof args.type === 'string' && args.type.trim()) {
    if (!isIssueType(args.type.trim())) {
      const taxonomy = getIssuesTaxonomySync();
      return {
        ok: false,
        error: `Error: type must be one of: ${formatAllowedIds(taxonomy.types)} (configure in Settings → Issues)`,
      };
    }
    patch.type = args.type.trim() as IssueType;
  }
  if (typeof args.status === 'string' && args.status.trim()) {
    if (!isIssueStatus(args.status.trim())) {
      const taxonomy = getIssuesTaxonomySync();
      return {
        ok: false,
        error: `Error: status must be one of: ${formatAllowedIds(taxonomy.statuses)} (configure in Settings → Issues)`,
      };
    }
    patch.status = args.status.trim() as IssueStatus;
  }
  if (typeof args.priority === 'string' && args.priority.trim()) {
    if (!isIssuePriority(args.priority.trim())) {
      const taxonomy = getIssuesTaxonomySync();
      return {
        ok: false,
        error: `Error: priority must be one of: ${formatAllowedIds(taxonomy.priorities)} (configure in Settings → Issues)`,
      };
    }
    patch.priority = args.priority.trim() as IssuePriority;
  }
  if (Array.isArray(args.labels)) {
    patch.labels = args.labels
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .map((l) => l.trim());
  }

  if (
    patch.title === undefined &&
    patch.description === undefined &&
    patch.notes === undefined &&
    patch.planPath === undefined &&
    patch.type === undefined &&
    patch.status === undefined &&
    patch.priority === undefined &&
    patch.labels === undefined
  ) {
    return { ok: false, error: 'Error: issue_update requires at least one field to change' };
  }

  return { ok: true, issueId, patch };
}

export type ValidateIssueDeleteResult =
  | { ok: true; issueIds: string[] }
  | { ok: false; error: string };

// ── Delete ───────────────────────────────────────────────────────────────────

/** Validate issue_delete arguments (exported for tests). */
export function validateIssueDeleteArgs(args: Record<string, unknown>): ValidateIssueDeleteResult {
  const ids: string[] = [];
  const single =
    typeof args.issue_id === 'string'
      ? args.issue_id.trim()
      : typeof args.issueId === 'string'
        ? args.issueId.trim()
        : '';
  if (single) ids.push(single);

  const rawIds = args.issue_ids ?? args.issueIds;
  if (rawIds !== undefined) {
    if (!Array.isArray(rawIds)) {
      return { ok: false, error: 'Error: issue_ids must be an array' };
    }
    for (const item of rawIds) {
      if (typeof item === 'string' && item.trim()) ids.push(item.trim());
    }
  }

  if (ids.length === 0) {
    return { ok: false, error: 'Error: issue_delete requires "issue_id" or "issue_ids"' };
  }

  return { ok: true, issueIds: [...new Set(ids)] };
}

export type ValidateIssueLinkResult =
  | {
      ok: true;
      issueId: string;
      codeRefs: IssueCodeRef[];
      gitLinks: Array<Omit<IssueGitLink, 'addedAt'> & { addedAt?: number }>;
      chatId?: string;
      issueRefs: IssueIssueRef[];
    }
  | { ok: false; error: string };

function parseCodeRefArg(raw: unknown): IssueCodeRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const path =
    typeof obj.path === 'string'
      ? obj.path
      : typeof obj.workspacePath === 'string'
        ? obj.workspacePath
        : '';
  if (!path.trim()) return null;
  const startLine =
    typeof obj.start_line === 'number'
      ? obj.start_line
      : typeof obj.startLine === 'number'
        ? obj.startLine
        : undefined;
  const endLine =
    typeof obj.end_line === 'number'
      ? obj.end_line
      : typeof obj.endLine === 'number'
        ? obj.endLine
        : undefined;
  const snippet = typeof obj.snippet === 'string' ? obj.snippet : undefined;
  const note = typeof obj.note === 'string' ? obj.note : undefined;
  return normalizeIssueCodeRef({ path, startLine, endLine, snippet, note });
}

function parseGitLinkArg(
  raw: unknown,
): (Omit<IssueGitLink, 'addedAt'> & { addedAt?: number }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === 'string' ? obj.kind : '';
  const ref = typeof obj.ref === 'string' ? obj.ref : '';
  const normalized = normalizeIssueGitLink({
    kind: kind as IssueGitLink['kind'],
    ref,
    url: typeof obj.url === 'string' ? obj.url : undefined,
    title: typeof obj.title === 'string' ? obj.title : undefined,
  });
  return normalized;
}

function parseIssueRefArg(raw: unknown): IssueIssueRef | null {
  if (typeof raw === 'string') {
    return normalizeIssueIssueRef(raw);
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const issueId =
    typeof obj.issue_id === 'string'
      ? obj.issue_id
      : typeof obj.issueId === 'string'
        ? obj.issueId
        : '';
  if (!issueId.trim()) return null;
  const kindRaw = typeof obj.kind === 'string' ? obj.kind.trim() : 'related';
  if (!isIssueRelationKind(kindRaw)) return null;
  return normalizeIssueIssueRef({
    issueId: issueId.trim(),
    kind: kindRaw,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  });
}

/** Count issue refs that can be applied (target exists, not a self-link). */
function countApplicableIssueRefs(sourceId: string, refs: IssueIssueRef[]): number {
  let count = 0;
  for (const ref of refs) {
    if (ref.issueId === sourceId) continue;
    if (!findIssueById(ref.issueId)) continue;
    count += 1;
  }
  return count;
}

// ── Link ─────────────────────────────────────────────────────────────────────

/** Validate issue_link arguments (append-only; exported for tests). */
export function validateIssueLinkArgs(args: Record<string, unknown>): ValidateIssueLinkResult {
  const issueId =
    typeof args.issue_id === 'string'
      ? args.issue_id.trim()
      : typeof args.issueId === 'string'
        ? args.issueId.trim()
        : '';
  if (!issueId) return { ok: false, error: 'Error: issue_link requires "issue_id"' };

  const codeRefs: IssueCodeRef[] = [];
  const codeRaw = args.code_refs ?? args.codeRefs;
  if (codeRaw !== undefined) {
    if (!Array.isArray(codeRaw)) {
      return { ok: false, error: 'Error: code_refs must be an array' };
    }
    for (const item of codeRaw) {
      const ref = parseCodeRefArg(item);
      if (!ref) {
        return {
          ok: false,
          error: 'Error: each code_ref needs path (and optional start_line/end_line)',
        };
      }
      codeRefs.push(ref);
    }
  }

  const gitLinks: Array<Omit<IssueGitLink, 'addedAt'> & { addedAt?: number }> = [];
  const gitRaw = args.git_links ?? args.gitLinks;
  if (gitRaw !== undefined) {
    if (!Array.isArray(gitRaw)) {
      return { ok: false, error: 'Error: git_links must be an array' };
    }
    for (const item of gitRaw) {
      const link = parseGitLinkArg(item);
      if (!link) {
        return {
          ok: false,
          error:
            'Error: each git_link needs kind (commit|branch|pr|github-issue) and ref',
        };
      }
      gitLinks.push(link);
    }
  }

  const chatId =
    typeof args.chat_id === 'string'
      ? args.chat_id.trim()
      : typeof args.chatId === 'string'
        ? args.chatId.trim()
        : '';

  const issueRefs: IssueIssueRef[] = [];
  const issueRaw = args.issue_refs ?? args.issueRefs;
  if (issueRaw !== undefined) {
    if (!Array.isArray(issueRaw)) {
      return { ok: false, error: 'Error: issue_refs must be an array' };
    }
    for (const item of issueRaw) {
      if (typeof item === 'string') {
        const ref = normalizeIssueIssueRef(item);
        if (!ref) {
          return { ok: false, error: 'Error: each issue_ref must be an issue id or object' };
        }
        issueRefs.push(ref);
        continue;
      }
      if (!item || typeof item !== 'object') {
        return { ok: false, error: 'Error: each issue_ref must be an issue id or object' };
      }
      const obj = item as Record<string, unknown>;
      const targetId =
        typeof obj.issue_id === 'string'
          ? obj.issue_id.trim()
          : typeof obj.issueId === 'string'
            ? obj.issueId.trim()
            : '';
      if (!targetId) {
        return { ok: false, error: 'Error: each issue_ref object needs issue_id' };
      }
      const kindRaw = typeof obj.kind === 'string' ? obj.kind.trim() : 'related';
      if (typeof obj.kind === 'string' && obj.kind.trim() && !isIssueRelationKind(kindRaw)) {
        return {
          ok: false,
          error: `Error: issue_ref kind must be one of: related, blocks, blocked-by, duplicate-of, parent, sub-issue`,
        };
      }
      const ref = parseIssueRefArg(item);
      if (!ref) {
        return { ok: false, error: 'Error: each issue_ref must be an issue id or object' };
      }
      issueRefs.push(ref);
    }
  }

  if (codeRefs.length === 0 && gitLinks.length === 0 && !chatId && issueRefs.length === 0) {
    return {
      ok: false,
      error: 'Error: issue_link requires code_refs, git_links, chat_id, and/or issue_refs',
    };
  }

  return {
    ok: true,
    issueId,
    codeRefs,
    gitLinks,
    chatId: chatId || undefined,
    issueRefs,
  };
}

// ── Execute ──────────────────────────────────────────────────────────────────

/** Execute issue_add / issue_update / issue_link / issue_get_state / issue_delete. */
export async function executeIssueTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'issue_add') {
    const validated = validateIssueAddArgs(args);
    if (validated.ok === false) return validated.error;
    const issueId =
      typeof args.issue_id === 'string' && args.issue_id.trim()
        ? args.issue_id.trim()
        : undefined;
    const parentId = typeof args.parent_id === 'string' ? args.parent_id.trim() : '';
    const projectId = typeof args.project_id === 'string' ? args.project_id.trim() : '';
    let card;
    try {
      card = addIssue(
        {
          title: validated.title,
          description: validated.description,
          type: validated.type,
          priority: validated.priority,
          labels: validated.labels,
          workspacePath: getWorkspacePath(),
          source: 'agent',
          ...(parentId ? { parentId } : {}),
          ...(projectId ? { projectId } : {}),
        },
        issueId,
      );
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    return JSON.stringify(card, null, 2);
  }

  if (name === 'issue_update') {
    const validated = validateIssueUpdateArgs(args);
    if (validated.ok === false) return validated.error;
    const updated = updateIssue(validated.issueId, validated.patch);
    if (!updated) return `Error: unknown issue_id "${validated.issueId}"`;
    return JSON.stringify(updated, null, 2);
  }

  if (name === 'issue_link') {
    const validated = validateIssueLinkArgs(args);
    if (validated.ok === false) return validated.error;
    if (
      validated.issueRefs.length > 0 &&
      countApplicableIssueRefs(validated.issueId, validated.issueRefs) === 0
    ) {
      return `Error: no valid issue_refs for "${validated.issueId}" (unknown target or self-link)`;
    }
    const updated = appendIssueLinks(validated.issueId, {
      codeRefs: validated.codeRefs,
      gitLinks: validated.gitLinks,
      chatId: validated.chatId,
      issueRefs: validated.issueRefs,
    });
    if (!updated) return `Error: unknown issue_id "${validated.issueId}"`;
    return JSON.stringify(updated, null, 2);
  }

  if (name === 'issue_get_state') {
    const scope =
      args.workspace_scope === 'all' || args.scope === 'all' ? 'all' : 'current_workspace';
    const statusRaw = typeof args.status === 'string' ? args.status.trim() : 'all';
    const status =
      statusRaw === 'all' || !isIssueStatus(statusRaw) ? 'all' : (statusRaw as IssueStatus);
    const resolved = resolveIssueFields(args.fields);
    if (resolved.ok === false) return resolved.error;
    const { fields } = resolved;
    const limit = resolveIssueLimit(args.limit);
    const offset = resolveIssueOffset(args.offset);

    const matches = collectIssues({
      scope,
      workspacePath: getWorkspacePath(),
      status,
      hideDone: false,
    });
    const page = matches.slice(offset, offset + limit);
    const snap = getIssuesSnapshot();
    const workspacePath = getWorkspacePath();
    return JSON.stringify(
      {
        version: snap.version,
        nextId: snap.nextId,
        workspaceProjectKey: getWorkspaceProjectKey(workspacePath),
        nextIssuePreview: getNextIssueIdPreview(workspacePath),
        scope,
        status,
        total: matches.length,
        offset,
        limit,
        hasMore: offset + page.length < matches.length,
        fields,
        issues: projectIssuePage(page, fields),
      },
      null,
      2,
    );
  }

  if (name === 'issue_delete') {
    const validated = validateIssueDeleteArgs(args);
    if (validated.ok === false) return validated.error;
    if (validated.issueIds.length === 1) {
      const issueId = validated.issueIds[0];
      const removed = deleteIssue(issueId);
      if (!removed) return `Error: unknown issue_id "${issueId}"`;
      return JSON.stringify({ deleted: true, issue_id: issueId }, null, 2);
    }
    const removed = deleteIssues(validated.issueIds);
    if (removed === 0) return 'Error: no matching issues found';
    return JSON.stringify(
      { deleted: removed, issue_ids: validated.issueIds },
      null,
      2,
    );
  }

  return `Error: unknown issue tool "${name}"`;
}
