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
import { userFacingGithubError, isLocalServerOfflineError, isGithubRateLimitError } from '../issues/github-error';
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
import { isLocalServerAvailable } from '../tools/config';
import { getWorkspacePath } from './workspace';
import { runGithubSyncQueue } from '../issues/github-sync-queue';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';

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
  number?: number;
  url?: string;
  droppedLabels?: boolean;
  cursor?: number;
}

/** Incremental, paginated repository feed; includes updates to closed issues. */
export async function readGithubIssueChanges(cwd: string, since?: number): Promise<ForgeResponse> {
  return forge('issueChanges', { cwd, ...(since != null ? { since } : {}) });
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
      const result = await forge('issueDelete', { number, cwd: issue.workspacePath });
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

function localIsClosed(status: string): boolean {
  return isClosedStatus(getIssuesTaxonomySync(), status);
}

function portableFields(issue: NonNullable<ReturnType<typeof findIssueById>>): SyncFields {
  const taxonomy = getIssuesTaxonomySync();
  const type = taxonomy.types.find((row) => row.id === issue.type);
  const priority = taxonomy.priorities.find((row) => row.id === issue.priority);
  const status = taxonomy.statuses.find((row) => row.id === issue.status);
  if (!type || !priority || !status) throw new Error('Issue categorization is missing from the taxonomy');
  const project = issue.projectId ? findIssueProject(issue.projectId) : undefined;
  const parent = issue.parentId ? findIssueById(issue.parentId) : undefined;
  if (issue.parentId && (!parent?.github || parent.workspacePath !== issue.workspacePath)) {
    throw new Error('Sync the parent issue in the same workspace before syncing this sub-issue.');
  }
  const metadata: GithubIssueMetadata = {
    version: 1,
    type: { id: type.id, label: type.label, order: 0 },
    priority: { id: priority.id, label: priority.label, order: 0 },
    status: { id: status.id, label: status.label, order: 0,
      ...(status.role ? { role: status.role } : {}), isClosed: Boolean(status.isClosed) },
    project: project ? { id: project.id, name: project.name } : null,
    parent: parent?.github?.number ?? null,
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
  if (!number) return null;
  const res = await forge('issueView', { number, cwd: issue?.workspacePath });
  if (!res.ok || !res.issue) throw new Error(res.error ?? 'Could not read the GitHub issue');
  return res.issue;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Sync one issue, resolving divergent edits by their most recent change. */
export async function syncIssueWithGithub(issueId: string, snapshot?: {
  workspacePath: string;
  remote: RemoteIssueSnapshot;
}): Promise<SyncOutcome> {
  try {
    return await withIssueGithubLock(issueId, async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        await refreshIssuesFromStorage();
      }
      const outcome = await runIssueSync(issueId, snapshot);
      if (
        outcome.ok &&
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
async function runIssueSync(issueId: string, snapshot?: {
  workspacePath: string;
  remote: RemoteIssueSnapshot;
}): Promise<SyncOutcome> {
  const mode = getIssuesGithubMode();
  if (mode === 'off') return { ok: true, action: 'noop' };
  const before = findIssueById(issueId);
  const remote = snapshot && before?.github?.number === snapshot.remote.number &&
    normalizeWorkspacePath(before.workspacePath) === normalizeWorkspacePath(snapshot.workspacePath) &&
    (snapshot.remote.updatedAt ?? 0) >= (before.github.remoteUpdatedAt ?? 0)
    ? snapshot.remote : await readRemote(issueId);
  const current = findIssueById(issueId);
  if (!current) return { ok: false, action: 'noop', error: 'Issue not found' };
  const remoteParent = remote ? decodeGithubIssueBody(remote.body).metadata?.parent : null;
  if (remoteParent && !listIssues().some((row) => row.workspacePath === current.workspacePath && row.github?.number === remoteParent)) {
    return { ok: false, action: 'noop', error: `Import parent GitHub issue #${remoteParent} before syncing this sub-issue.` };
  }
  // Freeze the sent revision: edits during network calls must remain pending.
  const issue = { ...current, labels: [...current.labels] };
  const local = portableFields(issue);
  const action = planIssueSync({
    mode,
    issue,
    isClosed: localIsClosed(issue.status),
    remote,
    local,
  });

  switch (action.kind) {
    case 'noop':
      if (remote && issue.github) {
        writeLink(issueId, issue.github.number, remote.url, remote.updatedAt, issue.updatedAt);
      }
      return { ok: true, action: 'noop', error: action.reason };

    case 'create': {
      const res = await forge('issueCreate', {
        cwd: issue.workspacePath,
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
      writeLink(issueId, res.number, res.url ?? '', undefined, issue.updatedAt);
      if (localIsClosed(issue.status)) {
        const closed = await forge('issueState', { number: res.number, state: 'closed', cwd: issue.workspacePath });
        if (!closed.ok) {
          // Keep the created identity, but leave the closed-state change pending.
          const linked = findIssueById(issueId)?.github;
          if (linked) linked.localUpdatedAt = 0;
          scheduleSaveIssues();
          return { ok: false, action: 'create', error: closed.error };
        }
      }
      return { ok: true, action: 'create', droppedLabels: res.droppedLabels };
    }

    case 'push': {
      const number = issue.github?.number;
      if (!number) return { ok: false, action: 'push', error: 'Not linked to a GitHub issue' };
      const res = await pushSyncedFieldsToGithub(number, action.fields, remote, issue.workspacePath);
      if (!res.ok) return { ok: false, action: 'push', error: res.error };
      const after = await readRemote(issueId);
      writeLink(issueId, number, issue.github?.url ?? '', after?.updatedAt, issue.updatedAt);
      return { ok: true, action: 'push', droppedLabels: res.droppedLabels };
    }

    case 'pull': {
      const number = issue.github?.number;
      if (!number || !remote) {
        return { ok: false, action: 'pull', error: 'Not linked to a GitHub issue' };
      }
      applyRemoteToIssue(issueId, action.fields);
      writeLink(issueId, number, issue.github?.url ?? remote.url, remote.updatedAt);
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

  if (keep === 'remote') {
    applyRemoteToIssue(conflict.issueId, conflict.remote);
    const after = await readRemote(conflict.issueId);
    writeLink(conflict.issueId, conflict.number, conflict.url, after?.updatedAt);
    return { ok: true, action: 'pull' };
  }

  const res = await pushSyncedFieldsToGithub(conflict.number, conflict.local, {
    labels: conflict.remote.labels,
    state: conflict.remote.closed ? 'closed' : 'open',
  }, issue.workspacePath);
  if (!res.ok) return { ok: false, action: 'push', error: res.error };
  const after = await readRemote(conflict.issueId);
  writeLink(conflict.issueId, conflict.number, conflict.url, after?.updatedAt);
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
  cwd?: string,
): Promise<{ ok: boolean; error?: string; droppedLabels?: boolean }> {
  const { add, remove } = githubLabelDiff(fields.labels, remote?.labels ?? []);
  const res = await forge('issueEdit', {
    cwd,
    number,
    title: fields.title,
    body: encodeGithubIssueBody(fields.body, fields.metadata),
    addLabels: add,
    removeLabels: remove,
  });
  if (!res.ok) return { ok: false, error: userFacingGithubError(res.error) };

  if (remote && fields.closed !== (remote.state === 'closed')) {
    const stateResult = await forge('issueState', { number, state: fields.closed ? 'closed' : 'open', cwd });
    if (!stateResult.ok) return { ok: false, error: userFacingGithubError(stateResult.error) };
  }
  return { ok: true, droppedLabels: res.droppedLabels };
}

function applyRemoteToIssue(issueId: string, fields: SyncFields): void {
  const metadata = fields.metadata;
  const current = findIssueById(issueId);
  const parent = metadata?.parent ? listIssues().find((row) => row.workspacePath === current?.workspacePath && row.github?.number === metadata.parent) : undefined;
  if (metadata?.parent && !parent) throw new Error(`Import parent GitHub issue #${metadata.parent} before syncing this sub-issue.`);
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
        ...(metadata.parent === null ? { parentId: null } : parent ? { parentId: parent.id } : {}),
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
): void {
  const issue = findIssueById(issueId);
  if (!issue) return;
  const localChangedAt = issue.github?.localChangedAt ?? issue.updatedAt;
  issue.github = nextGithubLink({
    previous: issue.github,
    number,
    url,
    localUpdatedAt: syncedLocalUpdatedAt ?? issue.updatedAt,
    remoteUpdatedAt,
    now: Date.now(),
  });
  issue.github.localChangedAt = localChangedAt;
  appendIssueLinks(issueId, {
    gitLinks: [{ kind: 'github-issue', ref: `#${number}`, url }],
  });
  scheduleSaveIssues();
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
  /** Reuse a complete repository feed during Sync all. */
  remoteIssues?: RemoteIssueSnapshot[];
}): Promise<ImportResult> {
  // Keep the destination fixed if the user switches workspaces during the fetch.
  const workspacePath = normalizeWorkspacePath(options?.workspacePath ?? getWorkspacePath());
  try {
    if (getIssuesGithubMode() === 'off') {
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

    const res = options?.remoteIssues ? { ok: true, issues: options.remoteIssues } : await forge('issueList', {
      state: options?.state ?? 'open',
      limit: options?.limit ?? 100,
      cwd: workspacePath,
    });
    if (!res.ok || !Array.isArray(res.issues)) {
      return {
        ok: false,
        error: userFacingGithubError(res.error ?? 'Could not list issues'),
        imported: 0,
        skipped: 0,
      };
    }

    const linked = new Set(
      collectIssues({ scope: 'current_workspace', workspacePath, hideDone: false })
        .map((issue) => issue.github?.number)
        .filter((n): n is number => typeof n === 'number'),
    );

    let imported = 0;
    let skipped = 0;
    const importedCards: Array<{ id: string; remote: RemoteIssueSnapshot }> = [];
    const closedStatus = statusForClosedRemote();

    for (const remote of res.issues) {
      if (linked.has(remote.number)) {
        skipped += 1;
        continue;
      }
      try {
        const decoded = decodeGithubIssueBody(remote.body);
        if (decoded.metadata) restoreCategories(decoded.metadata);
        const card = addIssue({
          title: remote.title || `GitHub #${remote.number}`,
          description: decoded.body,
          labels: remote.labels,
          workspacePath,
          source: 'github',
          ...(remote.state === 'closed' && closedStatus ? { status: closedStatus } : {}),
        });
        writeLink(card.id, remote.number, remote.url, remote.updatedAt);
        importedCards.push({ id: card.id, remote });
        linked.add(remote.number);
        imported += 1;
      } catch {}
    }

    // All identities must exist before resolving portable parent issue numbers.
    for (const { id, remote } of importedCards) {
      const decoded = decodeGithubIssueBody(remote.body);
      try {
        applyRemoteToIssue(id, {
          title: remote.title || `GitHub #${remote.number}`, body: decoded.body,
          labels: remote.labels, closed: remote.state === 'closed', metadata: decoded.metadata,
        });
        writeLink(id, remote.number, remote.url, remote.updatedAt);
      } catch (err) {
        scheduleSaveIssues();
        return { ok: false, imported, skipped, error: userFacingGithubError(err instanceof Error ? err.message : String(err)) };
      }
    }

    if (imported > 0) scheduleSaveIssues();
    return { ok: true, imported, skipped };
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
    hideDone: false,
  });

  const remotes = new Map<string, Map<number, RemoteIssueSnapshot>>();
  const workspaces = new Set([
    ...(!options?.linkedOnly ? [workspacePath] : []),
    ...issues.filter((issue) => !options?.linkedOnly || issue.github)
      .map((issue) => normalizeWorkspacePath(issue.workspacePath)),
  ]);
  let rateLimited = false;
  for (const path of workspaces) {
    if (!path) continue;
    const feed = await readGithubIssueChanges(path);
    if (!feed.ok || !Array.isArray(feed.issues)) {
      errors.push(`${path}: ${feed.error ?? 'Could not read GitHub issues'}`);
      if (isGithubRateLimitError(feed.error)) { rateLimited = true; break; }
      continue;
    }
    remotes.set(path, new Map(feed.issues.map((issue) => [issue.number, issue])));
    if (!options?.linkedOnly) {
      const result = await importGithubIssues({ workspacePath: path, remoteIssues: feed.issues });
      imported += result.imported;
      if (!result.ok) errors.push(`${path}: ${result.error ?? 'Could not import GitHub issues'}`);
    }
  }

  // Newly imported cards already have their remote content and sync watermark.
  const eligible = issues.filter((issue) => !options?.linkedOnly || issue.github);
  const outcomes = new Map<string, SyncOutcome>();
  await runGithubSyncQueue(eligible, async (issue) => {
    const path = normalizeWorkspacePath(issue.workspacePath);
    if (issue.github && path && !remotes.has(path)) return;
    const remote = issue.github ? remotes.get(path)?.get(issue.github.number) : undefined;
    const outcome = await syncIssueWithGithub(issue.id, remote ? { workspacePath: path, remote } : undefined);
    outcomes.set(issue.id, outcome);
    if (isGithubRateLimitError(outcome.error)) rateLimited = true;
  }, () => !rateLimited && getIssuesGithubMode() !== 'off');
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
