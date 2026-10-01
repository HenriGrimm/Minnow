/**
 * What syncing one issue with GitHub should do — decided before anything runs.
 *
 * Mirror sync uses content and per-side watermarks. When both sides changed,
 * the most recent edit wins; equal timestamps prefer GitHub deterministically.
 * Off never contacts GitHub.
 *
 * Stored `'link'` (retired Link + push) normalizes to `'off'` so those
 * workspaces stop syncing until the user opts into Two-way mirror.
 *
 * Phase 5 of `documentation/plans/issues-app-v2.md`.
 */

import { normalizeIssueLabelsList } from './label-catalog';
import { decodeGithubIssueBody, githubMetadataKey, type GithubIssueMetadata } from './github-metadata';
import type { IssueCard, IssueGitLink, IssueGithubLink } from '../types';

/** Settings-gated sync mode. */
export type IssuesGithubMode = 'off' | 'mirror';

export const ISSUES_GITHUB_MODES: readonly IssuesGithubMode[] = ['off', 'mirror'];

/** Human labels for the settings control. */
export const ISSUES_GITHUB_MODE_LABELS: Record<IssuesGithubMode, string> = {
  off: 'Off',
  mirror: 'Two-way mirror',
};

/** The remote fields sync compares against. */
export interface RemoteIssueSnapshot {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  updatedAt?: number;
}

export type SyncAction =
  /** Nothing to do. */
  | { kind: 'noop'; reason: string }
  /** Create the issue on GitHub. */
  | { kind: 'create' }
  /** Overwrite the remote from local. */
  | { kind: 'push'; fields: SyncFields }
  /** Overwrite local from the remote. */
  | { kind: 'pull'; fields: SyncFields }
  /** Both sides changed. The user picks. */
  | { kind: 'conflict'; local: SyncFields; remote: SyncFields };

/** The fields that participate in sync. Everything else is local-only. */
export interface SyncFields {
  title: string;
  body: string;
  closed: boolean;
  labels: string[];
  metadata?: GithubIssueMetadata;
  /** Local ids participate in edit detection, but never travel to another machine. */
  localCategory?: string;
}

/** Snapshot for edit detection, including portable categories and the comment timeline. */
export function githubSyncedSnapshot(
  issue: Pick<IssueCard, 'title' | 'description' | 'labels'> & Partial<IssueCard>,
  isClosed: boolean,
): SyncFields {
  return {
    title: issue.title,
    body: issue.description,
    closed: isClosed,
    labels: [...issue.labels],
    localCategory: JSON.stringify([issue.type, issue.priority, issue.status, issue.projectId, issue.parentId, issue.comments ?? []]),
  };
}

function localFields(issue: IssueCard, isClosed: boolean): SyncFields {
  return githubSyncedSnapshot(issue, isClosed);
}

function remoteFields(remote: RemoteIssueSnapshot): SyncFields {
  const decoded = decodeGithubIssueBody(remote.body);
  return {
    title: remote.title,
    body: decoded.body,
    closed: remote.state === 'closed',
    labels: [...remote.labels],
    ...(decoded.metadata ? { metadata: decoded.metadata } : {}),
  };
}

/** True when the two sides carry the same synced content. */
export function syncFieldsEqual(a: SyncFields, b: SyncFields): boolean {
  const localLabels = normalizeIssueLabelsList(a.labels);
  const remoteLabels = normalizeIssueLabelsList(b.labels);
  const remoteKeys = new Set(remoteLabels.map((label) => label.toLowerCase()));
  return (
    a.title.trim() === b.title.trim() &&
    a.body.trim() === b.body.trim() &&
    a.closed === b.closed &&
    (a.localCategory === undefined || b.localCategory === undefined || a.localCategory === b.localCategory) &&
    (!a.metadata || !b.metadata || githubMetadataKey(a.metadata) === githubMetadataKey(b.metadata)) &&
    localLabels.length === remoteLabels.length &&
    localLabels.every((label) => remoteKeys.has(label.toLowerCase()))
  );
}

/**
 * Names to add and remove so GitHub's issue matches the local set.
 *
 * `gh issue edit` has no replace-all. Compare case-insensitively (GitHub does)
 * but remove with the remote's casing so `--remove-label` hits the real name.
 */
export function githubLabelDiff(
  local: readonly string[],
  remote: readonly string[],
): { add: string[]; remove: string[] } {
  const localNames = normalizeIssueLabelsList(local);
  const remoteNames = normalizeIssueLabelsList(remote);
  const remoteKeys = new Set(remoteNames.map((name) => name.toLowerCase()));
  const localKeys = new Set(localNames.map((name) => name.toLowerCase()));
  return {
    add: localNames.filter((name) => !remoteKeys.has(name.toLowerCase())),
    remove: remoteNames.filter((name) => !localKeys.has(name.toLowerCase())),
  };
}

/** True when a local write actually changed GitHub-shaped fields (not rank, assignee, …). */
export function githubSyncedFieldsChanged(before: SyncFields, after: SyncFields): boolean {
  return !syncFieldsEqual(before, after);
}

export interface PlanSyncInput {
  mode: IssuesGithubMode;
  issue: IssueCard;
  /** Whether the local status maps to closed. Taxonomy lives outside this module. */
  isClosed: boolean;
  /** Remote record, or null when the issue has never been pushed. */
  remote: RemoteIssueSnapshot | null;
  local?: SyncFields;
}

/**
 * Decide the single action for one issue.
 *
 * Reads only timestamps and content — no clock, no I/O — so every branch is
 * reachable from a test.
 */
export function planIssueSync(input: PlanSyncInput): SyncAction {
  const { mode, issue, remote, isClosed } = input;

  if (mode === 'off') return { kind: 'noop', reason: 'GitHub sync is off' };

  const link = issue.github;
  const local = input.local ?? localFields(issue, isClosed);

  if (!link || !remote) {
    if (!link) return { kind: 'create' };
    return { kind: 'noop', reason: `GitHub issue #${link.number} could not be read` };
  }

  const remoteSide = remoteFields(remote);
  if (syncFieldsEqual(local, remoteSide)) {
    if (local.metadata && !remoteSide.metadata) return { kind: 'push', fields: local };
    return { kind: 'noop', reason: 'Already in sync' };
  }

  const localChanged = hasLocalChanged(issue, link);
  const remoteChanged = hasRemoteChanged(remote, link);

  if (localChanged && remoteChanged) {
    return latestChange();
  }
  if (localChanged) return { kind: 'push', fields: local };
  if (remoteChanged) return { kind: 'pull', fields: remoteSide };

  return latestChange();

  function latestChange(): SyncAction {
    return (issue.github?.localChangedAt ?? issue.updatedAt) > (remote?.updatedAt ?? 0)
      ? { kind: 'push', fields: local }
      : { kind: 'pull', fields: remoteSide };
  }
}

function hasLocalChanged(issue: IssueCard, link: IssueGithubLink): boolean {
  const baseline = link.localUpdatedAt ?? link.syncedAt;
  return (link.localChangedAt ?? issue.updatedAt) > baseline;
}

/** True when this card changed locally since the last GitHub watermark. */
export function issueNeedsGithubPush(issue: IssueCard): boolean {
  const link = issue.github;
  if (!link) return false;
  return hasLocalChanged(issue, link);
}

/** Parse `#12` / `12` from a git-link ref. */
export function githubIssueNumberFromRef(ref: string): number | null {
  const match = /^#?(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * True when a Git chip is the same GitHub issue as `issue.github`.
 * Peek renders that identity once on the sync row, not again as a chip.
 */
export function gitLinkDuplicatesGithubIssue(
  link: Pick<IssueGitLink, 'kind' | 'ref'>,
  issue: Pick<IssueCard, 'github'>,
): boolean {
  if (link.kind !== 'github-issue') return false;
  const number = issue.github?.number;
  if (!number) return false;
  return githubIssueNumberFromRef(link.ref) === number;
}

function hasRemoteChanged(remote: RemoteIssueSnapshot, link: IssueGithubLink): boolean {
  if (remote.updatedAt == null) return false;
  const baseline = link.remoteUpdatedAt ?? link.syncedAt;
  return remote.updatedAt > baseline;
}

/** Build the watermark to store after a successful sync. */
export function nextGithubLink(input: {
  previous?: IssueGithubLink;
  number: number;
  url: string;
  repo?: string;
  localUpdatedAt: number;
  remoteUpdatedAt?: number;
  now: number;
}): IssueGithubLink {
  const link: IssueGithubLink = {
    number: input.number,
    url: input.url,
    syncedAt: input.now,
    localUpdatedAt: input.localUpdatedAt,
    localChangedAt: input.previous?.localChangedAt ?? input.localUpdatedAt,
  };
  if (input.repo ?? input.previous?.repo) link.repo = input.repo ?? input.previous?.repo;
  if (input.remoteUpdatedAt != null) link.remoteUpdatedAt = input.remoteUpdatedAt;
  return link;
}

/** Coerce stored settings into a valid mode. Retired `link` becomes Off. */
export function normalizeGithubMode(raw: unknown): IssuesGithubMode {
  if (raw === 'link') return 'off';
  return typeof raw === 'string' && ISSUES_GITHUB_MODES.includes(raw as IssuesGithubMode)
    ? (raw as IssuesGithubMode)
    : 'off';
}
