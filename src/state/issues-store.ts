/**
 * Issues store — persisted in ~/.minnow/issues/state.json (MIN-261).
 * One-time migration from bugs/state.json + localStorage minnow-bugs-v1.
 */

import { mergeIssuesState } from '../issues/state-merge.ts';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path.ts';
import {
  normalizeProjectKeyInput,
  parseKeyedIssueId,
  suggestProjectKey,
  validateProjectKey,
} from '../issues/project-key.ts';
import { isServerStorageMode } from '../config/storage-mode.ts';
import { getBugs, getIssues, putIssues } from '../config/api-client.ts';
import {
  defaultIssuePriorityId,
  defaultIssueStatusId,
  defaultIssueTypeId,
  isClosedStatus,
  isKnownIssuePriority,
  isKnownIssueStatus,
  isKnownIssueType,
  openIssueStatusIds,
  requireStatusIdForRole,
  statusIdForRole,
  type IssueStatusRole,
} from '../issues/taxonomy.ts';
import {
  githubSyncedFieldsChanged,
  githubSyncedSnapshot,
} from '../issues/github-sync-plan.ts';
import { emitIssuesChange } from './issues-events.ts';
import { notifyGithubSyncedFieldWrite } from './issues-github-notify.ts';
import { getIssuesTaxonomySync } from './issues-taxonomy-store.ts';
import { normalizeIssuePlanPath } from '../issues/plan-attach.ts';
import { getWorkspaceLabel, getWorkspacePath } from './workspace.ts';
import { validateParentLink } from '../issues/hierarchy.ts';
import {
  ISSUE_LABEL_SWATCH_IDS,
  mergeIssueLabelCatalog,
  normalizeIssueLabel,
  normalizeIssueLabelsList,
  parseIssueLabelCatalog,
  uniqueIssueLabelNames,
} from '../issues/label-catalog.ts';
import {
  builtInIssueViews,
  migrateBuiltInIssueViews,
  LOCAL_ASSIGNEE_ID,
} from '../issues/saved-views.ts';
import { isUnreviewedTriageIssue } from '../issues/triage.ts';
import {
  ISSUE_ACTIVITY_CAP,
  ISSUES_COMPAT_VERSION,
  ISSUES_SCHEMA_VERSION,
  issuesSchemaRevisionOf,
} from '../types.ts';
import type {
  BugCard,
  BugColumn,
  BugSeverity,
  Chat,
  IssueAgentPhase,
  IssueAgentRun,
  IssueActivityEntry,
  IssueAssignee,
  IssueAttachment,
  IssueCard,
  IssueComment,
  IssueCodeRef,
  IssueGitLink,
  IssueGithubLink,
  IssueIssueRef,
  IssueLabelCatalogEntry,
  IssueLabelSwatchId,
  IssuePriority,
  IssueProject,
  IssueRelationKind,
  IssueSavedView,
  IssueSource,
  IssueStatus,
  IssueType,
  IssuesState,
  IssuesWorkspaceIdConfig,
} from '../types.ts';

// ── Status helpers ───────────────────────────────────────────────────────────

const ISSUES_STORAGE_KEY = 'minnow-issues-v1';
const BUGS_STORAGE_KEY = 'minnow-bugs-v1';

/** Statuses counted as "open" for sidebar badge (derived from taxonomy). */
export function getOpenIssueStatuses(): readonly IssueStatus[] {
  return openIssueStatusIds(getIssuesTaxonomySync());
}

/** @deprecated Use getOpenIssueStatuses() — kept for test imports. */
export const OPEN_ISSUE_STATUSES: readonly IssueStatus[] = [
  'triage',
  'backlog',
  'todo',
  'planned',
  'in_progress',
  'review',
] as const;

/** Legacy bug columns (bug_* aliases + migration). */
const BUG_COLUMNS: readonly BugColumn[] = [
  'reported',
  'investigating',
  'planned',
  'fixing',
  'complete',
] as const;

const BUG_SEVERITIES = new Set<BugSeverity>(['low', 'medium', 'high', 'critical']);

let issuesState: IssuesState | null = null;
let issuesLoaded = false;

/** Injectable clock for deterministic tests. */
let issuesNowMs = (): number => Date.now();

/** Override timestamp source in tests. */
export function setIssuesNowForTests(fn: (() => number) | null): void {
  issuesNowMs = fn ?? (() => Date.now());
}

export function isIssueType(value: string): value is IssueType {
  return isKnownIssueType(getIssuesTaxonomySync(), value);
}

export function isIssueStatus(value: string): value is IssueStatus {
  return isKnownIssueStatus(getIssuesTaxonomySync(), value);
}

export function isIssuePriority(value: string): value is IssuePriority {
  return isKnownIssuePriority(getIssuesTaxonomySync(), value);
}

/** Resolve a workflow role to the current status id. */
export function issueStatusForRole(role: IssueStatusRole): string | undefined {
  return statusIdForRole(getIssuesTaxonomySync(), role);
}

/** Require a workflow role status id (throws when unassigned). */
export function requireIssueStatusForRole(role: IssueStatusRole): string {
  return requireStatusIdForRole(getIssuesTaxonomySync(), role);
}

/** Type guard for legacy bug_* column values. */
export function isBugColumn(value: string): value is BugColumn {
  return (BUG_COLUMNS as readonly string[]).includes(value);
}

/** Type guard for legacy bug_* severity values. */
export function isBugSeverity(value: string): value is BugSeverity {
  return BUG_SEVERITIES.has(value as BugSeverity);
}

/** Workspace-relative default plan path for an issue id. */
export function defaultIssuePlanPath(issueId: string): string {
  return `documentation/plans/issues/${issueId}.md`;
}

// ── Workspace ids ────────────────────────────────────────────────────────────

function defaultIssuesState(): IssuesState {
  return {
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 1,
    issues: [],
    workspaces: {},
    labelCatalog: [],
  };
}

function workspaceBasenameFromPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Label shown in Settings (basename or synced workspace label). */
function labelForWorkspacePath(workspacePath: string): string {
  const key = normalizeWorkspacePath(workspacePath);
  if (key && key === normalizeWorkspacePath(getWorkspacePath())) {
    const label = getWorkspaceLabel().trim();
    if (label) return label;
  }
  return workspaceBasenameFromPath(workspacePath);
}

function ensureWorkspacesMap(state: IssuesState): Record<string, IssuesWorkspaceIdConfig> {
  if (!state.workspaces) state.workspaces = {};
  return state.workspaces;
}

function maxIssueNumberForKey(
  issues: IssueCard[],
  workspaceKey: string,
  projectKey: string,
): number {
  const prefix = projectKey.toUpperCase();
  let max = 0;
  for (const issue of issues) {
    if (normalizeWorkspacePath(issue.workspacePath) !== workspaceKey) continue;
    const parsed = parseKeyedIssueId(issue.id);
    if (parsed && parsed.prefix === prefix) {
      max = Math.max(max, parsed.number);
    }
  }
  return max;
}

function reconcileGlobalIssNextId(issues: IssueCard[], floor: number): number {
  let nextId = floor;
  for (const issue of issues) {
    const match = /^ISS-(\d+)$/i.exec(issue.id);
    if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
  }
  return nextId;
}

function parseWorkspaceIdConfig(raw: unknown): IssuesWorkspaceIdConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<IssuesWorkspaceIdConfig>;
  const projectKey = normalizeProjectKeyInput(
    typeof row.projectKey === 'string' ? row.projectKey : '',
  );
  if (validateProjectKey(projectKey)) return null;
  const nextId =
    typeof row.nextId === 'number' && Number.isFinite(row.nextId) && row.nextId >= 1
      ? Math.floor(row.nextId)
      : 1;
  return { projectKey, nextId };
}

function getOrInitWorkspaceIdConfig(workspacePath: string): IssuesWorkspaceIdConfig {
  const state = requireIssuesState();
  const wsKey = normalizeWorkspacePath(workspacePath);
  const map = ensureWorkspacesMap(state);
  const existing = map[wsKey];
  if (existing) return existing;

  const projectKey = suggestProjectKey(labelForWorkspacePath(workspacePath));
  const nextId = maxIssueNumberForKey(state.issues, wsKey, projectKey) + 1;
  const cfg: IssuesWorkspaceIdConfig = { projectKey, nextId };
  map[wsKey] = cfg;
  touchIssuesStore();
  return cfg;
}

function bumpCountersForExplicitIssueId(id: string, workspacePath: string): void {
  const state = requireIssuesState();
  const iss = /^ISS-(\d+)$/i.exec(id);
  if (iss) {
    state.nextId = Math.max(state.nextId, Number(iss[1]) + 1);
    return;
  }
  const parsed = parseKeyedIssueId(id);
  if (!parsed) return;

  const wsKey = normalizeWorkspacePath(workspacePath);
  const map = ensureWorkspacesMap(state);
  const saved = map[wsKey];
  const activeKey = (
    saved?.projectKey ?? suggestProjectKey(labelForWorkspacePath(workspacePath))
  ).toUpperCase();
  if (parsed.prefix !== activeKey) return;

  if (!saved) {
    map[wsKey] = { projectKey: activeKey, nextId: parsed.number + 1 };
    touchIssuesStore();
    return;
  }
  saved.nextId = Math.max(saved.nextId, parsed.number + 1);
}

function requireIssuesState(): IssuesState {
  if (!issuesState) {
    throw new Error('issuesState is not initialized; call loadIssuesFromStorage() first');
  }
  return issuesState;
}

// ── Bug mapping ──────────────────────────────────────────────────────────────

/** Map legacy bug column → issue status via taxonomy roles. */
export function bugColumnToIssueStatus(column: BugColumn): IssueStatus {
  const taxonomy = getIssuesTaxonomySync();
  switch (column) {
    case 'reported':
      return statusIdForRole(taxonomy, 'triage') ?? defaultIssueStatusId(taxonomy);
    case 'investigating':
      return statusIdForRole(taxonomy, 'in_progress') ?? defaultIssueStatusId(taxonomy);
    case 'planned':
      return statusIdForRole(taxonomy, 'planned') ?? defaultIssueStatusId(taxonomy);
    case 'fixing':
      return statusIdForRole(taxonomy, 'in_progress') ?? defaultIssueStatusId(taxonomy);
    case 'complete':
      return statusIdForRole(taxonomy, 'done') ?? defaultIssueStatusId(taxonomy);
    default:
      return defaultIssueStatusId(taxonomy);
  }
}

/** Map issue status → legacy bug column via taxonomy roles. */
export function issueStatusToBugColumn(status: IssueStatus): BugColumn {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.statuses.find((s) => s.id === status);
  const role = item?.role;
  switch (role) {
    case 'triage':
    case 'backlog':
    case 'todo':
      return 'reported';
    case 'planned':
      return 'planned';
    case 'in_progress':
    case 'review':
      return 'fixing';
    case 'done':
    case 'canceled':
      return 'complete';
    default:
      return 'reported';
  }
}

/** Map bug severity → issue priority. */
export function bugSeverityToIssuePriority(severity: BugSeverity): IssuePriority {
  switch (severity) {
    case 'critical':
      return 'urgent';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

/** Map issue priority → nearest bug severity (for bug_* alias tools). */
export function issuePriorityToBugSeverity(priority: IssuePriority): BugSeverity {
  switch (priority) {
    case 'urgent':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'none':
      return 'low';
    default:
      return 'medium';
  }
}

// ── Parse state ──────────────────────────────────────────────────────────────

/**
 * Card keys this revision normalizes. Anything else on a card is copied through
 * untouched so a newer client's fields survive a round-trip by an older one.
 */
const NORMALIZED_ISSUE_CARD_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'title',
  'description',
  'status',
  'priority',
  'labels',
  'workspacePath',
  'createdAt',
  'updatedAt',
  'codeRefs',
  'gitLinks',
  'issueRefs',
  'chatIds',
  'planPath',
  'boardChatId',
  'investigateRunId',
  'planRunId',
  'notes',
  'legacyBugId',
  'severity',
  'assignee',
  'agent',
  'parentId',
  'rank',
  'projectId',
  'source',
  'triagedAt',
  'attachments',
  'comments',
  'activity',
  'githubSync',
]);

/** Top-level state keys this revision normalizes (see above). */
const NORMALIZED_ISSUES_STATE_KEYS: ReadonlySet<string> = new Set([
  'version',
  'schemaRevision',
  'nextId',
  'issues',
  'workspaces',
  'projects',
  'views',
  'labelCatalog',
]);

/**
 * Copy keys the current revision does not model onto the normalized output.
 *
 * This is the forward-compatibility half of the wipe guard: version tolerance
 * stops an unknown revision from being discarded wholesale, and this stops a
 * read-modify-write from quietly stripping its fields one card at a time.
 */
function preserveUnknownKeys<T extends object>(
  source: Record<string, unknown>,
  target: T,
  normalized: ReadonlySet<string>,
): T {
  for (const key of Object.keys(source)) {
    if (normalized.has(key)) continue;
    if (source[key] === undefined) continue;
    (target as Record<string, unknown>)[key] = source[key];
  }
  return target;
}

const ISSUE_AGENT_PHASES = new Set<IssueAgentPhase>([
  'queued',
  'running',
  'awaiting_input',
  'review',
  'failed',
  'canceled',
  'done',
]);

const ISSUE_SOURCES = new Set<IssueSource>(['user', 'agent', 'crash', 'github']);

const NORMALIZED_ASSIGNEE_KEYS = new Set(['id', 'label', 'assignedAt']);
const NORMALIZED_AGENT_KEYS = new Set([
  'agentId',
  'phase',
  'step',
  'startedAt',
  'updatedAt',
  'boardGroupId',
  'boardTaskId',
  'chatId',
  'worktreePath',
  'branch',
  'prNumber',
  'prUrl',
  'pendingQuestionId',
  'error',
  'envBlocked',
]);
const NORMALIZED_PROJECT_KEYS = new Set([
  'id',
  'name',
  'description',
  'color',
  'archivedAt',
  'createdAt',
  'updatedAt',
]);
const NORMALIZED_VIEW_KEYS = new Set(['id', 'name', 'filters', 'groupBy', 'order', 'builtIn']);

function parseIssueAssignee(raw: unknown): IssueAssignee | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return undefined;
  const assignedAt =
    typeof row.assignedAt === 'number' && Number.isFinite(row.assignedAt) ? row.assignedAt : 0;
  const out: IssueAssignee = { id, assignedAt };
  if (typeof row.label === 'string' && row.label.trim()) out.label = row.label.trim();
  return preserveUnknownKeys(row, out, NORMALIZED_ASSIGNEE_KEYS);
}

function parseIssueAgent(raw: unknown): IssueAgentRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const agentId = typeof row.agentId === 'string' ? row.agentId.trim() : '';
  const phase = typeof row.phase === 'string' ? row.phase.trim() : '';
  if (!agentId || !ISSUE_AGENT_PHASES.has(phase as IssueAgentPhase)) return undefined;
  const startedAt =
    typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : 0;
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : startedAt;
  const out: IssueAgentRun = {
    agentId,
    phase: phase as IssueAgentPhase,
    startedAt,
    updatedAt,
  };
  if (typeof row.step === 'string' && row.step.trim()) out.step = row.step.trim();
  if (typeof row.boardGroupId === 'string' && row.boardGroupId.trim()) {
    out.boardGroupId = row.boardGroupId.trim();
  }
  if (typeof row.boardTaskId === 'string' && row.boardTaskId.trim()) {
    out.boardTaskId = row.boardTaskId.trim();
  }
  if (typeof row.chatId === 'string' && row.chatId.trim()) out.chatId = row.chatId.trim();
  if (typeof row.worktreePath === 'string' && row.worktreePath.trim()) {
    out.worktreePath = row.worktreePath.trim();
  }
  if (typeof row.branch === 'string' && row.branch.trim()) out.branch = row.branch.trim();
  if (typeof row.prNumber === 'number' && Number.isFinite(row.prNumber)) {
    out.prNumber = Math.floor(row.prNumber);
  }
  if (typeof row.prUrl === 'string' && row.prUrl.trim()) out.prUrl = row.prUrl.trim();
  if (typeof row.pendingQuestionId === 'string' && row.pendingQuestionId.trim()) {
    out.pendingQuestionId = row.pendingQuestionId.trim();
  }
  if (typeof row.error === 'string' && row.error.trim()) out.error = row.error.trim();
  if (typeof row.envBlocked === 'boolean') out.envBlocked = row.envBlocked;
  return preserveUnknownKeys(row, out, NORMALIZED_AGENT_KEYS);
}

function applyIssueCardV3Fields(card: IssueCard, raw: Record<string, unknown>): void {
  const assignee = parseIssueAssignee(raw.assignee);
  if (assignee) card.assignee = assignee;
  const agent = parseIssueAgent(raw.agent);
  if (agent) card.agent = agent;
  if (typeof raw.parentId === 'string' && raw.parentId.trim()) {
    card.parentId = raw.parentId.trim();
  }
  if (typeof raw.rank === 'string' && raw.rank.trim()) card.rank = raw.rank.trim();
  if (typeof raw.projectId === 'string' && raw.projectId.trim()) {
    card.projectId = raw.projectId.trim();
  }
  if (typeof raw.source === 'string' && ISSUE_SOURCES.has(raw.source as IssueSource)) {
    card.source = raw.source as IssueSource;
  }
  if (typeof raw.triagedAt === 'number' && Number.isFinite(raw.triagedAt)) {
    card.triagedAt = raw.triagedAt;
  }
  const attachments = parseIssueAttachments(raw.attachments);
  if (attachments) card.attachments = attachments;
  const comments = parseIssueComments(raw.comments);
  if (comments) card.comments = comments;
  const activity = parseIssueActivity(raw.activity);
  if (activity) card.activity = activity;
  if (typeof raw.githubSync === 'boolean') card.githubSync = raw.githubSync;
  const github = parseIssueGithubLink(raw.github);
  if (github) card.github = github;
}

const NORMALIZED_GITHUB_KEYS: ReadonlySet<string> = new Set([
  'number',
  'url',
  'repo',
  'syncedAt',
  'remoteUpdatedAt',
  'localUpdatedAt',
  'localChangedAt',
]);

/**
 * Parse the remote link and its sync watermark.
 *
 * A link with no usable number is dropped rather than half-kept: a link that
 * cannot be resolved would make the planner treat the issue as "linked but
 * unreadable" forever, which blocks it from ever being created remotely.
 */
function parseIssueGithubLink(raw: unknown): IssueGithubLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const number = Number(row.number);
  if (!Number.isFinite(number) || number <= 0) return null;
  const out: IssueGithubLink = {
    number: Math.floor(number),
    url: typeof row.url === 'string' ? row.url : '',
    syncedAt:
      typeof row.syncedAt === 'number' && Number.isFinite(row.syncedAt) ? row.syncedAt : 0,
  };
  if (typeof row.repo === 'string' && row.repo.trim()) out.repo = row.repo.trim();
  if (typeof row.remoteUpdatedAt === 'number' && Number.isFinite(row.remoteUpdatedAt)) {
    out.remoteUpdatedAt = row.remoteUpdatedAt;
  }
  if (typeof row.localUpdatedAt === 'number' && Number.isFinite(row.localUpdatedAt)) {
    out.localUpdatedAt = row.localUpdatedAt;
  }
  if (typeof row.localChangedAt === 'number' && Number.isFinite(row.localChangedAt)) {
    out.localChangedAt = row.localChangedAt;
  }
  return preserveUnknownKeys(row, out, NORMALIZED_GITHUB_KEYS);
}

const NORMALIZED_COMMENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'authorKind',
  'author',
  'body',
  'createdAt',
  'editedAt',
]);

const AUTHOR_KINDS = new Set(['user', 'agent', 'system']);

function parseIssueComment(raw: unknown): IssueComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const body = typeof row.body === 'string' ? row.body : '';
  if (!id || !body.trim()) return null;
  const authorKind =
    typeof row.authorKind === 'string' && AUTHOR_KINDS.has(row.authorKind)
      ? (row.authorKind as IssueComment['authorKind'])
      : 'user';
  const out: IssueComment = {
    id,
    authorKind,
    body,
    createdAt:
      typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
        ? row.createdAt
        : issuesNowMs(),
  };
  if (typeof row.author === 'string' && row.author.trim()) out.author = row.author.trim();
  if (typeof row.editedAt === 'number' && Number.isFinite(row.editedAt)) {
    out.editedAt = row.editedAt;
  }
  return preserveUnknownKeys(row, out, NORMALIZED_COMMENT_KEYS);
}

function parseIssueComments(raw: unknown): IssueComment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueComment[] = [];
  for (const item of raw) {
    const comment = parseIssueComment(item);
    if (comment) out.push(comment);
  }
  return out;
}

const NORMALIZED_ACTIVITY_KEYS: ReadonlySet<string> = new Set([
  'id',
  'kind',
  'at',
  'actorKind',
  'actor',
  'data',
]);

function parseIssueActivityEntry(raw: unknown): IssueActivityEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
  if (!id || !kind) return null;
  const out: IssueActivityEntry = {
    id,
    kind,
    at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : issuesNowMs(),
  };
  if (typeof row.actorKind === 'string' && AUTHOR_KINDS.has(row.actorKind)) {
    out.actorKind = row.actorKind as IssueActivityEntry['actorKind'];
  }
  if (typeof row.actor === 'string' && row.actor.trim()) out.actor = row.actor.trim();
  if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
    out.data = row.data as IssueActivityEntry['data'];
  }
  return preserveUnknownKeys(row, out, NORMALIZED_ACTIVITY_KEYS);
}

function parseIssueActivity(raw: unknown): IssueActivityEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueActivityEntry[] = [];
  for (const item of raw) {
    const entry = parseIssueActivityEntry(item);
    if (entry) out.push(entry);
  }
  return out.slice(-ISSUE_ACTIVITY_CAP);
}

/** Keys of {@link IssueAttachment} this revision models. */
const NORMALIZED_ATTACHMENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'path',
  'mime',
  'bytes',
  'addedAt',
]);

function parseIssueAttachment(raw: unknown): IssueAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const storedPath = typeof row.path === 'string' ? row.path.trim() : '';
  if (!id || !name || !storedPath) return null;
  const out: IssueAttachment = {
    id,
    name,
    path: storedPath,
    addedAt:
      typeof row.addedAt === 'number' && Number.isFinite(row.addedAt)
        ? row.addedAt
        : issuesNowMs(),
  };
  if (typeof row.mime === 'string' && row.mime.trim()) out.mime = row.mime.trim();
  if (typeof row.bytes === 'number' && Number.isFinite(row.bytes) && row.bytes >= 0) {
    out.bytes = Math.floor(row.bytes);
  }
  return preserveUnknownKeys(row, out, NORMALIZED_ATTACHMENT_KEYS);
}

function parseIssueAttachments(raw: unknown): IssueAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueAttachment[] = [];
  for (const item of raw) {
    const attachment = parseIssueAttachment(item);
    if (attachment) out.push(attachment);
  }
  return out;
}

function parseIssueProject(raw: unknown): IssueProject | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!id || !name) return null;
  const createdAt =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
      ? row.createdAt
      : issuesNowMs();
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt;
  const out: IssueProject = { id, name, createdAt, updatedAt };
  if (typeof row.description === 'string' && row.description.trim()) {
    out.description = row.description.trim();
  }
  if (typeof row.color === 'string' && row.color.trim()) out.color = row.color.trim();
  if (typeof row.archivedAt === 'number' && Number.isFinite(row.archivedAt)) {
    out.archivedAt = row.archivedAt;
  }
  return preserveUnknownKeys(row, out, NORMALIZED_PROJECT_KEYS);
}

function parseIssueSavedView(raw: unknown): IssueSavedView | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!id || !name) return null;
  const filters =
    row.filters && typeof row.filters === 'object' && !Array.isArray(row.filters)
      ? (row.filters as IssueSavedView['filters'])
      : {};
  const order =
    typeof row.order === 'number' && Number.isFinite(row.order) ? Math.floor(row.order) : 0;
  const out: IssueSavedView = { id, name, filters, order };
  if (typeof row.groupBy === 'string' && row.groupBy.trim()) out.groupBy = row.groupBy.trim();
  if (typeof row.builtIn === 'boolean') out.builtIn = row.builtIn;
  return preserveUnknownKeys(row, out, NORMALIZED_VIEW_KEYS);
}

function parseIssueProjects(raw: unknown): IssueProject[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueProject[] = [];
  for (const item of raw) {
    const project = parseIssueProject(item);
    if (project) out.push(project);
  }
  return out;
}

function parseIssueViews(raw: unknown): IssueSavedView[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: IssueSavedView[] = [];
  for (const item of raw) {
    const view = parseIssueSavedView(item);
    if (view) out.push(view);
  }
  return out;
}

function ensureIssueCardShape(raw: unknown): IssueCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<IssueCard>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!id || !title) return null;
  const typeRaw = typeof r.type === 'string' ? r.type.trim() : '';
  const statusRaw = typeof r.status === 'string' ? r.status.trim() : '';
  const priorityRaw = typeof r.priority === 'string' ? r.priority.trim() : '';
  if (!typeRaw || !statusRaw || !priorityRaw) return null;
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : issuesNowMs();
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : createdAt;
  const workspacePath = normalizeWorkspacePath(
    typeof r.workspacePath === 'string' ? r.workspacePath : '',
  );
  const labels = Array.isArray(r.labels)
    ? r.labels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim())
    : [];

  const card: IssueCard = {
    id,
    type: typeRaw,
    title,
    description: typeof r.description === 'string' ? r.description : '',
    status: statusRaw,
    priority: priorityRaw,
    labels,
    workspacePath,
    createdAt,
    updatedAt,
  };

  if (Array.isArray(r.codeRefs)) card.codeRefs = r.codeRefs as IssueCard['codeRefs'];
  if (Array.isArray(r.gitLinks)) card.gitLinks = r.gitLinks as IssueCard['gitLinks'];
  if (Array.isArray(r.issueRefs)) {
    card.issueRefs = r.issueRefs
      .map((item) => normalizeIssueIssueRef(item as IssueIssueRef | string))
      .filter((ref): ref is IssueIssueRef => ref != null);
  }
  if (Array.isArray(r.chatIds)) {
    card.chatIds = r.chatIds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
  }
  if (typeof r.planPath === 'string' && r.planPath.trim()) card.planPath = r.planPath.trim();
  if (typeof r.boardChatId === 'string' && r.boardChatId.trim()) {
    card.boardChatId = r.boardChatId.trim();
  }
  if (typeof r.investigateRunId === 'string' && r.investigateRunId.trim()) {
    card.investigateRunId = r.investigateRunId.trim();
  }
  if (typeof r.planRunId === 'string' && r.planRunId.trim()) {
    card.planRunId = r.planRunId.trim();
  }
  if (typeof r.notes === 'string') card.notes = r.notes;
  if (typeof r.legacyBugId === 'string' && r.legacyBugId.trim()) {
    card.legacyBugId = r.legacyBugId.trim();
  }
  if (
    typeof r.severity === 'string' &&
    (r.severity === 'low' ||
      r.severity === 'medium' ||
      r.severity === 'high' ||
      r.severity === 'critical')
  ) {
    card.severity = r.severity;
  }
  applyIssueCardV3Fields(card, raw as Record<string, unknown>);
  return preserveUnknownKeys(
    raw as Record<string, unknown>,
    card,
    NORMALIZED_ISSUE_CARD_KEYS,
  );
}

/**
 * Parse a stored state blob.
 *
 * Falling back to an empty state is reserved for a blob with no issues array at
 * all — a genuinely unreadable file. An unrecognized `version` is *not* that:
 * treating "newer than me" as corrupt is how a rolled-back client erases every
 * issue written by a newer one, which is what MIN-354 v1 did. A revision we do
 * not recognize is read on its own terms and written back at its own number.
 */
export function parseIssuesState(raw: unknown): IssuesState {
  if (!raw || typeof raw !== 'object') return defaultIssuesState();
  const row = raw as {
    version?: number;
    nextId?: number;
    issues?: unknown;
    workspaces?: unknown;
    projects?: unknown;
    views?: unknown;
    labelCatalog?: unknown;
  };
  if (!Array.isArray(row.issues)) {
    return defaultIssuesState();
  }
  const readRevision = issuesSchemaRevisionOf(row);
  const issues: IssueCard[] = [];
  for (const item of row.issues) {
    const card = ensureIssueCardShape(item);
    if (card) issues.push(card);
  }
  const floor =
    typeof row.nextId === 'number' && Number.isFinite(row.nextId) && row.nextId >= 1
      ? Math.floor(row.nextId)
      : 1;
  const nextId = reconcileGlobalIssNextId(issues, floor);

  const workspaces: Record<string, IssuesWorkspaceIdConfig> = {};
  if (row.workspaces && typeof row.workspaces === 'object') {
    for (const [pathKey, cfgRaw] of Object.entries(row.workspaces)) {
      const cfg = parseWorkspaceIdConfig(cfgRaw);
      if (!cfg) continue;
      const wsKey = normalizeWorkspacePath(pathKey);
      const reconciledNext = Math.max(
        cfg.nextId,
        maxIssueNumberForKey(issues, wsKey, cfg.projectKey) + 1,
      );
      workspaces[wsKey] = { projectKey: cfg.projectKey, nextId: reconciledNext };
    }
  }

  const projects = parseIssueProjects(row.projects);
  const views = parseIssueViews(row.views);
  const mergedCatalog = mergeIssueLabelCatalog(
    parseIssueLabelCatalog(row.labelCatalog),
    uniqueIssueLabelNames(issues.map((issue) => issue.labels)),
  );

  const state: IssuesState = {
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: Math.max(readRevision, ISSUES_SCHEMA_VERSION),
    nextId,
    issues,
    workspaces,
    labelCatalog: mergedCatalog.catalog,
  };
  if (projects) state.projects = projects;
  if (views) state.views = views;
  return preserveUnknownKeys(
    raw as Record<string, unknown>,
    state,
    NORMALIZED_ISSUES_STATE_KEYS,
  );
}

/** Convert one BugCard into an IssueCard with sequential ISS-n id. */
export function migrateBugCardToIssue(bug: BugCard, issueId: string): IssueCard {
  const chatIds = bug.chatId?.trim() ? [bug.chatId.trim()] : undefined;
  const card: IssueCard = {
    id: issueId,
    type: 'bug',
    title: bug.title,
    description: bug.description ?? '',
    status: bugColumnToIssueStatus(bug.column),
    priority: bugSeverityToIssuePriority(bug.severity),
    labels: [],
    workspacePath: normalizeWorkspacePath(bug.workspacePath ?? ''),
    createdAt: bug.createdAt,
    updatedAt: bug.updatedAt,
    legacyBugId: bug.id,
    severity: bug.severity,
  };
  if (chatIds) card.chatIds = chatIds;
  if (typeof bug.notes === 'string') card.notes = bug.notes;
  if (typeof bug.planPath === 'string' && bug.planPath.trim()) card.planPath = bug.planPath.trim();
  if (typeof bug.investigateRunId === 'string' && bug.investigateRunId.trim()) {
    card.investigateRunId = bug.investigateRunId.trim();
  }
  if (typeof bug.planRunId === 'string' && bug.planRunId.trim()) {
    card.planRunId = bug.planRunId.trim();
  }
  if (typeof bug.fixRunId === 'string' && bug.fixRunId.trim()) {
    card.boardChatId = bug.fixRunId.trim();
  }
  return card;
}

function parseBugsArray(raw: unknown): BugCard[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as { bugs?: unknown };
  if (!Array.isArray(row.bugs)) return [];
  const out: BugCard[] = [];
  for (const item of row.bugs) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Partial<BugCard>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!id || !title) continue;
    const severity = b.severity;
    const column = b.column;
    if (
      severity !== 'low' &&
      severity !== 'medium' &&
      severity !== 'high' &&
      severity !== 'critical'
    ) {
      continue;
    }
    if (
      column !== 'reported' &&
      column !== 'investigating' &&
      column !== 'planned' &&
      column !== 'fixing' &&
      column !== 'complete'
    ) {
      continue;
    }
    out.push({
      id,
      title,
      description: typeof b.description === 'string' ? b.description : '',
      severity,
      column,
      workspacePath: normalizeWorkspacePath(
        typeof b.workspacePath === 'string' ? b.workspacePath : '',
      ),
      createdAt: typeof b.createdAt === 'number' ? b.createdAt : issuesNowMs(),
      updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : issuesNowMs(),
      ...(typeof b.chatId === 'string' ? { chatId: b.chatId } : {}),
      ...(typeof b.notes === 'string' ? { notes: b.notes } : {}),
      ...(typeof b.planPath === 'string' ? { planPath: b.planPath } : {}),
      ...(typeof b.investigateRunId === 'string'
        ? { investigateRunId: b.investigateRunId }
        : {}),
      ...(typeof b.planRunId === 'string' ? { planRunId: b.planRunId } : {}),
      ...(typeof b.fixRunId === 'string' ? { fixRunId: b.fixRunId } : {}),
    });
  }
  return out;
}

/** Build IssuesState from bug cards (does not persist). */
export function migrateBugsToIssuesState(bugs: BugCard[]): IssuesState {
  const issues: IssueCard[] = [];
  let nextId = 1;
  for (const bug of bugs) {
    const id = `ISS-${nextId}`;
    nextId += 1;
    issues.push(migrateBugCardToIssue(bug, id));
  }
  return {
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId,
    issues,
    workspaces: {},
    labelCatalog: [],
  };
}

async function loadBugsForMigration(): Promise<BugCard[]> {
  if (isServerStorageMode()) {
    try {
      const bugsState = await getBugs();
      return parseBugsArray(bugsState);
    } catch {}
  }
  try {
    const raw = localStorage.getItem(BUGS_STORAGE_KEY);
    if (!raw) return [];
    return parseBugsArray(JSON.parse(raw));
  } catch {
    return [];
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

function touchIssuesStore(): void {
  scheduleSaveIssues();
  emitIssuesChange();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced persist (~400ms). */
export function scheduleSaveIssues(): void {
  if (!issuesState) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveIssuesNow().catch(() => {});
  }, 400);
}

let persistedIssuesBase: IssuesState | null = null;
let storageWork: Promise<unknown> = Promise.resolve();
const ISSUES_CHANGED_KEY = 'minnow.issues.changed';

function cloneState(state: IssuesState): IssuesState {
  return JSON.parse(JSON.stringify(state)) as IssuesState;
}

/** Persistence should not repaint subscribers when the visible state is unchanged. */
function issuesStatesEqual(a: IssuesState, b: IssuesState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Serialize read/merge/write across renderer windows as well as within this one. */
function withIssuesStorageLock<T>(work: () => Promise<T>): Promise<T> {
  const run = () => typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('minnow-issues-storage', work) : work();
  const next = storageWork.then(run, run);
  storageWork = next.catch(() => {});
  return next;
}

async function readPersistedIssues(): Promise<IssuesState | null> {
  const raw = isServerStorageMode() ? await getIssues() : JSON.parse(localStorage.getItem(ISSUES_STORAGE_KEY) ?? 'null');
  return raw === null ? null : parseIssuesState(raw);
}

/** Refresh another window's writes without discarding unsaved edits or deletions. */
export async function refreshIssuesFromStorage(): Promise<void> {
  await withIssuesStorageLock(async () => {
    if (!issuesState) return;
    const remote = await readPersistedIssues();
    if (!remote) return;
    const current = issuesState;
    const next = persistedIssuesBase ? mergeIssuesState(persistedIssuesBase, current, remote) : current;
    const changed = !issuesStatesEqual(current, next);
    issuesState = next;
    persistedIssuesBase = cloneState(remote);
    if (changed) emitIssuesChange();
  });
}

/** Immediate persist, retaining edits made by other windows or during the request. */
export async function saveIssuesNow(): Promise<void> {
  if (!issuesState) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return withIssuesStorageLock(async () => {
    if (!issuesState) return;
    try {
      const remote = await readPersistedIssues();
      const before = cloneState(issuesState);
      const merged = remote && persistedIssuesBase ? mergeIssuesState(persistedIssuesBase, before, remote) : before;
      if (isServerStorageMode()) await putIssues(merged);
      else localStorage.setItem(ISSUES_STORAGE_KEY, JSON.stringify(merged));
      // The UI may have changed while PUT was pending. Keep that delta pending.
      const current = issuesState;
      const next = mergeIssuesState(before, current, merged);
      const changed = !issuesStatesEqual(current, next);
      issuesState = next;
      persistedIssuesBase = cloneState(merged);
      try { localStorage.setItem(ISSUES_CHANGED_KEY, `${Date.now()}:${Math.random()}`); } catch {}
      if (changed) emitIssuesChange();
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('Issue ID ')
        ? error.message : 'Could not save issues to ~/.minnow';
      void import('../ui/status.ts').then((m) => m.setStatus('err', message));
      throw error;
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === ISSUES_CHANGED_KEY || event.key === ISSUES_STORAGE_KEY) {
      void refreshIssuesFromStorage().catch(() => {});
    }
  });
}

/**
 * Import leftover `chat.bugBoard` cards into Issues (by legacyBugId), then strip boards.
 * Safe to call after loadIssuesFromStorage — does not rewrite bugs/state.json.
 * @returns true when chats or issues were mutated (caller should persist sessions).
 */
export async function migrateLegacyBugBoardsFromChats(chats: Chat[]): Promise<boolean> {
  if (!issuesLoaded || !issuesState) return false;
  const state = issuesState;
  let changed = false;
  for (const chat of chats) {
    const legacy = chat.bugBoard?.bugs;
    if (!legacy?.length) {
      if (chat.bugBoard) {
        delete chat.bugBoard;
        changed = true;
      }
      continue;
    }
    for (const bug of legacy) {
      const shaped = parseBugsArray({ bugs: [bug] })[0];
      if (!shaped) continue;
      if (!shaped.workspacePath && chat.workspacePath) {
        shaped.workspacePath = normalizeWorkspacePath(chat.workspacePath);
      }
      if (!shaped.chatId) shaped.chatId = chat.id;
      if (findIssueById(shaped.id)) continue;
      const id = allocateIssueId(
        shaped.workspacePath?.trim() ? shaped.workspacePath : getWorkspacePath(),
      );
      state.issues.push(migrateBugCardToIssue(shaped, id));
      changed = true;
    }
    delete chat.bugBoard;
    changed = true;
  }
  if (!changed) return false;
  await saveIssuesNow();
  emitIssuesChange();
  return true;
}

/**
 * Load issues from API or localStorage.
 * If the issues file/key is absent, migrate from bugs (leaving bugs untouched).
 */
export async function loadIssuesFromStorage(): Promise<void> {
  if (isServerStorageMode()) {
    try {
      const raw = await getIssues();
      if (raw !== null) {
        issuesState = parseIssuesState(raw);
        persistedIssuesBase = cloneState(issuesState);
        issuesLoaded = true;
        return;
      }
      const bugs = await loadBugsForMigration();
      issuesState = migrateBugsToIssuesState(bugs);
      issuesLoaded = true;
      await saveIssuesNow();
      emitIssuesChange();
      return;
    } catch {
      issuesState = defaultIssuesState();
      issuesLoaded = true;
      void import('../ui/status.ts').then((m) =>
        m.setStatus('err', 'Could not load issues from ~/.minnow'),
      );
      return;
    }
  }

  try {
    const raw = localStorage.getItem(ISSUES_STORAGE_KEY);
    if (raw) {
      issuesState = parseIssuesState(JSON.parse(raw));
      persistedIssuesBase = cloneState(issuesState);
      issuesLoaded = true;
      return;
    }
    const bugs = await loadBugsForMigration();
    issuesState = migrateBugsToIssuesState(bugs);
    issuesLoaded = true;
    await saveIssuesNow();
    emitIssuesChange();
  } catch {
    issuesState = defaultIssuesState();
    issuesLoaded = true;
  }
}

// ── Issue CRUD ───────────────────────────────────────────────────────────────

/** Allocate next KEY-n id for a workspace and bump its counter. */
function allocateIssueId(workspacePath: string): string {
  const wsKey = normalizeWorkspacePath(workspacePath.trim() || getWorkspacePath());
  const cfg = getOrInitWorkspaceIdConfig(wsKey);
  const id = `${cfg.projectKey}-${cfg.nextId}`;
  cfg.nextId += 1;
  return id;
}

/** All issues (read-only copy). */
export function listIssues(): IssueCard[] {
  return [...requireIssuesState().issues];
}

/** Find one issue by id (ISS-n) or legacy bug id. */
export function findIssueById(issueId: string): IssueCard | undefined {
  const key = issueId.trim();
  return requireIssuesState().issues.find(
    (i) => i.id === key || i.legacyBugId === key,
  );
}

export type AddIssueInput = {
  title: string;
  description?: string;
  type?: IssueType;
  priority?: IssuePriority;
  status?: IssueStatus;
  labels?: string[];
  workspacePath?: string;
  /** Preserved when migrating / bug_* alias. */
  severity?: BugSeverity;
  legacyBugId?: string;
  source?: IssueSource;
  parentId?: string;
  projectId?: string;
};

/** Add an issue card (defaults: task / backlog-role status / none / source user). */
export function addIssue(input: AddIssueInput, issueId?: string): IssueCard {
  const nowMs = issuesNowMs();
  const workspacePath = normalizeWorkspacePath(
    input.workspacePath?.trim() || getWorkspacePath(),
  );
  const id = issueId?.trim() || allocateIssueId(workspacePath);
  bumpCountersForExplicitIssueId(id, workspacePath);
  const taxonomy = getIssuesTaxonomySync();
  if (input.parentId) {
    const parentCheck = validateParentLink(id, input.parentId, requireIssuesState().issues);
    if (!parentCheck.ok) throw new Error(parentCheck.error);
  }
  const card: IssueCard = {
    id,
    type: input.type ?? defaultIssueTypeId(taxonomy),
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    status: input.status ?? requireIssueStatusForRole('backlog'),
    priority: input.priority ?? defaultIssuePriorityId(taxonomy),
    labels: commitIssueLabels(input.labels ?? [], { persist: false }),
    workspacePath,
    createdAt: nowMs,
    updatedAt: nowMs,
    source: input.source ?? 'user',
  };
  if (input.severity) card.severity = input.severity;
  if (input.legacyBugId) card.legacyBugId = input.legacyBugId;
  if (input.parentId) card.parentId = input.parentId;
  if (input.projectId) card.projectId = input.projectId;
  requireIssuesState().issues.push(card);
  touchIssuesStore();
  return card;
}

/** Quick-capture helper: note in backlog-role status, filed by the user. */
export function quickCaptureIssue(title: string, workspacePath?: string): IssueCard {
  const taxonomy = getIssuesTaxonomySync();
  return addIssue({
    title,
    description: '',
    type: findNoteTypeId(taxonomy),
    status: requireIssueStatusForRole('backlog'),
    priority: defaultIssuePriorityId(taxonomy),
    source: 'user',
    workspacePath,
  });
}

function findNoteTypeId(taxonomy: ReturnType<typeof getIssuesTaxonomySync>): IssueType {
  if (isKnownIssueType(taxonomy, 'note')) return 'note';
  return defaultIssueTypeId(taxonomy);
}

export type UpdateIssuePatch = {
  title?: string;
  description?: string;
  type?: IssueType;
  status?: IssueStatus;
  priority?: IssuePriority;
  labels?: string[];
  notes?: string;
  planPath?: string;
  boardChatId?: string;
  investigateRunId?: string;
  planRunId?: string;
  chatIds?: string[];
  codeRefs?: IssueCodeRef[];
  gitLinks?: IssueGitLink[];
  issueRefs?: IssueIssueRef[];
  /** Pass null to unassign. */
  assignee?: IssueAssignee | null;
  /** Pass null to clear the agent slot. */
  agent?: IssueAgentRun | null;
  /** Pass null to unparent. */
  parentId?: string | null;
  /** Pass null to drop a manual rank (session sort then applies). */
  rank?: string | null;
  /** Pass null to remove from a project. */
  projectId?: string | null;
  source?: IssueSource;
  /** Pass null to return the card to the unreviewed Triage lane. */
  triagedAt?: number | null;
  /** Leftover per-issue flag from retired Link + push. Ignored by sync. */
  githubSync?: boolean;
};

/** Options for a store write that is not a user/agent edit. */
export type UpdateIssueOptions = {
  /** GitHub pull/conflict apply: do not treat this write as a local auto-sync trigger. */
  skipGithubAutoSync?: boolean;
};

// ── Links ────────────────────────────────────────────────────────────────────

const ISSUE_RELATION_KINDS: readonly IssueRelationKind[] = [
  'related',
  'blocks',
  'blocked-by',
  'duplicate-of',
  'parent',
  'sub-issue',
];

/** True when a string is a supported issue-to-issue relation kind. */
export function isIssueRelationKind(value: string): value is IssueRelationKind {
  return (ISSUE_RELATION_KINDS as readonly string[]).includes(value);
}

/** Inverse relation kind written on the target issue when linking bidirectionally. */
export function inverseIssueRelationKind(kind: IssueRelationKind): IssueRelationKind {
  switch (kind) {
    case 'blocks':
      return 'blocked-by';
    case 'blocked-by':
      return 'blocks';
    case 'parent':
      return 'sub-issue';
    case 'sub-issue':
      return 'parent';
    default:
      return kind;
  }
}

/** True when two issue refs point at the same target with the same kind. */
export function issueIssueRefsEqual(a: IssueIssueRef, b: IssueIssueRef): boolean {
  return a.issueId === b.issueId && a.kind === b.kind;
}

/** Normalize an issue-to-issue ref for storage (string ids default to related). */
export function normalizeIssueIssueRef(
  ref: IssueIssueRef | string | Partial<IssueIssueRef>,
  addedAt?: number,
): IssueIssueRef | null {
  if (typeof ref === 'string') {
    const issueId = ref.trim();
    if (!issueId) return null;
    return { issueId, kind: 'related', addedAt: addedAt ?? issuesNowMs() };
  }
  const issueId =
    typeof ref.issueId === 'string'
      ? ref.issueId.trim()
      : typeof (ref as { issue_id?: string }).issue_id === 'string'
        ? (ref as { issue_id: string }).issue_id.trim()
        : '';
  if (!issueId) return null;
  const kindRaw = typeof ref.kind === 'string' ? ref.kind.trim() : 'related';
  if (!isIssueRelationKind(kindRaw)) return null;
  const out: IssueIssueRef = {
    issueId,
    kind: kindRaw,
    addedAt: typeof ref.addedAt === 'number' ? ref.addedAt : addedAt ?? issuesNowMs(),
  };
  if (typeof ref.note === 'string' && ref.note.trim()) {
    out.note = ref.note.trim();
  }
  return out;
}

/** True when two code refs point at the same path + line range. */
export function issueCodeRefsEqual(a: IssueCodeRef, b: IssueCodeRef): boolean {
  return (
    a.path.replace(/\\/g, '/') === b.path.replace(/\\/g, '/') &&
    (a.startLine ?? null) === (b.startLine ?? null) &&
    (a.endLine ?? null) === (b.endLine ?? null)
  );
}

/** Normalize a code ref for storage (forward slashes, sane line range). */
export function normalizeIssueCodeRef(ref: IssueCodeRef): IssueCodeRef | null {
  const path = ref.path.trim().replace(/\\/g, '/');
  if (!path) return null;
  const out: IssueCodeRef = { path };
  if (typeof ref.startLine === 'number' && Number.isFinite(ref.startLine)) {
    out.startLine = Math.max(1, Math.floor(ref.startLine));
  }
  if (typeof ref.endLine === 'number' && Number.isFinite(ref.endLine)) {
    const start = out.startLine ?? 1;
    out.endLine = Math.max(start, Math.floor(ref.endLine));
  }
  if (typeof ref.snippet === 'string' && ref.snippet.trim()) {
    out.snippet = ref.snippet;
  }
  if (typeof ref.note === 'string' && ref.note.trim()) {
    out.note = ref.note.trim();
  }
  return out;
}

/** Normalize a git link chip for storage. */
export function normalizeIssueGitLink(
  link: Omit<IssueGitLink, 'addedAt'> & { addedAt?: number },
): IssueGitLink | null {
  const kind = link.kind;
  const ref = typeof link.ref === 'string' ? link.ref.trim() : '';
  if (!ref) return null;
  if (kind !== 'commit' && kind !== 'branch' && kind !== 'pr' && kind !== 'github-issue') {
    return null;
  }
  const out: IssueGitLink = {
    kind,
    ref,
    addedAt: typeof link.addedAt === 'number' ? link.addedAt : issuesNowMs(),
  };
  if (typeof link.url === 'string' && link.url.trim()) out.url = link.url.trim();
  if (typeof link.title === 'string' && link.title.trim()) out.title = link.title.trim();
  return out;
}

export type AppendIssueLinksInput = {
  codeRefs?: IssueCodeRef[];
  gitLinks?: Array<Omit<IssueGitLink, 'addedAt'> & { addedAt?: number }>;
  chatId?: string;
  issueRefs?: IssueIssueRef[];
};

/** Append one normalized issue ref to a card when not already present. */
function appendIssueIssueRefToCard(issue: IssueCard, ref: IssueIssueRef): boolean {
  const existing = issue.issueRefs ? [...issue.issueRefs] : [];
  if (existing.some((entry) => issueIssueRefsEqual(entry, ref))) return false;
  existing.push(ref);
  issue.issueRefs = existing;
  return true;
}

/**
 * Append-only links for issue_link (code refs, git chips, chat id, issue refs).
 * Dedupes identical path/line ranges, kind+ref git links, and issueId+kind issue refs.
 * Issue refs are written bidirectionally with inverse kinds on the target card.
 */
export function appendIssueLinks(
  issueId: string,
  links: AppendIssueLinksInput,
): IssueCard | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;

  let changed = false;
  if (links.codeRefs?.length) {
    const existing = issue.codeRefs ? [...issue.codeRefs] : [];
    for (const raw of links.codeRefs) {
      const ref = normalizeIssueCodeRef(raw);
      if (!ref) continue;
      const planPath = normalizeIssuePlanPath(ref.path);
      if (planPath) {
        if (issue.planPath !== planPath) {
          issue.planPath = planPath;
          changed = true;
        }
        continue;
      }
      if (existing.some((e) => issueCodeRefsEqual(e, ref))) continue;
      existing.push(ref);
      changed = true;
    }
    issue.codeRefs = existing;
    const stripped = existing.filter((entry) => !normalizeIssuePlanPath(entry.path));
    if (stripped.length !== existing.length) {
      issue.codeRefs = stripped;
      changed = true;
    }
  }

  if (links.gitLinks?.length) {
    const existing = issue.gitLinks ? [...issue.gitLinks] : [];
    for (const raw of links.gitLinks) {
      const link = normalizeIssueGitLink(raw);
      if (!link) continue;
      if (existing.some((e) => e.kind === link.kind && e.ref === link.ref)) continue;
      existing.push(link);
      changed = true;
    }
    issue.gitLinks = existing;
  }

  const chatId = links.chatId?.trim();
  if (chatId) {
    const chatIds = issue.chatIds ? [...issue.chatIds] : [];
    if (!chatIds.includes(chatId)) {
      chatIds.push(chatId);
      issue.chatIds = chatIds;
      changed = true;
    }
  }

  if (links.issueRefs?.length) {
    for (const raw of links.issueRefs) {
      const ref = normalizeIssueIssueRef(raw);
      if (!ref) continue;
      if (ref.issueId === issue.id) continue;
      const target = findIssueById(ref.issueId);
      if (!target) continue;
      const sourceAdded = appendIssueIssueRefToCard(issue, ref);
      const inverseRef: IssueIssueRef = {
        issueId: issue.id,
        kind: inverseIssueRelationKind(ref.kind),
        note: ref.note,
        addedAt: ref.addedAt,
      };
      const targetAdded = appendIssueIssueRefToCard(target, inverseRef);
      if (sourceAdded || targetAdded) {
        changed = true;
        target.updatedAt = issuesNowMs();
      }
    }
  }

  if (!changed) {
    return issue;
  }
  issue.updatedAt = issuesNowMs();
  touchIssuesStore();
  return issue;
}

/** Patch one issue; returns updated card or null if missing. */
export function updateIssue(
  issueId: string,
  patch: UpdateIssuePatch,
  options?: UpdateIssueOptions,
): IssueCard | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;
  const taxonomy = getIssuesTaxonomySync();
  const beforeSynced = githubSyncedSnapshot(issue, isClosedStatus(taxonomy, issue.status));
  const nowMs = issuesNowMs();
  if (patch.title !== undefined) issue.title = patch.title.trim();
  if (patch.description !== undefined) issue.description = patch.description;
  if (patch.type) issue.type = patch.type;
  if (patch.status) issue.status = patch.status;
  if (patch.priority) issue.priority = patch.priority;
  // Empty array is a real clear (last chip removed), not "leave labels alone".
  if (patch.labels !== undefined) {
    issue.labels = commitIssueLabels(patch.labels, { persist: false });
  }
  if (patch.notes !== undefined) issue.notes = patch.notes;
  if (patch.planPath !== undefined) {
    const trimmed = patch.planPath.trim();
    if (trimmed) issue.planPath = trimmed;
    else delete issue.planPath;
  }
  if (patch.boardChatId !== undefined) issue.boardChatId = patch.boardChatId;
  if (patch.investigateRunId !== undefined) issue.investigateRunId = patch.investigateRunId;
  if (patch.planRunId !== undefined) issue.planRunId = patch.planRunId;
  // Empty array is a real unlink (last chat removed), not "leave chatIds alone".
  if (patch.chatIds !== undefined) issue.chatIds = [...patch.chatIds];
  if (patch.codeRefs) {
    issue.codeRefs = patch.codeRefs
      .map((r) => normalizeIssueCodeRef(r))
      .filter((r): r is IssueCodeRef => r != null);
  }
  if (patch.gitLinks) {
    issue.gitLinks = patch.gitLinks
      .map((g) => normalizeIssueGitLink(g))
      .filter((g): g is IssueGitLink => g != null);
  }
  if (patch.issueRefs) {
    issue.issueRefs = patch.issueRefs
      .map((ref) => normalizeIssueIssueRef(ref))
      .filter((ref): ref is IssueIssueRef => ref != null);
  }
  if (patch.assignee !== undefined) {
    if (patch.assignee === null) delete issue.assignee;
    else issue.assignee = { ...patch.assignee };
  }
  if (patch.agent !== undefined) {
    if (patch.agent === null) delete issue.agent;
    else issue.agent = { ...patch.agent };
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === null) {
      delete issue.parentId;
    } else {
      const parentCheck = validateParentLink(
        issue.id,
        patch.parentId,
        requireIssuesState().issues,
      );
      if (!parentCheck.ok) throw new Error(parentCheck.error);
      issue.parentId = patch.parentId;
    }
  }
  if (patch.rank !== undefined) {
    if (patch.rank === null) delete issue.rank;
    else issue.rank = patch.rank;
  }
  if (patch.projectId !== undefined) {
    if (patch.projectId === null) delete issue.projectId;
    else issue.projectId = patch.projectId;
  }
  if (patch.source !== undefined) issue.source = patch.source;
  if (patch.triagedAt !== undefined) {
    if (patch.triagedAt === null) delete issue.triagedAt;
    else issue.triagedAt = patch.triagedAt;
  }
  if (patch.githubSync !== undefined) issue.githubSync = patch.githubSync;
  const afterSynced = githubSyncedSnapshot(issue, isClosedStatus(taxonomy, issue.status));
  issue.updatedAt = nowMs;
  if (issue.github && githubSyncedFieldsChanged(beforeSynced, afterSynced)) {
    issue.updatedAt = Math.max(nowMs, (issue.github.localChangedAt ?? issue.github.localUpdatedAt ?? 0) + 1);
    issue.github.localChangedAt = issue.updatedAt;
  }
  touchIssuesStore();
  // Auto-sync keys off GitHub-shaped fields, not every updatedAt bump (rank, assignee, …).
  if (!options?.skipGithubAutoSync && githubSyncedFieldsChanged(beforeSynced, afterSynced)) {
    notifyGithubSyncedFieldWrite(issueId);
  }
  return issue;
}

/** True when an issue id matches the card id or legacy bug id. */
function issueMatchesKey(issue: IssueCard, key: string): boolean {
  return issue.id === key || issue.legacyBugId === key;
}

/** Remove one issue by id (ISS-n or legacy bug id). Returns true when removed. */
export function deleteIssue(issueId: string): boolean {
  const key = issueId.trim();
  if (!key) return false;
  const state = requireIssuesState();
  const idx = state.issues.findIndex((issue) => issueMatchesKey(issue, key));
  if (idx < 0) return false;
  state.issues.splice(idx, 1);
  touchIssuesStore();
  return true;
}

/** Remove multiple issues; returns the number removed. */
export function deleteIssues(issueIds: string[]): number {
  const keys = new Set(issueIds.map((id) => id.trim()).filter(Boolean));
  if (keys.size === 0) return 0;
  const state = requireIssuesState();
  const before = state.issues.length;
  state.issues = state.issues.filter((issue) => {
    for (const key of keys) {
      if (issueMatchesKey(issue, key)) return false;
    }
    return true;
  });
  const removed = before - state.issues.length;
  if (removed > 0) touchIssuesStore();
  return removed;
}

/** Serialize all issues for tools and UI. */
export function getIssuesSnapshot(): IssuesState {
  const state = requireIssuesState();
  const workspaces = state.workspaces
    ? Object.fromEntries(
        Object.entries(state.workspaces).map(([key, cfg]) => [
          key,
          { projectKey: cfg.projectKey, nextId: cfg.nextId },
        ]),
      )
    : {};
  return {
    ...state,
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: state.schemaRevision ?? ISSUES_SCHEMA_VERSION,
    nextId: state.nextId,
    issues: state.issues.map((i) => ({ ...i, labels: [...i.labels] })),
    workspaces,
    labelCatalog: (state.labelCatalog ?? []).map((entry) => ({ ...entry })),
  };
}

/** Saved workspace id config, if any. */
export function getWorkspaceIdConfig(
  workspacePath?: string,
): IssuesWorkspaceIdConfig | undefined {
  const wsKey = normalizeWorkspacePath(workspacePath?.trim() || getWorkspacePath());
  return requireIssuesState().workspaces?.[wsKey];
}

/** Effective project key (saved or suggested from folder name). */
export function getWorkspaceProjectKey(workspacePath?: string): string {
  const wsKey = normalizeWorkspacePath(workspacePath?.trim() || getWorkspacePath());
  const saved = getWorkspaceIdConfig(wsKey);
  if (saved) return saved.projectKey;
  return suggestProjectKey(labelForWorkspacePath(wsKey));
}

/** Preview the next auto-allocated id for a workspace. */
export function getNextIssueIdPreview(workspacePath?: string): string {
  const wsKey = normalizeWorkspacePath(workspacePath?.trim() || getWorkspacePath());
  const key = getWorkspaceProjectKey(wsKey);
  const state = requireIssuesState();
  const saved = state.workspaces?.[wsKey];
  const nextNum =
    saved?.nextId ?? maxIssueNumberForKey(state.issues, wsKey, key) + 1;
  return `${key}-${nextNum}`;
}

/** Count issues stored for one workspace path. */
export function countIssuesInWorkspace(workspacePath: string): number {
  const wsKey = normalizeWorkspacePath(workspacePath);
  return requireIssuesState().issues.filter(
    (issue) => normalizeWorkspacePath(issue.workspacePath) === wsKey,
  ).length;
}

/** Persist a new project key for one workspace (reconciles nextId from existing cards). */
export function setWorkspaceProjectKey(
  workspacePath: string,
  rawKey: string,
): { ok: true } | { ok: false; error: string } {
  const validationError = validateProjectKey(rawKey);
  if (validationError) return { ok: false, error: validationError };
  const projectKey = normalizeProjectKeyInput(rawKey);
  const wsKey = normalizeWorkspacePath(workspacePath);
  const state = requireIssuesState();
  const map = ensureWorkspacesMap(state);
  const nextId = maxIssueNumberForKey(state.issues, wsKey, projectKey) + 1;
  map[wsKey] = { projectKey, nextId };
  touchIssuesStore();
  return { ok: true };
}

// ── Projects views ───────────────────────────────────────────────────────────

function ensureProjectsList(state: IssuesState): IssueProject[] {
  if (!state.projects) state.projects = [];
  return state.projects;
}

function ensureViewsList(state: IssuesState): IssueSavedView[] {
  if (!state.views) state.views = [];
  return state.views;
}

/** Seed Triage / Assigned to agents / My open when the file has no views yet. */
export function ensureIssueViews(): IssueSavedView[] {
  const state = requireIssuesState();
  const existing = state.views;
  if (existing && existing.length > 0) {
    if (migrateBuiltInIssueViews(existing)) touchIssuesStore();
    return existing;
  }
  state.views = builtInIssueViews();
  touchIssuesStore();
  return state.views;
}

export function listIssueViews(): IssueSavedView[] {
  return [...ensureIssueViews()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function addIssueView(input: {
  name: string;
  filters: IssueSavedView['filters'];
  groupBy?: string;
}): IssueSavedView {
  const views = ensureIssueViews();
  const nowOrder = views.reduce((max, view) => Math.max(max, view.order), 0) + 1;
  const view: IssueSavedView = {
    id: `view-${issuesNowMs().toString(36)}`,
    name: input.name.trim() || 'Untitled view',
    filters: { ...input.filters },
    order: nowOrder,
  };
  if (input.groupBy) view.groupBy = input.groupBy;
  views.push(view);
  touchIssuesStore();
  return view;
}

export function deleteIssueView(viewId: string): boolean {
  const state = requireIssuesState();
  const views = state.views;
  if (!views) return false;
  const idx = views.findIndex((view) => view.id === viewId);
  if (idx < 0) return false;
  if (views[idx].builtIn) return false;
  views.splice(idx, 1);
  touchIssuesStore();
  return true;
}

export function listIssueProjects(options?: { includeArchived?: boolean }): IssueProject[] {
  const projects = requireIssuesState().projects ?? [];
  const rows = options?.includeArchived ? projects : projects.filter((project) => !project.archivedAt);
  return [...rows].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function findIssueProject(projectId: string): IssueProject | undefined {
  return requireIssuesState().projects?.find((project) => project.id === projectId);
}

export function addIssueProject(name: string, extras?: { description?: string; color?: string }): IssueProject {
  const nowMs = issuesNowMs();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  const project: IssueProject = {
    id: `proj-${nowMs.toString(36)}`,
    name: trimmed,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  if (extras?.description?.trim()) project.description = extras.description.trim();
  if (extras?.color?.trim()) project.color = extras.color.trim();
  ensureProjectsList(requireIssuesState()).push(project);
  touchIssuesStore();
  return project;
}

export function renameIssueProject(projectId: string, name: string): IssueProject | null {
  const project = findIssueProject(projectId);
  if (!project) return null;
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  project.name = trimmed;
  project.updatedAt = issuesNowMs();
  touchIssuesStore();
  return project;
}

export function archiveIssueProject(projectId: string): IssueProject | null {
  const project = findIssueProject(projectId);
  if (!project) return null;
  project.archivedAt = issuesNowMs();
  project.updatedAt = project.archivedAt;
  touchIssuesStore();
  return project;
}

/** Closed vs open counts for issues in this project (not nested projects). */
export function issueProjectProgress(projectId: string): { done: number; total: number } {
  const taxonomy = getIssuesTaxonomySync();
  let done = 0;
  let total = 0;
  for (const issue of requireIssuesState().issues) {
    if (issue.projectId !== projectId) continue;
    total += 1;
    if (isClosedStatus(taxonomy, issue.status)) done += 1;
  }
  return { done, total };
}

// ── Attachments ──────────────────────────────────────────────────────────────

/**
 * Attach a stored file to an issue.
 *
 * The bytes are already on disk by the time this runs — the upload happens over
 * `/api/issues/attachments`, and this only records where they landed. Splitting
 * it that way keeps the debounced state write free of binary payloads, which is
 * the failure shape MIN-354 v1 hit.
 */
export function addIssueAttachment(
  issueId: string,
  attachment: Omit<IssueAttachment, 'id' | 'addedAt'> & { id?: string; addedAt?: number },
): IssueAttachment | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;
  const nowMs = issuesNowMs();
  const entry: IssueAttachment = {
    id: attachment.id?.trim() || `att-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: attachment.name.trim(),
    path: attachment.path.trim(),
    addedAt: attachment.addedAt ?? nowMs,
  };
  if (attachment.mime?.trim()) entry.mime = attachment.mime.trim();
  if (typeof attachment.bytes === 'number' && attachment.bytes >= 0) {
    entry.bytes = Math.floor(attachment.bytes);
  }
  if (!entry.name || !entry.path) return null;

  const existing = issue.attachments ? [...issue.attachments] : [];
  if (existing.some((item) => item.path === entry.path)) return existing.find((i) => i.path === entry.path) ?? null;
  existing.push(entry);
  issue.attachments = existing;
  issue.updatedAt = nowMs;
  touchIssuesStore();
  return entry;
}

/** Drop an attachment record. Removing the bytes is the caller's job. */
export function removeIssueAttachment(issueId: string, attachmentId: string): boolean {
  const issue = findIssueById(issueId);
  if (!issue?.attachments?.length) return false;
  const next = issue.attachments.filter((item) => item.id !== attachmentId);
  if (next.length === issue.attachments.length) return false;
  issue.attachments = next;
  issue.updatedAt = issuesNowMs();
  touchIssuesStore();
  return true;
}

/* ── Comments, activity, and the agent slot (Phase 4) ────────────────────── */

function newIssueSubId(prefix: string): string {
  return `${prefix}-${issuesNowMs().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Append to the comment timeline.
 *
 * Append-only by design: `notes` was a single overwritable string, and an agent
 * reporting progress by clobbering the user's last note is exactly the failure
 * §10 calls out.
 */
export function addIssueComment(
  issueId: string,
  input: { body: string; authorKind?: IssueComment['authorKind']; author?: string },
): IssueComment | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;
  const body = input.body.trim();
  if (!body) return null;

  const comment: IssueComment = {
    id: newIssueSubId('cmt'),
    authorKind: input.authorKind ?? 'user',
    body,
    createdAt: issuesNowMs(),
  };
  if (input.author?.trim()) comment.author = input.author.trim();

  issue.comments = [...(issue.comments ?? []), comment];
  issue.updatedAt = comment.createdAt;
  touchIssuesStore();
  return comment;
}

/** Remove a comment by id. */
export function deleteIssueComment(issueId: string, commentId: string): boolean {
  const issue = findIssueById(issueId);
  if (!issue?.comments?.length) return false;
  const next = issue.comments.filter((c) => c.id !== commentId);
  if (next.length === issue.comments.length) return false;
  issue.comments = next;
  issue.updatedAt = issuesNowMs();
  touchIssuesStore();
  return true;
}

/**
 * Append one activity entry, capped at {@link ISSUE_ACTIVITY_CAP}.
 *
 * The cap is what lets activity live in the single debounced state file rather
 * than a second append-only file with its own write path — the shape that broke
 * MIN-354 v1. Oldest entries drop first.
 */
export function appendIssueActivity(
  issueId: string,
  entry: Omit<IssueActivityEntry, 'id' | 'at'> & { id?: string; at?: number },
): IssueActivityEntry | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;

  const record: IssueActivityEntry = {
    id: entry.id ?? newIssueSubId('act'),
    kind: entry.kind,
    at: entry.at ?? issuesNowMs(),
  };
  if (entry.actorKind) record.actorKind = entry.actorKind;
  if (entry.actor) record.actor = entry.actor;
  if (entry.data) record.data = entry.data;

  const next = [...(issue.activity ?? []), record];
  issue.activity = next.slice(-ISSUE_ACTIVITY_CAP);
  issue.updatedAt = record.at;
  touchIssuesStore();
  return record;
}

// ── Agent runs ───────────────────────────────────────────────────────────────

/** Start (or restart) the agent slot on an issue. */
export function startIssueAgentRun(
  issueId: string,
  input: { agentId?: string; step?: string } & Partial<
    Pick<IssueAgentRun, 'boardGroupId' | 'boardTaskId' | 'chatId' | 'worktreePath' | 'branch'>
  >,
): IssueAgentRun | null {
  const issue = findIssueById(issueId);
  if (!issue) return null;
  const nowMs = issuesNowMs();

  const run: IssueAgentRun = {
    agentId: input.agentId?.trim() || issue.agent?.agentId || 'builder',
    phase: 'running',
    startedAt: nowMs,
    updatedAt: nowMs,
  };
  if (input.step) run.step = input.step;
  if (input.boardGroupId) run.boardGroupId = input.boardGroupId;
  if (input.boardTaskId) run.boardTaskId = input.boardTaskId;
  if (input.chatId) run.chatId = input.chatId;
  if (input.worktreePath) run.worktreePath = input.worktreePath;
  if (input.branch) run.branch = input.branch;

  issue.agent = run;
  issue.updatedAt = nowMs;
  touchIssuesStore();
  appendIssueActivity(issueId, {
    kind: 'agent_started',
    actorKind: 'agent',
    actor: run.agentId,
  });
  return run;
}

/**
 * Patch the agent slot.
 *
 * Setting a terminal phase clears `step` and `pendingQuestionId`: a run that has
 * failed or opened its PR is no longer doing anything, and a stale "Running
 * tests" chip next to a failure is worse than no chip.
 */
export function updateIssueAgentRun(
  issueId: string,
  patch: Partial<IssueAgentRun>,
): IssueAgentRun | null {
  const issue = findIssueById(issueId);
  if (!issue?.agent) return null;

  const nowMs = issuesNowMs();
  const next: IssueAgentRun = { ...issue.agent, ...patch, updatedAt: nowMs };
  if (patch.phase && TERMINAL_AGENT_PHASES.has(patch.phase)) {
    if (patch.step === undefined) delete next.step;
    if (patch.pendingQuestionId === undefined) delete next.pendingQuestionId;
  }
  issue.agent = next;
  issue.updatedAt = nowMs;
  touchIssuesStore();

  if (patch.phase && patch.phase !== issue.agent.phase) {
    appendIssueActivity(issueId, {
      kind: `agent_${patch.phase}`,
      actorKind: 'agent',
      actor: next.agentId,
    });
  }
  return next;
}

const TERMINAL_AGENT_PHASES: ReadonlySet<IssueAgentPhase> = new Set<IssueAgentPhase>([
  'review',
  'failed',
  'canceled',
  'done',
]);

/** True when the agent slot is doing something the user should see live. */
export function isIssueAgentActive(issue: IssueCard): boolean {
  const phase = issue.agent?.phase;
  return phase === 'queued' || phase === 'running' || phase === 'awaiting_input';
}

/** Drop the agent slot entirely (unassign). */
export function clearIssueAgentRun(issueId: string): boolean {
  const issue = findIssueById(issueId);
  if (!issue?.agent) return false;
  delete issue.agent;
  issue.updatedAt = issuesNowMs();
  touchIssuesStore();
  return true;
}

/** Issues with an agent currently queued, running, or waiting on the user. */
export function listIssuesWithActiveAgents(): IssueCard[] {
  return requireIssuesState().issues.filter(isIssueAgentActive);
}

/** Accept an unreviewed auto-filed issue: backlog-role status + triagedAt now. */
export function acceptTriageIssue(issueId: string): IssueCard | null {
  return updateIssue(issueId, {
    status: requireIssueStatusForRole('backlog'),
    triagedAt: issuesNowMs(),
  });
}

/** Decline an unreviewed auto-filed issue: canceled-role status + triagedAt now. */
export function declineTriageIssue(issueId: string): IssueCard | null {
  return updateIssue(issueId, {
    status: requireIssueStatusForRole('canceled'),
    triagedAt: issuesNowMs(),
  });
}

/**
 * Queue a work agent on the issue. Phase 1 writes the slot only — it does not
 * spin a board, worktree, or PR (Phase 4 owns the runtime).
 */
export function queueIssueAgent(issueId: string, agentId = 'builder'): IssueCard | null {
  const nowMs = issuesNowMs();
  return updateIssue(issueId, {
    agent: { agentId, phase: 'queued', startedAt: nowMs, updatedAt: nowMs },
  });
}

export function assignIssueToMe(issueId: string): IssueCard | null {
  return updateIssue(issueId, {
    assignee: { id: LOCAL_ASSIGNEE_ID, label: 'Me', assignedAt: issuesNowMs() },
  });
}

export type CollectIssuesOptions = {
  workspacePath?: string;
  scope?: 'all' | 'current_workspace';
  status?: IssueStatus | 'all';
  type?: IssueType | 'all';
  priority?: IssuePriority | 'all';
  label?: string;
  hideDone?: boolean;
  search?: string;
  projectId?: string | null;
  unreviewed?: boolean;
  hasAgent?: boolean;
  /** Assignee is me, or the card has no assignee yet. */
  mine?: boolean;
  assigneeId?: string | null;
};

/** Unique label strings used across issues (for autocomplete), case-insensitive dedupe. */
export { normalizeIssueLabel };

function ensureLabelCatalog(names: readonly string[], persistQuiet: boolean): IssueLabelCatalogEntry[] {
  const state = requireIssuesState();
  const merged = mergeIssueLabelCatalog(state.labelCatalog ?? [], names);
  state.labelCatalog = merged.catalog;
  if (merged.changed && persistQuiet) scheduleSaveIssues();
  return merged.catalog;
}

/** Normalize names, register them in the catalog, and return the committed list. */
function commitIssueLabels(
  raw: readonly string[],
  options: { persist: boolean },
): string[] {
  const labels = normalizeIssueLabelsList(raw);
  ensureLabelCatalog(labels, options.persist);
  return labels;
}

/** Color for a label name, assigning a swatch if the catalog has not seen it yet. */
export function getIssueLabelSwatch(name: string): IssueLabelSwatchId {
  const normalized = normalizeIssueLabel(name);
  if (!normalized) return ISSUE_LABEL_SWATCH_IDS[0];
  const catalog = ensureLabelCatalog([normalized], true);
  const key = normalized.toLowerCase();
  return catalog.find((entry) => entry.name.toLowerCase() === key)?.color ?? ISSUE_LABEL_SWATCH_IDS[0];
}

/** Recolor a catalog name on every issue. Does not bump issue.updatedAt. */
export function setIssueLabelColor(name: string, color: IssueLabelSwatchId): void {
  const normalized = normalizeIssueLabel(name);
  if (!normalized) return;
  const state = requireIssuesState();
  const catalog = [...(state.labelCatalog ?? [])];
  const key = normalized.toLowerCase();
  const index = catalog.findIndex((entry) => entry.name.toLowerCase() === key);
  if (index >= 0) {
    if (catalog[index].color === color) return;
    catalog[index] = { name: catalog[index].name, color };
  } else {
    catalog.push({ name: normalized, color });
  }
  state.labelCatalog = catalog;
  touchIssuesStore();
}

export function collectIssueLabelSuggestions(excludeIssueId?: string): string[] {
  const state = requireIssuesState();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string): void => {
    const normalized = normalizeIssueLabel(raw);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };
  for (const entry of state.labelCatalog ?? []) {
    push(entry.name);
  }
  for (const issue of state.issues) {
    if (excludeIssueId && issue.id === excludeIssueId) continue;
    for (const label of issue.labels) {
      push(label);
    }
  }
  out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return out;
}

/** Filter/sort issues for list + board views. */
export function collectIssues(options: CollectIssuesOptions = {}): IssueCard[] {
  const scope = options.scope ?? 'current_workspace';
  const hideDone = options.hideDone !== false;
  const statusFilter = options.status ?? 'all';
  const typeFilter = options.type ?? 'all';
  const priorityFilter = options.priority ?? 'all';
  const labelFilter = options.label?.trim().toLowerCase() ?? '';
  const search = options.search?.trim().toLowerCase() ?? '';
  const workspaceKey =
    scope === 'current_workspace' && options.workspacePath != null
      ? normalizeWorkspacePath(options.workspacePath)
      : null;

  const out: IssueCard[] = [];
  for (const issue of requireIssuesState().issues) {
    const issueWorkspace = normalizeWorkspacePath(issue.workspacePath ?? '');
    if (workspaceKey !== null && issueWorkspace !== workspaceKey) continue;
    if (hideDone && isClosedStatus(getIssuesTaxonomySync(), issue.status)) continue;
    if (statusFilter !== 'all' && issue.status !== statusFilter) continue;
    if (typeFilter !== 'all' && issue.type !== typeFilter) continue;
    if (priorityFilter !== 'all' && issue.priority !== priorityFilter) continue;
    if (labelFilter && !issue.labels.some((l) => l.toLowerCase() === labelFilter)) continue;
    if (options.projectId === null) {
      if (issue.projectId) continue;
    } else if (options.projectId && issue.projectId !== options.projectId) {
      continue;
    }
    if (options.unreviewed && !isUnreviewedTriageIssue(issue)) continue;
    if (options.hasAgent && !issue.agent) continue;
    if (options.mine) {
      const assigneeId = issue.assignee?.id;
      if (assigneeId && assigneeId !== LOCAL_ASSIGNEE_ID) continue;
    }
    if (options.assigneeId === null) {
      if (issue.assignee) continue;
    } else if (options.assigneeId && issue.assignee?.id !== options.assigneeId) {
      continue;
    }
    if (search) {
      const hay = `${issue.id} ${issue.title} ${issue.description} ${issue.labels.join(' ')}`.toLowerCase();
      if (!hay.includes(search)) continue;
    }
    out.push(issue);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Count open issues for sidebar badge. */
export function countOpenIssues(
  options: Pick<CollectIssuesOptions, 'scope' | 'workspacePath'> = {},
): number {
  const scope = options.scope ?? 'current_workspace';
  const workspaceKey =
    scope === 'current_workspace' && options.workspacePath != null
      ? normalizeWorkspacePath(options.workspacePath)
      : null;
  let n = 0;
  for (const issue of requireIssuesState().issues) {
    if (!getOpenIssueStatuses().includes(issue.status)) continue;
    if (workspaceKey !== null) {
      const issueWorkspace = normalizeWorkspacePath(issue.workspacePath ?? '');
      if (issueWorkspace !== workspaceKey) continue;
    }
    n += 1;
  }
  return n;
}

/** Project an issue into legacy BugCard shape (bug_* tool compatibility). */
export function issueToBugCard(issue: IssueCard): BugCard {
  const card: BugCard = {
    id: issue.legacyBugId ?? issue.id,
    title: issue.title,
    description: issue.description,
    severity: issue.severity ?? issuePriorityToBugSeverity(issue.priority),
    column: issueStatusToBugColumn(issue.status),
    workspacePath: issue.workspacePath,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
  if (issue.chatIds?.[0]) card.chatId = issue.chatIds[0];
  if (typeof issue.notes === 'string') card.notes = issue.notes;
  if (issue.planPath) card.planPath = issue.planPath;
  if (issue.investigateRunId) card.investigateRunId = issue.investigateRunId;
  if (issue.planRunId) card.planRunId = issue.planRunId;
  if (issue.boardChatId) card.fixRunId = issue.boardChatId;
  return card;
}

/** Test harness: inject in-memory issues without API. */
export function setIssuesStateForTests(state: IssuesState | null): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  issuesState = state;
  persistedIssuesBase = state ? cloneState(state) : null;
  issuesLoaded = state !== null;
}

export function isIssuesStoreLoaded(): boolean {
  return issuesLoaded;
}
