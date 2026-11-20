/**
 * GitHub sync for Issues: the side of it that touches the network and the store.
 *
 * The decisions live in `issues/github-sync-plan.ts` and are pure. This module
 * only carries them out, which is why it never contains a "who wins" branch —
 * if you find yourself adding one here, it belongs in the planner where it can
 * be tested.
 *
 * Phase 5 of `documentation/plans/issues-app-v2.md`.
 */

import {
  ISSUES_GITHUB_MODES,
  githubLabelDiff,
  githubSyncedSnapshot,
  nextGithubLink,
  normalizeGithubMode,
  planIssueSync,
  type IssuesGithubMode,
  type RemoteIssueSnapshot,
  type SyncAction,
  type SyncFields,
} from '../issues/github-sync-plan';
import { userFacingGithubError, isLocalServerOfflineError } from '../issues/github-error';
import {
  addIssue,
  appendIssueLinks,
  collectIssues,
  findIssueById,
  findIssueProject,
  restoreGithubIssueProject,
  isIssuesStoreLoaded,
  listIssues,
  requireIssueStatusForRole,
  refreshIssuesFromStorage,
  saveIssuesNow,
  scheduleSaveIssues,
  updateIssue,
} from './issues-store';
import { isClosedStatus } from '../issues/taxonomy';
import { getIssuesTaxonomySync, setIssuesTaxonomy } from './issues-taxonomy-store';
import { decodeGithubIssueBody, encodeGithubIssueBody, type GithubIssueMetadata } from '../issues/github-metadata';
import { validateParentLink } from '../issues/hierarchy';
import { issueGithubSlug } from '../issues/repo-scope';
import { isLocalServerAvailable } from '../tools/config';
import { getWorkspacePath } from './workspace';
import { runGithubSyncQueue } from '../issues/github-sync-queue';
import { normalizeWorkspacePath, relativeWorkspacePath } from '../lib/normalize-workspace-path';
import { fetchWorkspaceRepos } from './workspace-repos';
import {
  forgeScopeArgs,
  forgeScopeKey,
  githubLinkInScope,
  importScopes,
  resolveIssueForgeScope,
  resolveIssueForgeScopes,
  type IssueForgeScope,
} from '../issues/github-repo-scope';
import { githubRetryAt } from '../lib/github-rate-limit.mjs';

// ── Mode ─────────────────────────────────────────────────────────────────────

const MODE_STORAGE_KEY = 'minnow.issues.github.mode';
const AUTO_STORAGE_KEY = 'minnow.issues.github.auto';
const DELETE_BEHAVIOR_STORAGE_KEY = 'minnow.issues.github.deleteBehavior';

export type IssuesGithubDeleteBehavior = 'ask' | 'local' | 'github';

let cachedMode: IssuesGithubMode | null = null;
let cachedAuto: boolean | null = null;
let cachedDeleteBehavior: IssuesGithubDeleteBehavior | null = null;
const modeListeners = new Set<(mode: IssuesGithubMode) => void>();
const autoListeners = new Set<(enabled: boolean) => void>();

/** The settings-gated sync mode. Retired Link + push (`link`) becomes Off. */
export function getIssuesGithubMode(): IssuesGithubMode {
  if (cachedMode) return cachedMode;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(MODE_STORAGE_KEY);
  } catch {
    cachedMode = 'off';
    return cachedMode;
  }
  cachedMode = normalizeGithubMode(stored);
  // Persist the migration so Settings does not bounce back to a removed mode.
  if (stored === 'link' && cachedMode === 'off') {
    try {
      localStorage.setItem(MODE_STORAGE_KEY, 'off');
    } catch {}
  }
  return cachedMode;
}

/** Set the mode. Off is the default and always a safe answer. */
export function setIssuesGithubMode(mode: IssuesGithubMode): void {
  const next = normalizeGithubMode(mode);
  cachedMode = next;
  try {
    localStorage.setItem(MODE_STORAGE_KEY, next);
  } catch {}
  for (const listener of [...modeListeners]) {
    try {
      listener(next);
    } catch {}
  }
}

/** Subscribe to mode changes (settings ↔ Issues chrome). */
export function subscribeIssuesGithubMode(
  listener: (mode: IssuesGithubMode) => void,
): () => void {
  modeListeners.add(listener);
  return () => {
    modeListeners.delete(listener);
  };
}

/** Read the stored Auto checkbox. Ignored unless mode is Two-way mirror. */
export function getIssuesGithubAuto(): boolean {
  if (cachedAuto !== null) return cachedAuto;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(AUTO_STORAGE_KEY);
  } catch {
    cachedAuto = false;
    return cachedAuto;
  }
  cachedAuto = stored === 'true' || stored === '1';
  return cachedAuto;
}

/** Persist the Auto checkbox. Mode Off leaves this flag alone so it can come back. */
export function setIssuesGithubAuto(enabled: boolean): void {
  cachedAuto = Boolean(enabled);
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, cachedAuto ? 'true' : 'false');
  } catch {}
  for (const listener of [...autoListeners]) {
    try {
      listener(cachedAuto);
    } catch {}
  }
}

/** Subscribe to Auto checkbox changes (settings ↔ background loop). */
export function subscribeIssuesGithubAuto(listener: (enabled: boolean) => void): () => void {
  autoListeners.add(listener);
  return () => {
    autoListeners.delete(listener);
  };
}

/** True when Two-way mirror and Auto are both on. The only gate that may contact GitHub unattended. */
export function githubAutoSyncActive(): boolean {
  return getIssuesGithubMode() === 'mirror' && getIssuesGithubAuto();
}

/** How linked issue deletion should behave. Asking is the safe default. */
export function getIssuesGithubDeleteBehavior(): IssuesGithubDeleteBehavior {
  if (cachedDeleteBehavior) return cachedDeleteBehavior;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(DELETE_BEHAVIOR_STORAGE_KEY);
  } catch {
    cachedDeleteBehavior = 'ask';
    return cachedDeleteBehavior;
  }
  cachedDeleteBehavior = stored === 'local' || stored === 'github' ? stored : 'ask';
  return cachedDeleteBehavior;
}

/** Persist a remembered delete choice, or restore the prompt with `ask`. */
export function setIssuesGithubDeleteBehavior(behavior: IssuesGithubDeleteBehavior): void {
  cachedDeleteBehavior = behavior === 'local' || behavior === 'github' ? behavior : 'ask';
  try {
    localStorage.setItem(DELETE_BEHAVIOR_STORAGE_KEY, cachedDeleteBehavior);
  } catch {}
}

// Settings can live in a separate app window. Notify this renderer's loop too.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === MODE_STORAGE_KEY || event.key === null) {
      cachedMode = null;
      for (const listener of modeListeners) listener(getIssuesGithubMode());
    }
    if (event.key === AUTO_STORAGE_KEY || event.key === null) {
      cachedAuto = null;
      for (const listener of autoListeners) listener(getIssuesGithubAuto());
    }
    if (event.key === DELETE_BEHAVIOR_STORAGE_KEY || event.key === null) {
      cachedDeleteBehavior = null;
    }
  });
}

/** Every valid mode, for the settings control. */
export { ISSUES_GITHUB_MODES };

interface ForgeResponse {
  ok: boolean;
  error?: string;
  issue?: RemoteIssueSnapshot;
  issues?: RemoteIssueSnapshot[];
  nextCursor?: string;
  number?: number;
  url?: string;
  droppedLabels?: boolean;
}

/** Delete the linked GitHub issue without changing local state. */
export async function deleteIssueFromGithub(issueId: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    return await withIssueGithubLock(issueId, async () => {
      const issue = findIssueById(issueId);
      const number = issue?.github?.number;
      if (!issue || !number) return { ok: false, error: 'Issue is not linked to GitHub' };
      if (issue.githubReplicas?.length) {
        return { ok: false, error: 'This card has multiple GitHub copies. Delete them individually on GitHub, or delete only the local card.' };
      }
      const result = await forge('issueDelete', { number, ...forgeScopeArgs(await scopeForIssue(issue)) });
      return result.ok
        ? { ok: true }
        : {
            ok: false,
            error: userFacingGithubError(
              result.error,
              `Could not delete GitHub issue #${number}`,
            ),
          };
    });
  } catch (err) {
    return {
      ok: false,
      error: userFacingGithubError(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** The GitHub repo an issue syncs with (the workspace itself unless it holds several repos). */
export async function scopeForIssue(
  issue: Pick<NonNullable<ReturnType<typeof findIssueById>>, 'workspacePath' | 'repos' | 'github'>,
): Promise<IssueForgeScope> {
  const repos = issue.workspacePath ? await fetchWorkspaceRepos({ workspacePath: issue.workspacePath }) : [];
  if (!repos.length && issue.repos?.some((id) => id !== '.')) {
    throw new Error('Could not find the issue’s repository in its workspace.');
  }
  return resolveIssueForgeScope(issue, repos);
}

export async function scopesForIssue(issue: NonNullable<ReturnType<typeof findIssueById>>): Promise<IssueForgeScope[]> {
  const repos = issue.workspacePath ? await fetchWorkspaceRepos({ workspacePath: issue.workspacePath }) : [];
  if (!repos.length && (issue.githubReplicas?.length || issue.repos?.some((id) => id !== '.'))) {
    throw new Error('Could not find the issue’s repository in its workspace.');
  }
  return resolveIssueForgeScopes(issue, repos);
}

/**
 * POST /api/git for issue forge ops.
 *
 * Never throws. Never flips `localServerAvailable` — a GitHub-op failure
 * (timeout, 401, dropped socket) must not empty the file tree until restart
 * (MIN-660). Callers render `error` through `userFacingGithubError`.
 */
async function forge(op: string, args: Record<string, unknown> = {}): Promise<ForgeResponse> {
  if (!isLocalServerAvailable()) return { ok: false, error: 'server_off' };
  try {
    const res = await fetch('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...args }),
    });
    let payload: ForgeResponse | null = null;
    try {
      payload = (await res.json()) as ForgeResponse;
    } catch {
      payload = null;
    }
    if (payload && typeof payload === 'object') {
      const error =
        typeof payload.error === 'string' && payload.error.trim()
          ? payload.error
          : undefined;
      if (!res.ok) return { ok: false, error: error ?? `HTTP ${res.status}` };
      return payload;
    }
    return { ok: false, error: res.ok ? 'Could not read GitHub response' : `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: isLocalServerOfflineError(message) ? 'server_off' : message };
  }
}

export function localIsClosed(status: string): boolean {
  return isClosedStatus(getIssuesTaxonomySync(), status);
}

function portableFields(issue: NonNullable<ReturnType<typeof findIssueById>>, scope: IssueForgeScope): SyncFields {
  const taxonomy = getIssuesTaxonomySync();
  const type = taxonomy.types.find((row) => row.id === issue.type);
  const priority = taxonomy.priorities.find((row) => row.id === issue.priority);
  const status = taxonomy.statuses.find((row) => row.id === issue.status);
  if (!type || !priority || !status) throw new Error('Issue categorization is missing from the taxonomy');
  const project = issue.projectId ? findIssueProject(issue.projectId) : undefined;
  const parent = issue.parentId ? findIssueById(issue.parentId) : undefined;
  const parentLink = parent && githubLinkInScope(parent, scope);
  if (issue.parentId && (!parent || !parentLink || normalizeWorkspacePath(parent.workspacePath) !== normalizeWorkspacePath(issue.workspacePath))) {
    throw new Error('Sync the parent issue to the same repository before syncing this sub-issue.');
  }
  const metadata: GithubIssueMetadata = {
    version: 1,
    type: { id: type.id, label: type.label, order: 0 },
    priority: { id: priority.id, label: priority.label, order: 0 },
    status: { id: status.id, label: status.label, order: 0,
      ...(status.role ? { role: status.role } : {}), isClosed: Boolean(status.isClosed) },
    project: project ? { id: project.id, name: project.name } : null,
    parent: parentLink?.number ?? null,
    comments: structuredClone(issue.comments ?? []),
  };
  return { ...githubSyncedSnapshot(issue, localIsClosed(issue.status)), metadata };
}

function restoreCategories(metadata: GithubIssueMetadata): void {
  const taxonomy = getIssuesTaxonomySync();
  const next = structuredClone(taxonomy);
  for (const [catalog, item] of [
    ['types', metadata.type], ['priorities', metadata.priority], ['statuses', metadata.status],
  ] as const) {
    if (next[catalog].some((row) => row.id === item.id)) continue;
    // A workflow role already owned locally must not be duplicated by an import.
    const restored = { ...item, order: next[catalog].length };
    if ('role' in restored && next.statuses.some((row) => row.role === restored.role)) delete restored.role;
    next[catalog].push(restored);
  }
  if (JSON.stringify(next) !== JSON.stringify(taxonomy)) setIssuesTaxonomy(next);
}

/** Closed GitHub issues map to the done-role status when taxonomy has one. */
function statusForClosedRemote(): string | undefined {
  try {
    return requireIssueStatusForRole('done');
  } catch {
    return undefined;
  }
}

/** A conflict handed back for the user to resolve. Never resolved here. */
export interface SyncConflict {
  issueId: string;
  number: number;
  url: string;
  local: SyncFields;
  remote: SyncFields;
}

export interface SyncOutcome {
  ok: boolean;
  action: SyncAction['kind'];
  error?: string;
  conflict?: SyncConflict;
  /** Set when a label did not exist on the remote and was dropped to save the push. */
  droppedLabels?: boolean;
}

async function withIssueGithubLock<T>(issueId: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`minnow-issue-github:${issueId}`, run);
  }
  return run();
}

/** Read the remote counterpart of a linked issue, or null when unlinked. */
async function readRemote(issueId: string): Promise<RemoteIssueSnapshot | null> {
  const issue = findIssueById(issueId);
  const number = issue?.github?.number;
  if (!number || !issue) return null;
  return readScopedRemote(number, await scopeForIssue(issue));
}

async function readScopedRemote(number: number, scope: IssueForgeScope): Promise<RemoteIssueSnapshot> {
  const res = await forge('issueView', { number, ...forgeScopeArgs(scope) });
  if (!res.ok || !res.issue) throw new Error(res.error ?? 'Could not read the GitHub issue');
  return res.issue;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export interface GithubBatchSnapshot {
  remote: RemoteIssueSnapshot;
  workspacePath: string;
  syncedAt: number;
}

/** One batch per 50 identities; callers retain the per-issue lock for applying results. */
export async function readGithubIssueBatch(cwd: string, numbers: number[], repo?: string): Promise<ForgeResponse> {
  return forge('issueBatch', { cwd, numbers, ...(repo ? { repo } : {}) });
}

/** Sync one issue, resolving divergent edits by their most recent change. */
export async function syncIssueWithGithub(issueId: string, batch?: GithubBatchSnapshot): Promise<SyncOutcome> {
  try {
    return await withIssueGithubLock(issueId, async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await refreshIssuesFromStorage();
      }
      // Another window may have synced or relinked the card while the batch was
      // fetching. Never apply its older snapshot over the newer watermark.
      const current = findIssueById(issueId);
      if (batch && (!current?.github || current.workspacePath !== batch.workspacePath ||
          current.github.number !== batch.remote.number || current.github.syncedAt !== batch.syncedAt)) {
        return { ok: true, action: 'noop' };
      }
      const outcome = await runIssueSync(issueId, batch?.remote);
      if (
        getIssuesGithubMode() !== 'off' &&
        typeof navigator !== 'undefined' &&
        navigator.locks
      ) {
        await saveIssuesNow();
      }
      return outcome;
    });
  } catch (err) {
    return {
      ok: false,
      action: 'noop',
      error: userFacingGithubError(err instanceof Error ? err.message : String(err)),
    };
  }
}

/** Inner sync — throws only if the issues store itself is uninitialized. */
async function runIssueSync(issueId: string, snapshot?: RemoteIssueSnapshot): Promise<SyncOutcome> {
  const mode = getIssuesGithubMode();
  if (mode === 'off') return { ok: true, action: 'noop' };
  const initial = findIssueById(issueId);
  if (!initial) return { ok: false, action: 'noop', error: 'Issue not found' };
  const captured = { ...initial };
  const scopes = await scopesForIssue(captured);
  const targets: { scope: IssueForgeScope; remote: RemoteIssueSnapshot | null; prefersPull: boolean }[] = [];
  const errors: string[] = [];
  let outcome: SyncOutcome = { ok: true, action: 'noop' };
  function recordError(scope: IssueForgeScope, error: string) {
    errors.push(scopes.length > 1 && scope.repo ? `${scope.repo}: ${error}` : error);
  }
  for (const scope of scopes) {
    const link = githubLinkInScope(captured, scope);
    try {
      const remote = link ? (scopes.length === 1 && snapshot ? snapshot : await readScopedRemote(link.number, scope)) : null;
      targets.push({ scope, remote, prefersPull: false });
    } catch (err) {
      recordError(scope, userFacingGithubError(err instanceof Error ? err.message : String(err)));
      if (githubRetryAt(errors.at(-1)) > Date.now()) break;
    }
  }
  // Settle the newest eligible pull before writing other copies. A newer no-op
  // (for example an unrelated GitHub comment) must not hide an older pull.
  const latest = findIssueById(issueId);
  if (!latest || latest.workspacePath !== captured.workspacePath) return outcome;
  if (targets.length > 1) {
    for (const target of targets) {
      if (!target.remote) continue;
      try {
        const local = portableFields(latest, target.scope);
        target.prefersPull = planIssueSync({
          mode, issue: issueForTarget(latest, target.scope),
          isClosed: local.closed, local, remote: target.remote,
        }).kind === 'pull';
      } catch {
        // Report per-target preparation errors when executing that target.
      }
    }
    targets.sort((a, b) => Number(b.prefersPull) - Number(a.prefersPull) ||
      (b.remote?.updatedAt ?? -1) - (a.remote?.updatedAt ?? -1));
  }
  for (const { scope, remote } of targets) {
    if (githubRetryAt(errors.at(-1)) > Date.now() || getIssuesGithubMode() === 'off') break;
    try {
      const current = findIssueById(issueId);
      if (!current || current.workspacePath !== captured.workspacePath ||
          current.repos !== captured.repos && JSON.stringify(current.repos) !== JSON.stringify(captured.repos)) break;
      const result = await syncIssueTarget(issueId, scope, remote, scopes.length > 1);
      if (result.ok && result.action === 'pull' && scopes.length > 1) {
        // The other snapshots participated in this decision. A failed push
        // must leave the winning revision pending instead of pulling one of
        // those already considered snapshots back on the next retry.
        const pulled = findIssueById(issueId);
        if (pulled) {
          for (const other of targets) {
            if (other.scope === scope || other.remote?.updatedAt === undefined) continue;
            const copy = githubLinkInScope(pulled, other.scope);
            if (copy?.number === other.remote.number) {
              copy.remoteUpdatedAt = Math.max(copy.remoteUpdatedAt ?? 0, other.remote.updatedAt);
            }
          }
          scheduleSaveIssues();
        }
      }
      if (!result.ok) {
        if (result.conflict) return result;
        recordError(scope, result.error ?? 'Could not sync GitHub issue');
        if (scopes.length === 1) return result;
      }
      if (result.action !== 'noop' || targets.length === 1) {
        outcome = { ...result, droppedLabels: outcome.droppedLabels || result.droppedLabels };
      }
    } catch (err) {
      recordError(scope, userFacingGithubError(err instanceof Error ? err.message : String(err)));
    }
  }
  return errors.length ? { ...outcome, ok: false, error: errors.join('\n') } : outcome;
}

function issueForTarget(issue: NonNullable<ReturnType<typeof findIssueById>>, scope: IssueForgeScope) {
  const link = githubLinkInScope(issue, scope);
  return { ...issue, labels: [...issue.labels], github: link && {
    ...link, localChangedAt: issue.github?.localChangedAt ?? issue.updatedAt,
  } };
}

async function syncIssueTarget(issueId: string, scope: IssueForgeScope, remote: RemoteIssueSnapshot | null, multi: boolean): Promise<SyncOutcome> {
  let current = findIssueById(issueId);
  if (!current) return { ok: false, action: 'noop', error: 'Issue not found' };
  const remoteParentNumber = remote && decodeGithubIssueBody(remote.body).metadata?.parent;
  let parentId: string | undefined;
  if (remote) {
    const workspacePath = current.workspacePath;
    const number = githubLinkInScope(current, scope)?.number;
    const parent = await ensureRemoteParent(remote.number, remoteParentNumber, scope);
    // Parent discovery may take time; retain edits made while it was in flight.
    const latest = findIssueById(issueId);
    if (!latest || latest.workspacePath !== workspacePath || githubLinkInScope(latest, scope)?.number !== number) {
      return { ok: true, action: 'noop' };
    }
    current = latest;
    if (parent && validateParentLink(issueId, parent.id, listIssues()).ok) parentId = parent.id;
  }
  // Freeze the sent revision: edits during network calls must remain pending.
  const revision = current.github?.localChangedAt ?? current.updatedAt;
  const issue = issueForTarget(current, scope);
  const local = portableFields(issue, scope);
  // Keep the original GitHub relation in the payload when the local
  // one-level hierarchy cannot represent it and the user hasn't reparented it.
  if (local.metadata && remoteParentNumber && !parentId && !issue.parentId) {
    local.metadata.parent = remoteParentNumber;
  }
  const action = planIssueSync({
    mode: getIssuesGithubMode(),
    issue,
    isClosed: localIsClosed(issue.status),
    remote,
    local,
  });

  switch (action.kind) {
    case 'noop':
      if (remote && issue.github) {
        writeLink(issueId, issue.github.number, remote.url, remote.updatedAt, revision, scope);
      }
      return { ok: true, action: 'noop', error: action.reason };

    case 'create': {
      const res = await forge('issueCreate', {
        ...forgeScopeArgs(scope),
        title: issue.title,
        body: encodeGithubIssueBody(issue.description, local.metadata),
        labels: issue.labels,
      });
      if (!res.ok || !res.number) {
        return {
          ok: false,
          action: 'create',
          error: userFacingGithubError(res.error ?? 'Could not create the issue'),
        };
      }
      writeLink(issueId, res.number, res.url ?? '', undefined, local.closed ? 0 : revision, scope);
      if (localIsClosed(issue.status)) {
        const closed = await forge('issueState', { number: res.number, state: 'closed', ...forgeScopeArgs(scope) });
        if (!closed.ok) {
          // Keep the created identity, but leave the closed-state change pending.
          return { ok: false, action: 'create', error: closed.error };
        }
        writeLink(issueId, res.number, res.url ?? '', undefined, revision, scope);
      }
      return { ok: true, action: 'create', droppedLabels: res.droppedLabels };
    }

    case 'push': {
      const number = issue.github?.number;
      if (!number) return { ok: false, action: 'push', error: 'Not linked to a GitHub issue' };
      const res = await pushSyncedFieldsToGithub(number, action.fields, remote, forgeScopeArgs(scope));
      if (!res.ok) return { ok: false, action: 'push', error: res.error };
      const after = await readScopedRemote(number, scope);
      writeLink(issueId, number, issue.github?.url ?? '', after.updatedAt, revision, scope);
      return { ok: true, action: 'push', droppedLabels: res.droppedLabels };
    }

    case 'pull': {
      const number = issue.github?.number;
      if (!number || !remote) {
        return { ok: false, action: 'pull', error: 'Not linked to a GitHub issue' };
      }
      applyRemoteToIssue(issueId, action.fields, parentId);
      const pulled = findIssueById(issueId);
      if (multi && pulled?.github) {
        // A pull is a new local revision for every *other* replica.
        pulled.github.localChangedAt = Math.max(pulled.updatedAt, revision + 1, (remote.updatedAt ?? 0) + 1);
      }
      writeLink(issueId, number, issue.github?.url ?? remote.url, remote.updatedAt,
        multi ? pulled?.github?.localChangedAt : undefined, scope);
      return { ok: true, action: 'pull' };
    }

    case 'conflict':
      return {
        ok: false,
        action: 'conflict',
        conflict: {
          issueId,
          number: issue.github?.number ?? 0,
          url: issue.github?.url ?? '',
          local: action.local,
          remote: action.remote,
        },
      };

    default:
      return { ok: false, action: 'noop', error: 'Unrecognized sync action' };
  }
}

/** Resolve a conflict the user judged. Both branches then write the watermark. */
export async function resolveSyncConflict(
  conflict: SyncConflict,
  keep: 'local' | 'remote',
): Promise<SyncOutcome> {
  const issue = findIssueById(conflict.issueId);
  if (!issue) return { ok: false, action: 'noop', error: 'Issue not found' };
  let scope: IssueForgeScope;
  try {
    scope = await scopeForIssue(issue);
  } catch (err) {
    return { ok: false, action: 'noop', error: err instanceof Error ? err.message : String(err) };
  }

  if (keep === 'remote') {
    let parent: ReturnType<typeof findIssueById>;
    try {
      parent = await ensureRemoteParent(conflict.number, conflict.remote.metadata?.parent, scope);
    } catch (err) {
      return { ok: false, action: 'noop', error: err instanceof Error ? err.message : String(err) };
    }
    const parentId = parent && validateParentLink(issue.id, parent.id, listIssues()).ok ? parent.id : undefined;
    applyRemoteToIssue(conflict.issueId, conflict.remote, parentId);
    const after = await readRemote(conflict.issueId);
    writeLink(conflict.issueId, conflict.number, conflict.url, after?.updatedAt, undefined, scope);
    return { ok: true, action: 'pull' };
  }

  const res = await pushSyncedFieldsToGithub(conflict.number, conflict.local, {
    labels: conflict.remote.labels,
    state: conflict.remote.closed ? 'closed' : 'open',
  }, forgeScopeArgs(scope));
  if (!res.ok) return { ok: false, action: 'push', error: res.error };
  const after = await readRemote(conflict.issueId);
  writeLink(conflict.issueId, conflict.number, conflict.url, after?.updatedAt, undefined, scope);
  return { ok: true, action: 'push', droppedLabels: res.droppedLabels };
}

/**
 * Write synced fields to an existing GitHub issue.
 *
 * `gh issue edit` has no replace-all for labels, so this sends the add/remove
 * diff. Missing repo labels are created server-side before attach.
 */
async function pushSyncedFieldsToGithub(
  number: number,
  fields: SyncFields,
  remote: Pick<RemoteIssueSnapshot, 'labels' | 'state'> | null,
  target: { cwd?: string; repo?: string } = {},
): Promise<{ ok: boolean; error?: string; droppedLabels?: boolean }> {
  const { add, remove } = githubLabelDiff(fields.labels, remote?.labels ?? []);
  const res = await forge('issueEdit', {
    ...target,
    number,
    title: fields.title,
    body: encodeGithubIssueBody(fields.body, fields.metadata),
    addLabels: add,
    removeLabels: remove,
  });
  if (!res.ok) return { ok: false, error: userFacingGithubError(res.error) };

  if (remote && fields.closed !== (remote.state === 'closed')) {
    const stateResult = await forge('issueState', { number, state: fields.closed ? 'closed' : 'open', ...target });
    if (!stateResult.ok) return { ok: false, error: userFacingGithubError(stateResult.error) };
  }
  return { ok: true, droppedLabels: res.droppedLabels };
}

function applyRemoteToIssue(issueId: string, fields: SyncFields, parentId?: string): void {
  const metadata = fields.metadata;
  if (metadata) restoreCategories(metadata);
  const currentStatus = findIssueById(issueId)?.status;
  const metadataStatus = metadata && localIsClosed(metadata.status.id) === fields.closed ? metadata.status.id : undefined;
  const status = metadataStatus ?? (fields.closed ? statusForClosedRemote()
    : currentStatus && localIsClosed(currentStatus) ? requireIssueStatusForRole('backlog') : currentStatus);
  if (metadata?.project) restoreGithubIssueProject(metadata.project);
  // Pulls must not look like local edits or Auto would push the same fields back.
  updateIssue(
    issueId,
    {
      title: fields.title,
      description: fields.body,
      labels: fields.labels,
      ...(status ? { status } : {}),
      ...(metadata ? {
        type: metadata.type.id, priority: metadata.priority.id,
        projectId: metadata.project?.id ?? null, comments: metadata.comments,
        parentId: parentId ?? null,
      } : {}),
    },
    { skipGithubAutoSync: true },
  );
}

function writeLink(
  issueId: string,
  number: number,
  url: string,
  remoteUpdatedAt: number | undefined,
  syncedLocalUpdatedAt?: number,
  scope?: IssueForgeScope,
): void {
  const issue = findIssueById(issueId);
  if (!issue) return;
  const localChangedAt = issue.github?.localChangedAt ?? issue.updatedAt;
  const previous = scope ? githubLinkInScope(issue, scope) : issue.github;
  const link = nextGithubLink({
    previous,
    number,
    url,
    ...(scope?.slug ? { repo: scope.slug } : {}),
    localUpdatedAt: syncedLocalUpdatedAt ?? issue.updatedAt,
    remoteUpdatedAt,
    now: Date.now(),
  });
  link.localChangedAt = localChangedAt;
  if (!issue.github || previous === issue.github) {
    issue.github = link;
  } else {
    issue.githubReplicas = [...(issue.githubReplicas ?? []).filter((copy) => copy !== previous), link];
  }
  appendIssueLinks(issueId, {
    gitLinks: [{ kind: 'github-issue', ref: `#${number}`, url, ...(scope?.repo ? { repo: scope.repo } : {}) }],
  });
  scheduleSaveIssues();
}

function findLinkedGithubIssue(number: number, workspacePath: string, scope?: IssueForgeScope) {
  return listIssues().find((row) => normalizeWorkspacePath(row.workspacePath) === normalizeWorkspacePath(workspacePath) &&
    (scope ? githubLinkInScope(row, scope) : row.github)?.number === number);
}

/** Restore an identity only after its parent is available; never watermark a partial import. */
function importRemoteIssue(remote: RemoteIssueSnapshot, scope: IssueForgeScope, parentId?: string) {
  const decoded = decodeGithubIssueBody(remote.body);
  if (decoded.metadata) restoreCategories(decoded.metadata);
  const card = addIssue({
    title: remote.title || `GitHub #${remote.number}`,
    description: decoded.body,
    labels: remote.labels,
    workspacePath: scope.cwd,
    ...(scope?.repo ? { repos: [scope.repo] } : {}),
    source: 'github',
    ...(parentId ? { parentId } : {}),
    ...(remote.state === 'closed' && statusForClosedRemote() ? { status: statusForClosedRemote() } : {}),
  });
  applyRemoteToIssue(card.id, {
    title: remote.title || `GitHub #${remote.number}`, body: decoded.body,
    labels: remote.labels, closed: remote.state === 'closed', metadata: decoded.metadata,
  }, parentId);
  writeLink(card.id, remote.number, remote.url, remote.updatedAt, undefined, scope);
  return card;
}

/** Closed/older parents may be absent from discovery; read their exact identity. */
async function ensureRemoteParent(
  childNumber: number,
  number: number | null | undefined,
  scope: IssueForgeScope,
  available = new Map<number, RemoteIssueSnapshot>(),
  imported = new Set<string>(),
): Promise<ReturnType<typeof findIssueById>> {
  if (!number) return;
  if (number === childNumber) throw new Error('An issue cannot be its own parent.');
  const existing = findLinkedGithubIssue(number, scope.cwd, scope);
  if (existing) return existing.parentId ? undefined : existing;
  let parent = available.get(number);
  if (!parent) {
    const result = await forge('issueView', { number, ...forgeScopeArgs(scope) });
    if (!result.ok || !result.issue || result.issue.number !== number) {
      throw new Error(`Could not import parent GitHub issue #${number}: ${result.error ?? 'Could not read the GitHub issue'}`);
    }
    parent = result.issue;
  }
  const ancestor = decodeGithubIssueBody(parent.body).metadata?.parent;
  if (ancestor === number || ancestor === childNumber) throw new Error('The GitHub issue hierarchy contains a cycle.');
  if (ancestor) return;
  // Another worker may have imported this same parent while the read was pending.
  const restored = findLinkedGithubIssue(number, scope.cwd, scope);
  if (restored) return restored.parentId ? undefined : restored;
  const card = importRemoteIssue(parent, scope);
  imported.add(card.id);
  return card;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  imported: number;
  skipped: number;
}

// ── Import ───────────────────────────────────────────────────────────────────

/**
 * Import remote issues that are not already linked.
 *
 * Imported cards land in the Triage lane (`source: 'github'`, no `triagedAt`),
 * which is the whole reason Triage keys off source rather than status: a
 * hundred imported issues must not silently become a hundred backlog items.
 *
 * Never throws: a failed import is `{ ok: false, error }` with user-facing copy
 * so Settings can show a dialog without taking down the rest of the SPA (MIN-660).
 */
export async function importGithubIssues(options?: {
  state?: 'open' | 'closed' | 'all';
  limit?: number;
  workspacePath?: string;
  allPages?: boolean;
  userInitiated?: boolean;
}): Promise<ImportResult> {
  // Keep the destination fixed if the user switches workspaces during the fetch.
  const workspacePath = normalizeWorkspacePath(options?.workspacePath ?? getWorkspacePath());
  try {
    if (!options?.userInitiated && getIssuesGithubMode() === 'off') {
      return { ok: false, error: 'GitHub sync is off', imported: 0, skipped: 0 };
    }

    if (!isIssuesStoreLoaded()) {
      return {
        ok: false,
        error: 'Issues are still loading. Try again in a moment.',
        imported: 0,
        skipped: 0,
      };
    }

    // A folder of several repos imports from each repo's remote in turn.
    const scopes = importScopes(workspacePath, workspacePath ? await fetchWorkspaceRepos({ workspacePath }) : []);
    const imported = new Set<string>();
    const childUrls = new Set<string>();
    const childIdentities = new Set<string>();
    for (const issue of collectIssues({ workspacePath, includeSubWorkspaces: true, hideDone: false })) {
      if (!issue.github || relativeWorkspacePath(workspacePath, issue.workspacePath) === '.') continue;
      for (const github of [issue.github, ...(issue.githubReplicas ?? [])]) {
        if (github.url) childUrls.add(github.url.toLowerCase());
        else if (github.repo) childIdentities.add(`${issueGithubSlug({ github })}#${github.number}`);
      }
    }
    const errors: string[] = [];
    let skipped = 0;
    for (const scope of scopes) {
      const linked = new Set(
        collectIssues({ scope: 'current_workspace', workspacePath, includeSubWorkspaces: true, hideDone: false })
          .filter((issue) => !workspacePath || relativeWorkspacePath(workspacePath, issue.workspacePath) === '.')
          .map((issue) => githubLinkInScope(issue, scope)?.number)
          .filter((n): n is number => typeof n === 'number'),
      );

      try {
        let cursor: string | null | undefined = options?.allPages ? null : undefined;
        const seenCursors = new Set<string>();
        do {
          const res = await forge('issueList', {
            state: options?.allPages ? 'all' : options?.state ?? 'open',
            limit: options?.limit ?? 100,
            ...forgeScopeArgs(scope),
            ...(cursor !== undefined ? { cursor } : {}),
          });
          if (!res.ok || !Array.isArray(res.issues)) throw new Error(res.error ?? 'Could not list issues');
          const available = new Map(res.issues.map((remote) => [remote.number, remote]));
          for (const remote of res.issues) {
            const linkedInChild = childUrls.has(remote.url.toLowerCase()) ||
              childIdentities.has(`${scope.slug?.toLowerCase()}#${remote.number}`);
            if (linked.has(remote.number) || linkedInChild) {
              skipped += 1;
              continue;
            }
            try {
              const parent = await ensureRemoteParent(
                remote.number, decodeGithubIssueBody(remote.body).metadata?.parent, scope, available, imported,
              );
              if (!findLinkedGithubIssue(remote.number, workspacePath, scope)) {
                imported.add(importRemoteIssue(remote, scope, parent?.id).id);
                linked.add(remote.number);
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              if (githubRetryAt(error) > Date.now()) throw err;
              errors.push(`${scope.repo ? `${scope.repo} ` : ''}#${remote.number}: ${userFacingGithubError(error)}`);
            }
          }
          cursor = options?.allPages ? res.nextCursor : undefined;
          if (cursor) {
            if (seenCursors.has(cursor)) throw new Error('GitHub returned the same issue page twice');
            seenCursors.add(cursor);
          }
        } while (cursor);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        errors.push(scope.repo ? `${scope.repo}: ${userFacingGithubError(error)}` : userFacingGithubError(error));
        if (githubRetryAt(error) > Date.now()) break;
      }
    }
    return { ok: !errors.length, imported: imported.size, skipped, ...(errors.length ? { error: errors.join('\n') } : {}) };
  } catch (err) {
    return {
      ok: false,
      error: userFacingGithubError(err instanceof Error ? err.message : String(err)),
      imported: 0,
      skipped: 0,
    };
  }
}

/** Import missing remote issues, then sync existing cards within the selected scope. */
export async function syncAllIssuesWithGithub(options?: {
  /** Only sync linked cards; skip discovery and unlinked creates for pollers. */
  linkedOnly?: boolean;
  /** Match Issues list scope; defaults to the current workspace. */
  scope?: 'all' | 'current_workspace';
  workspacePath?: string;
}): Promise<{
  synced: number;
  imported: number;
  conflicts: SyncConflict[];
  errors: string[];
}> {
  const conflicts: SyncConflict[] = [];
  const errors: string[] = [];
  let synced = 0;
  let imported = 0;

  const mode = getIssuesGithubMode();
  if (mode === 'off') return { synced, imported, conflicts, errors };

  const workspacePath = normalizeWorkspacePath(options?.workspacePath ?? getWorkspacePath());
  const issues = collectIssues({
    scope: options?.scope ?? 'current_workspace',
    workspacePath,
    includeSubWorkspaces: true,
    hideDone: false,
  });

  if (!options?.linkedOnly) {
    const workspaces = new Set([
      workspacePath,
      ...(options?.scope === 'all' ? issues.map((issue) => normalizeWorkspacePath(issue.workspacePath)) : []),
    ]);
    for (const path of workspaces) {
      // Scratch cards have no repository to discover issues from.
      if (!path) continue;
      const result = await importGithubIssues({ workspacePath: path, allPages: true, limit: 500 });
      imported += result.imported;
      if (!result.ok) errors.push(`${path}: ${result.error ?? 'Could not import GitHub issues'}`);
      if (githubRetryAt(result.error) > Date.now()) return { synced, imported, conflicts, errors };
    }
  }

  // Newly imported cards already have their remote content and sync watermark.
  const eligible = issues.filter((issue) => !options?.linkedOnly || issue.github);
  const outcomes = new Map<string, SyncOutcome>();
  let retryAt = 0;
  // One batch read per remote: a workspace, or one repo of a multi-repo workspace.
  const groups = new Map<string, { scope: IssueForgeScope; issues: typeof eligible }>();
  const multi = new Set<string>();
  const singleScopes = new Map<string, IssueForgeScope>();
  for (const issue of eligible) {
    try {
      const scopes = await scopesForIssue(issue);
      if (scopes.length > 1) multi.add(issue.id);
      else singleScopes.set(issue.id, scopes[0]);
    } catch (err) {
      outcomes.set(issue.id, { ok: false, action: 'noop', error: err instanceof Error ? err.message : String(err) });
      continue;
    }
  }
  const direct = eligible.filter((issue) => multi.has(issue.id) ||
    (issue.parentId && multi.has(issue.parentId) && singleScopes.has(issue.id)));
  for (const issue of eligible) {
    const scope = singleScopes.get(issue.id);
    if (!scope || (issue.parentId && multi.has(issue.parentId))) continue;
    const key = forgeScopeKey(scope);
    const group = groups.get(key) ?? { scope, issues: [] };
    group.issues.push(issue);
    groups.set(key, group);
  }
  for (const { scope, issues: grouped } of groups.values()) {
    const cwd = scope.cwd ?? '';
    const ordered = [...grouped]
      .sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
    for (let offset = 0; offset < ordered.length && Date.now() >= retryAt; offset += 50) {
      const batch = ordered.slice(offset, offset + 50).map((issue) => ({ ...issue, github: issue.github ? { ...issue.github } : undefined }));
      const numbers = batch.flatMap((issue) => issue.github ? [issue.github.number] : []);
      const result = numbers.length ? await readGithubIssueBatch(cwd, numbers, scope.repo) : { ok: true, issues: [] };
      retryAt = Math.max(retryAt, githubRetryAt(result.error));
      const remotes = new Map(result.issues?.map((remote) => [remote.number, remote]));
      await runGithubSyncQueue(batch, async (issue) => {
        let outcome: SyncOutcome;
        const remote = issue.github ? remotes.get(issue.github.number) : undefined;
        if (issue.github && (!result.ok || !remote)) {
          outcome = { ok: false, action: 'noop', error: result.error ?? `Could not read GitHub issue #${issue.github.number}` };
        } else {
          outcome = await syncIssueWithGithub(issue.id, remote && issue.github ? {
            remote, workspacePath: cwd, syncedAt: issue.github.syncedAt,
          } : undefined);
        }
        outcomes.set(issue.id, outcome);
        retryAt = Math.max(retryAt, githubRetryAt(outcome.error));
      }, () => Date.now() >= retryAt && getIssuesGithubMode() !== 'off');
      if (!result.ok) {
        for (const issue of batch.filter((issue) => issue.github)) {
          outcomes.set(issue.id, { ok: false, action: 'noop', error: result.error });
        }
      }
    }
  }
  await runGithubSyncQueue(direct, async (issue) => {
    const outcome = await syncIssueWithGithub(issue.id);
    outcomes.set(issue.id, outcome);
    retryAt = Math.max(retryAt, githubRetryAt(outcome.error));
  }, () => Date.now() >= retryAt && getIssuesGithubMode() !== 'off');
  if (Date.now() < retryAt) errors.push(`GitHub sync paused. Retry after ${new Date(retryAt).toISOString()}`);
  // Report in list order even when network requests complete out of order.
  for (const issue of eligible) {
    const outcome = outcomes.get(issue.id);
    if (!outcome) continue;
    if (outcome.conflict) conflicts.push(outcome.conflict);
    else if (outcome.ok && outcome.action !== 'noop') synced += 1;
    else if (!outcome.ok && outcome.error && !isLocalServerOfflineError(outcome.error)) {
      errors.push(`${issue.id}: ${outcome.error}`);
    }
  }
  return { synced, imported, conflicts, errors };
}

/** Reset cached settings (tests). */
export function resetIssuesGithubForTests(): void {
  cachedMode = null;
  cachedAuto = null;
  cachedDeleteBehavior = null;
  modeListeners.clear();
  autoListeners.clear();
}
