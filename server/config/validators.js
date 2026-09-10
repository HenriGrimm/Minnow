import { ALL_TOOL_IDS, ARCHIVE_RECALL_TOOL_IDS, BRAIN_DESTRUCTIVE_TOOL_IDS, BRAIN_FULL_PERMISSION_TOOL_IDS, BRAIN_FULL_PERMISSION_TOOL_ID_SET, MINNOW_DOCS_TOOL_IDS } from './tool-ids.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { normalizeToolOutputConfig } from '../tools/output-cap.js';
import { normalizeSamplerPreset } from '../agents/sampler.js';
import {
  clampThinkingBudgetTokens,
  normalizeThinkingGlobalDefault,
  normalizeThinkingTriState,
} from '../agents/thinking.js';
import {
  clampGenerationIdleTimeoutMs,
  clampGenerationMaxDurationMs,
  DEFAULT_GENERATION_IDLE_TIMEOUT_MS,
  DEFAULT_GENERATION_MAX_DURATION_MS,
} from '../generations/timeouts.js';
import {
  SESSION_SCHEMA_VERSION,
  migrateChatRowV5ToV6,
  normalizeChatRow,
  normalizeGroupRow,
  normalizeSessionScalars,
  normalizeWorkspacePath,
} from '../../src/state/session-schema.mjs';
import {
  foldAutopilotDefaultStatus,
  stripStaleAutopilotKeys,
} from '../../src/lib/leftover-autonomy.mjs';

export {
  SESSION_SCHEMA_VERSION,
  migrateChatRowV5ToV6,
  normalizeChatRow,
  normalizeGroupRow,
  normalizeSessionScalars,
  normalizeWorkspacePath,
} from '../../src/state/session-schema.mjs';

const BUG_COLUMNS = new Set([
  'reported',
  'investigating',
  'planned',
  'fixing',
  'complete',
]);
const BUG_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function ensureBugCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const title = typeof r.title === 'string' ? r.title : '';
  const description = typeof r.description === 'string' ? r.description : '';
  const severityRaw = typeof r.severity === 'string' ? r.severity : 'medium';
  const columnRaw = typeof r.column === 'string' ? r.column : 'reported';
  if (!id || !BUG_SEVERITIES.has(severityRaw) || !BUG_COLUMNS.has(columnRaw)) return null;
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : createdAt;
  const out = {
    id,
    title,
    description,
    severity: severityRaw,
    column: columnRaw,
    createdAt,
    updatedAt,
  };
  if (typeof r.notes === 'string') out.notes = r.notes;
  if (typeof r.planPath === 'string' && r.planPath.trim()) out.planPath = r.planPath.trim();
  if (typeof r.investigateRunId === 'string' && r.investigateRunId.trim()) {
    out.investigateRunId = r.investigateRunId.trim();
  }
  if (typeof r.planRunId === 'string' && r.planRunId.trim()) {
    out.planRunId = r.planRunId.trim();
  }
  if (typeof r.fixRunId === 'string' && r.fixRunId.trim()) {
    out.fixRunId = r.fixRunId.trim();
  }
  if (typeof r.workspacePath === 'string') {
    out.workspacePath = normalizeWorkspacePath(r.workspacePath);
  } else {
    out.workspacePath = '';
  }
  if (typeof r.chatId === 'string' && r.chatId.trim()) {
    out.chatId = r.chatId.trim();
  }
  return out;
}

function ensureBugBoard(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(r.bugs)) return undefined;
  const bugs = [];
  for (const item of r.bugs) {
    const card = ensureBugCard(item);
    if (card) bugs.push(card);
  }
  const startedAt = typeof r.startedAt === 'number' ? r.startedAt : Date.now();
  const lastUpdatedAt = typeof r.lastUpdatedAt === 'number' ? r.lastUpdatedAt : startedAt;
  return { bugs, startedAt, lastUpdatedAt };
}

export function validateBugsState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, bugs: [] };
  }
  const row = /** @type {Record<string, unknown>} */ (raw);
  if (row.version !== 1 || !Array.isArray(row.bugs)) {
    return { version: 1, bugs: [] };
  }
  const bugs = [];
  for (const item of row.bugs) {
    const card = ensureBugCard(item);
    if (card) bugs.push(card);
  }
  return { version: 1, bugs };
}

const TAXONOMY_SLUG_RE = /^[a-z][a-z0-9_]*$/;
const TAXONOMY_COLOR_RE = /^(var\(--mn-[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})$/;
const ISSUE_TYPE_SEED_REVISION = 2;
const ISSUE_STATUS_ROLES = new Set([
  'triage',
  'backlog',
  'todo',
  'planned',
  'in_progress',
  'review',
  'done',
  'canceled',
]);

function isTaxonomyColor(value) {
  return typeof value === 'string' && TAXONOMY_COLOR_RE.test(value.trim());
}

export function defaultIssuesTaxonomy() {
  return {
    version: 1,
    typeSeedRevision: ISSUE_TYPE_SEED_REVISION,
    types: [
      { id: 'bug', label: 'Bug', order: 0, color: 'var(--mn-danger)' },
      { id: 'task', label: 'Task', order: 1, color: 'var(--mn-accent)' },
      { id: 'idea', label: 'Idea', order: 2, color: 'var(--mn-warning)' },
      { id: 'note', label: 'Note', order: 3, color: 'var(--mn-fg-muted)' },
      { id: 'feature', label: 'Feature', order: 4, color: 'var(--mn-label-fig)' },
      { id: 'improvement', label: 'Improvement', order: 5, color: 'var(--mn-label-kelp)' },
    ],
    statuses: [
      { id: 'triage', label: 'Triage', order: 0, role: 'triage', boardVisible: true },
      { id: 'backlog', label: 'Backlog', order: 1, role: 'backlog', boardVisible: false },
      { id: 'todo', label: 'Todo', order: 2, role: 'todo', boardVisible: true },
      { id: 'planned', label: 'Planned', order: 3, role: 'planned', boardVisible: true },
      {
        id: 'in_progress',
        label: 'In progress',
        order: 4,
        role: 'in_progress',
        boardVisible: true,
      },
      { id: 'review', label: 'Review', order: 5, role: 'review', boardVisible: true },
      { id: 'done', label: 'Done', order: 6, role: 'done', isClosed: true, boardVisible: true },
      {
        id: 'canceled',
        label: 'Canceled',
        order: 7,
        role: 'canceled',
        isClosed: true,
        boardVisible: false,
      },
    ],
    priorities: [
      { id: 'urgent', label: 'Urgent', order: 0 },
      { id: 'high', label: 'High', order: 1 },
      { id: 'medium', label: 'Medium', order: 2 },
      { id: 'low', label: 'Low', order: 3 },
      { id: 'none', label: 'None', order: 4 },
    ],
  };
}

function sortTaxonomyByOrder(items) {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function validateTaxonomyItemList(kind, items) {
  const out = [];
  const seen = new Set();
  const errors = [];

  if (!Array.isArray(items) || !items.length) {
    throw new Error(`${kind} must include at least one item`);
  }

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') {
      errors.push(`Invalid ${kind} entry at index ${i}`);
      continue;
    }
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : i;
    if (!id || !TAXONOMY_SLUG_RE.test(id)) {
      errors.push(`Id must match [a-z][a-z0-9_]* (got "${id || '(empty)'}")`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`Duplicate id "${id}"`);
      continue;
    }
    if (!label) {
      errors.push(`Label is required for "${id}"`);
      continue;
    }
    seen.add(id);
    const item = { id, label, order };
    if (typeof raw.color === 'string' && raw.color.trim()) {
      const color = raw.color.trim();
      if (!isTaxonomyColor(color)) {
        errors.push(`Unknown ${kind.slice(0, -1)} color "${color}"`);
      } else {
        item.color = color;
      }
    }
    if (kind === 'statuses') {
      if (typeof raw.role === 'string' && raw.role.trim()) {
        const role = raw.role.trim();
        if (!ISSUE_STATUS_ROLES.has(role)) {
          errors.push(`Unknown role "${role}" on status "${id}"`);
        } else {
          item.role = role;
        }
      }
      if (raw.isClosed === true) item.isClosed = true;
      if (raw.boardVisible === true) item.boardVisible = true;
      if (raw.boardVisible === false) item.boardVisible = false;
    }
    out.push(item);
  }

  if (errors.length) throw new Error(errors.join('; '));
  return sortTaxonomyByOrder(out);
}

function collectRemovedTaxonomyIds(previous, next) {
  const removed = { type: [], status: [], priority: [] };
  const prevType = new Set(previous.types.map((t) => t.id));
  const nextType = new Set(next.types.map((t) => t.id));
  const prevStatus = new Set(previous.statuses.map((s) => s.id));
  const nextStatus = new Set(next.statuses.map((s) => s.id));
  const prevPriority = new Set(previous.priorities.map((p) => p.id));
  const nextPriority = new Set(next.priorities.map((p) => p.id));
  for (const id of prevType) if (!nextType.has(id)) removed.type.push(id);
  for (const id of prevStatus) if (!nextStatus.has(id)) removed.status.push(id);
  for (const id of prevPriority) if (!nextPriority.has(id)) removed.priority.push(id);
  return removed;
}

/**
 * @param {unknown} raw
 * @param {{ previous?: object; issues?: Array<{ type: string; status: string; priority: string }> }} [options]
 */
export function validateIssuesTaxonomy(raw, options = {}) {
  if (!raw || typeof raw !== 'object') {
    return defaultIssuesTaxonomy();
  }
  const row = /** @type {Record<string, unknown>} */ (raw);
  if (row.version !== 1) {
    throw new Error('version must be 1');
  }

  const types = validateTaxonomyItemList('types', row.types);
  const statuses = validateTaxonomyItemList('statuses', row.statuses);
  const priorities = validateTaxonomyItemList('priorities', row.priorities);

  const roleSeen = new Map();
  for (const status of statuses) {
    if (!status.role) continue;
    const prior = roleSeen.get(status.role);
    if (prior) {
      throw new Error(`Role "${status.role}" is already assigned to "${prior}"`);
    }
    roleSeen.set(status.role, status.id);
  }

  const next = { version: 1, types, statuses, priorities };
  const seedRev = row.typeSeedRevision;
  if (typeof seedRev === 'number' && Number.isFinite(seedRev) && seedRev >= 1) {
    next.typeSeedRevision = Math.floor(seedRev);
  }
  if (options.previous && Array.isArray(options.issues)) {
    const removed = collectRemovedTaxonomyIds(options.previous, next);
    for (const id of removed.type) {
      const count = options.issues.filter((i) => i.type === id).length;
      if (count > 0) {
        throw new Error(`Used by ${count} issue${count === 1 ? '' : 's'} — reassign first`);
      }
    }
    for (const id of removed.status) {
      const count = options.issues.filter((i) => i.status === id).length;
      if (count > 0) {
        throw new Error(`Used by ${count} issue${count === 1 ? '' : 's'} — reassign first`);
      }
    }
    for (const id of removed.priority) {
      const count = options.issues.filter((i) => i.priority === id).length;
      if (count > 0) {
        throw new Error(`Used by ${count} issue${count === 1 ? '' : 's'} — reassign first`);
      }
    }
  }

  return next;
}

/** Append Feature / Improvement once for catalogs that predate those built-in types. */
export function seedDefaultIssueTypes(taxonomy) {
  const revision = typeof taxonomy?.typeSeedRevision === 'number' ? taxonomy.typeSeedRevision : 1;
  if (revision >= ISSUE_TYPE_SEED_REVISION) {
    if (taxonomy.typeSeedRevision) return taxonomy;
    return { ...taxonomy, typeSeedRevision: revision };
  }
  const defaults = defaultIssuesTaxonomy();
  const nextTypes = [...taxonomy.types];
  const seen = new Set(nextTypes.map((row) => row.id));
  let order = nextTypes.reduce((max, row) => Math.max(max, row.order), -1);
  for (const seed of defaults.types) {
    if (seen.has(seed.id)) continue;
    if (seed.id !== 'feature' && seed.id !== 'improvement') continue;
    order += 1;
    nextTypes.push({ ...seed, order });
    seen.add(seed.id);
  }
  return {
    ...taxonomy,
    typeSeedRevision: ISSUE_TYPE_SEED_REVISION,
    types: sortTaxonomyByOrder(nextTypes),
  };
}

export const ISSUES_COMPAT_VERSION = 2;

export const ISSUES_SCHEMA_VERSION = 3;

/**
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
export function issuesSchemaRevisionOf(row) {
  const explicit = row.schemaRevision;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const legacy = row.version;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 1) {
    return Math.floor(legacy);
  }
  return ISSUES_SCHEMA_VERSION;
}

const NORMALIZED_ISSUE_CARD_KEYS = new Set([
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
  'notes',
  'planPath',
  'boardChatId',
  'investigateRunId',
  'planRunId',
  'legacyBugId',
  'severity',
  'chatIds',
  'codeRefs',
  'gitLinks',
  'assignee',
  'agent',
  'parentId',
  'rank',
  'projectId',
  'source',
  'triagedAt',
]);

const NORMALIZED_ISSUES_STATE_KEYS = new Set([
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
 * @template {Record<string, unknown>} T
 * @param {Record<string, unknown>} source
 * @param {T} target
 * @param {Set<string>} normalized
 * @returns {T}
 */
function preserveUnknownKeys(source, target, normalized) {
  for (const key of Object.keys(source)) {
    if (normalized.has(key)) continue;
    if (source[key] === undefined) continue;
    target[key] = source[key];
  }
  return target;
}

const ISSUE_AGENT_PHASES = new Set([
  'queued',
  'running',
  'awaiting_input',
  'review',
  'failed',
  'canceled',
  'done',
]);
const ISSUE_SOURCES = new Set(['user', 'agent', 'crash', 'github']);
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

function parseIssueAssignee(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return undefined;
  const assignedAt =
    typeof row.assignedAt === 'number' && Number.isFinite(row.assignedAt) ? row.assignedAt : 0;
  const out = { id, assignedAt };
  if (typeof row.label === 'string' && row.label.trim()) out.label = row.label.trim();
  return preserveUnknownKeys(row, out, NORMALIZED_ASSIGNEE_KEYS);
}

function parseIssueAgent(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const agentId = typeof row.agentId === 'string' ? row.agentId.trim() : '';
  const phase = typeof row.phase === 'string' ? row.phase.trim() : '';
  if (!agentId || !ISSUE_AGENT_PHASES.has(phase)) return undefined;
  const startedAt =
    typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : 0;
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : startedAt;
  const out = { agentId, phase, startedAt, updatedAt };
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

function applyIssueCardV3Fields(out, r) {
  const assignee = parseIssueAssignee(r.assignee);
  if (assignee) out.assignee = assignee;
  const agent = parseIssueAgent(r.agent);
  if (agent) out.agent = agent;
  if (typeof r.parentId === 'string' && r.parentId.trim()) out.parentId = r.parentId.trim();
  if (typeof r.rank === 'string' && r.rank.trim()) out.rank = r.rank.trim();
  if (typeof r.projectId === 'string' && r.projectId.trim()) out.projectId = r.projectId.trim();
  if (typeof r.source === 'string' && ISSUE_SOURCES.has(r.source)) out.source = r.source;
  if (typeof r.triagedAt === 'number' && Number.isFinite(r.triagedAt)) out.triagedAt = r.triagedAt;
}

function parseIssueProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!id || !name) return null;
  const createdAt =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
      ? row.createdAt
      : Date.now();
  const updatedAt =
    typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : createdAt;
  const out = { id, name, createdAt, updatedAt };
  if (typeof row.description === 'string' && row.description.trim()) {
    out.description = row.description.trim();
  }
  if (typeof row.color === 'string' && row.color.trim()) out.color = row.color.trim();
  if (typeof row.archivedAt === 'number' && Number.isFinite(row.archivedAt)) {
    out.archivedAt = row.archivedAt;
  }
  return preserveUnknownKeys(row, out, NORMALIZED_PROJECT_KEYS);
}

function parseIssueSavedView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!id || !name) return null;
  const filters =
    row.filters && typeof row.filters === 'object' && !Array.isArray(row.filters)
      ? row.filters
      : {};
  const order =
    typeof row.order === 'number' && Number.isFinite(row.order) ? Math.floor(row.order) : 0;
  const out = { id, name, filters, order };
  if (typeof row.groupBy === 'string' && row.groupBy.trim()) out.groupBy = row.groupBy.trim();
  if (typeof row.builtIn === 'boolean') out.builtIn = row.builtIn;
  return preserveUnknownKeys(row, out, NORMALIZED_VIEW_KEYS);
}

function parseIssueProjects(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    const project = parseIssueProject(item);
    if (project) out.push(project);
  }
  return out;
}

function parseIssueViews(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    const view = parseIssueSavedView(item);
    if (view) out.push(view);
  }
  return out;
}

const ISSUE_LABEL_SWATCH_IDS = [
  'clay',
  'apricot',
  'pollen',
  'moss',
  'kelp',
  'tide',
  'dusk',
  'fig',
  'blush',
  'pebble',
];

function normalizeIssueLabelName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return trimmed.length > 0 ? trimmed : null;
}

function parseIssueLabelCatalog(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const name = normalizeIssueLabelName(row.name);
    const color = typeof row.color === 'string' ? row.color.trim() : '';
    if (!name || !ISSUE_LABEL_SWATCH_IDS.includes(color)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, color });
  }
  return out;
}

function pickNextLabelSwatch(used) {
  const counts = new Map(ISSUE_LABEL_SWATCH_IDS.map((id) => [id, 0]));
  for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best = ISSUE_LABEL_SWATCH_IDS[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const id of ISSUE_LABEL_SWATCH_IDS) {
    const count = counts.get(id) ?? 0;
    if (count < bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

function mergeIssueLabelCatalog(catalog, names) {
  const byKey = new Map();
  for (const entry of catalog) {
    const key = entry.name.toLowerCase();
    if (byKey.has(key)) continue;
    byKey.set(key, entry);
  }
  const used = [...byKey.values()].map((entry) => entry.color);
  const missing = [];
  const seenMissing = new Set();
  for (const raw of names) {
    const name = normalizeIssueLabelName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (byKey.has(key) || seenMissing.has(key)) continue;
    seenMissing.add(key);
    missing.push(name);
  }
  missing.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const name of missing) {
    const color = pickNextLabelSwatch(used);
    used.push(color);
    byKey.set(name.toLowerCase(), { name, color });
  }
  return [...byKey.values()];
}

function collectIssueLabelNames(issues) {
  const names = [];
  for (const issue of issues) {
    if (!Array.isArray(issue.labels)) continue;
    for (const label of issue.labels) names.push(label);
  }
  return names;
}

function ensureIssueCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!id || !title) return null;
  const typeRaw = typeof r.type === 'string' ? r.type.trim() : 'task';
  const statusRaw = typeof r.status === 'string' ? r.status.trim() : 'triage';
  const priorityRaw = typeof r.priority === 'string' ? r.priority.trim() : 'none';
  if (!typeRaw || !statusRaw || !priorityRaw) return null;
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now();
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : createdAt;
  const labels = Array.isArray(r.labels)
    ? r.labels.filter((l) => typeof l === 'string' && l.trim()).map((l) => String(l).trim())
    : [];
  const out = {
    id,
    type: typeRaw,
    title,
    description: typeof r.description === 'string' ? r.description : '',
    status: statusRaw,
    priority: priorityRaw,
    labels,
    workspacePath:
      typeof r.workspacePath === 'string' ? normalizeWorkspacePath(r.workspacePath) : '',
    createdAt,
    updatedAt,
  };
  if (typeof r.notes === 'string') out.notes = r.notes;
  if (typeof r.planPath === 'string' && r.planPath.trim()) out.planPath = r.planPath.trim();
  if (typeof r.boardChatId === 'string' && r.boardChatId.trim()) {
    out.boardChatId = r.boardChatId.trim();
  }
  if (typeof r.investigateRunId === 'string' && r.investigateRunId.trim()) {
    out.investigateRunId = r.investigateRunId.trim();
  }
  if (typeof r.planRunId === 'string' && r.planRunId.trim()) {
    out.planRunId = r.planRunId.trim();
  }
  if (typeof r.legacyBugId === 'string' && r.legacyBugId.trim()) {
    out.legacyBugId = r.legacyBugId.trim();
  }
  if (
    typeof r.severity === 'string' &&
    BUG_SEVERITIES.has(r.severity)
  ) {
    out.severity = r.severity;
  }
  if (Array.isArray(r.chatIds)) {
    out.chatIds = r.chatIds.filter((c) => typeof c === 'string' && c.trim());
  }
  if (Array.isArray(r.codeRefs)) out.codeRefs = r.codeRefs;
  if (Array.isArray(r.gitLinks)) out.gitLinks = r.gitLinks;
  applyIssueCardV3Fields(out, r);
  return preserveUnknownKeys(r, out, NORMALIZED_ISSUE_CARD_KEYS);
}

export function validateIssuesState(raw) {
  const empty = () => ({
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 1,
    issues: [],
    workspaces: {},
  });
  if (!raw || typeof raw !== 'object') return empty();
  const row = /** @type {Record<string, unknown>} */ (raw);
  if (!Array.isArray(row.issues)) return empty();
  const readRevision = issuesSchemaRevisionOf(row);
  const issues = [];
  for (const item of row.issues) {
    const card = ensureIssueCard(item);
    if (card) issues.push(card);
  }
  let nextId =
    typeof row.nextId === 'number' && Number.isFinite(row.nextId) && row.nextId >= 1
      ? Math.floor(row.nextId)
      : 1;
  for (const issue of issues) {
    const m = /^ISS-(\d+)$/i.exec(issue.id);
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
  }

  const workspaces = {};
  if (row.workspaces && typeof row.workspaces === 'object') {
    for (const [pathKey, cfgRaw] of Object.entries(
      /** @type {Record<string, unknown>} */ (row.workspaces),
    )) {
      if (!cfgRaw || typeof cfgRaw !== 'object') continue;
      const cfg = /** @type {Record<string, unknown>} */ (cfgRaw);
      const projectKey =
        typeof cfg.projectKey === 'string'
          ? cfg.projectKey.toUpperCase().replace(/[^A-Z0-9]/g, '')
          : '';
      if (!/^[A-Z0-9]{2,10}$/.test(projectKey)) continue;
      let wsNext =
        typeof cfg.nextId === 'number' && Number.isFinite(cfg.nextId) && cfg.nextId >= 1
          ? Math.floor(cfg.nextId)
          : 1;
      const wsKey = String(pathKey).replace(/\\/g, '/').replace(/\/+$/, '') || pathKey;
      for (const issue of issues) {
        const issueWs = String(issue.workspacePath ?? '')
          .replace(/\\/g, '/')
          .replace(/\/+$/, '');
        if (issueWs !== wsKey) continue;
        const keyed = /^([A-Z0-9]+)-(\d+)$/i.exec(issue.id);
        if (keyed && keyed[1].toUpperCase() === projectKey) {
          wsNext = Math.max(wsNext, Number(keyed[2]) + 1);
        }
      }
      workspaces[wsKey] = { projectKey, nextId: wsNext };
    }
  }

  const projects = parseIssueProjects(row.projects);
  const views = parseIssueViews(row.views);
  const labelCatalog = mergeIssueLabelCatalog(
    parseIssueLabelCatalog(row.labelCatalog),
    collectIssueLabelNames(issues),
  );
  const state = {
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: Math.max(readRevision, ISSUES_SCHEMA_VERSION),
    nextId,
    issues,
    workspaces,
    labelCatalog,
  };
  if (projects) state.projects = projects;
  if (views) state.views = views;
  return preserveUnknownKeys(row, state, NORMALIZED_ISSUES_STATE_KEYS);
}

export function validateSessionState(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid session state');
  }

  const parsed = /** @type {Record<string, unknown>} */ (raw);
  const version = parsed.version;
  if (
    version !== 1 &&
    version !== 2 &&
    version !== 3 &&
    version !== 4 &&
    version !== 5 &&
    version !== 6
  ) {
    throw new Error('Invalid session version');
  }

  if (!Array.isArray(parsed.chats)) {
    throw new Error('Invalid session state');
  }

  const chats = parsed.chats.map(normalizeChatRow).filter(Boolean);
  const groups = Array.isArray(parsed.groups)
    ? parsed.groups.map(normalizeGroupRow).filter(Boolean)
    : [];
  const scalars = normalizeSessionScalars(parsed, { mode: 'full' });

  const state = {
    ...scalars,
    groups,
    chats: chats.length ? chats : [normalizeChatRow(null)],
  };

  if (!state.chats.some((c) => c.id === state.activeId)) {
    state.activeId = state.chats[0].id;
  }

  if (!state.chats.length) {
    throw new Error('Session must have at least one chat');
  }

  if (version < SESSION_SCHEMA_VERSION) {
    for (const chat of state.chats) {
      migrateChatRowV5ToV6(chat);
    }
  }

  return state;
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
/** @param {unknown} value */
function isToolPermissionMode(value) {
  return value === 'full' || value === 'ask' || value === 'off';
}

/** @param {unknown} permissions */
function isLegacyFlatPermissions(permissions) {
  if (!permissions || typeof permissions !== 'object') return false;
  const obj = /** @type {Record<string, unknown>} */ (permissions);
  if (obj.default && typeof obj.default === 'object' && !Array.isArray(obj.default)) {
    return false;
  }
  for (const value of Object.values(obj)) {
    if (isToolPermissionMode(value)) return true;
  }
  return false;
}

/**
 * @param {unknown} stored
 * @param {Record<string, string>} seedDefault
 */
function normalizePermissionsFromStored(stored, seedDefault) {
  if (!stored || typeof stored !== 'object') {
    return { default: { ...seedDefault } };
  }

  if (isLegacyFlatPermissions(stored)) {
    const merged = { ...seedDefault };
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (stored))) {
      if (!id || !isToolPermissionMode(value)) continue;
      merged[id] = value;
    }
    return { default: merged };
  }

  const obj = /** @type {Record<string, unknown>} */ (stored);
  const merged = { ...seedDefault };
  if (obj.default && typeof obj.default === 'object') {
    for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (obj.default))) {
      if (!id || !isToolPermissionMode(value)) continue;
      merged[id] = value;
    }
  }

  return { default: merged };
}

function toolIdWasStored(raw, id) {
  if (!raw || typeof raw !== 'object') return false;
  const stored = /** @type {Record<string, unknown>} */ (raw);
  if (stored.enabled && typeof stored.enabled === 'object') {
    if (Object.prototype.hasOwnProperty.call(stored.enabled, id)) return true;
  }
  if (stored.permissions && typeof stored.permissions === 'object') {
    if (isLegacyFlatPermissions(stored.permissions)) {
      if (Object.prototype.hasOwnProperty.call(stored.permissions, id)) return true;
    } else {
      const def = /** @type {Record<string, unknown>} */ (stored.permissions).default;
      if (def && typeof def === 'object' && Object.prototype.hasOwnProperty.call(def, id)) {
        return true;
      }
    }
  }
  return false;
}

function backfillBrainTools(config, raw) {
  for (const id of BRAIN_FULL_PERMISSION_TOOL_IDS) {
    if (!toolIdWasStored(raw, id)) {
      config.permissions.default[id] = 'full';
      config.enabled[id] = true;
    }
  }
  for (const id of ARCHIVE_RECALL_TOOL_IDS) {
    if (!toolIdWasStored(raw, id)) {
      config.permissions.default[id] = 'ask';
      config.enabled[id] = true;
    }
  }
  for (const id of BRAIN_DESTRUCTIVE_TOOL_IDS) {
    if (!toolIdWasStored(raw, id)) {
      config.permissions.default[id] = 'ask';
      config.enabled[id] = true;
    }
  }
}

export function normalizeArchiveConfig(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const out = {};
  const staleness = Number(row.stalenessTurns);
  if (Number.isFinite(staleness)) {
    out.stalenessTurns = Math.min(200, Math.max(1, Math.floor(staleness)));
  }
  const pressure = Number(row.pressureThreshold);
  if (Number.isFinite(pressure)) {
    out.pressureThreshold = Math.min(0.99, Math.max(0.1, pressure));
  }
  const minRecent = Number(row.minRecentTurns);
  if (Number.isFinite(minRecent)) {
    out.minRecentTurns = Math.min(50, Math.max(1, Math.floor(minRecent)));
  }
  const topK = Number(row.retrievalTopK);
  if (Number.isFinite(topK)) {
    out.retrievalTopK = Math.min(20, Math.max(1, Math.floor(topK)));
  }
  if (typeof row.embeddingModelId === 'string' && row.embeddingModelId.trim()) {
    out.embeddingModelId = row.embeddingModelId.trim().slice(0, 128);
  }
  if (typeof row.llmRerank === 'boolean') {
    out.llmRerank = row.llmRerank;
  }
  return Object.keys(out).length ? out : undefined;
}

function defaultPermissionForTool(id, enabled) {
  if (
    id === 'search_settings'
    || id === 'get_settings'
    || id === 'get_appearance'
    || MINNOW_DOCS_TOOL_IDS.includes(id)
  ) {
    return enabled ? 'full' : 'off';
  }
  if (BRAIN_FULL_PERMISSION_TOOL_ID_SET.has(id)) {
    return enabled ? 'full' : 'off';
  }
  return enabled ? 'ask' : 'off';
}

export function normalizeToolConfig(raw) {
  const DEFAULT_ENABLED_TOOL_IDS = new Set([
    'get_datetime',
    'calculate',
    'web_search',
    'wikipedia_search',
    'save_memory',
    'ask_question',
    'brain_search',
    'brain_read_page',
    'brain_list',
    ...MINNOW_DOCS_TOOL_IDS,
    'brain_write_page',
    'brain_append_log',
    'brain_ingest_source',
    'manage_brain',
    'search_settings',
    'get_settings',
    'update_settings',
    'get_appearance',
    'update_appearance',
    'upload_appearance_asset',
    'repo_map',
    'find_symbol',
    'who_calls',
    'read_symbol',
  ]);
  const enabled = {};
  const permissionsDefault = {};
  for (const id of ALL_TOOL_IDS) {
    const on = DEFAULT_ENABLED_TOOL_IDS.has(id);
    enabled[id] = on;
    permissionsDefault[id] = defaultPermissionForTool(id, on);
  }

  const config = {
    enabled,
    permissions: { default: permissionsDefault },
    keys: { braveApiKey: '', tavilyApiKey: '' },
    webSearchProvider: 'duckduckgo',
    toolCache: { enabled: true },
    plugins: {},
    toolOutput: normalizeToolOutputConfig(undefined),
    lazyTools: true,
  };

  if (!raw || typeof raw !== 'object') return config;

  const stored = /** @type {Record<string, unknown>} */ (raw);
  if (stored.enabled && typeof stored.enabled === 'object') {
    const enabledMap = /** @type {Record<string, unknown>} */ (stored.enabled);
    for (const id of ALL_TOOL_IDS) {
      if (typeof enabledMap[id] === 'boolean') {
        config.enabled[id] = enabledMap[id];
      }
    }
  }

  let hadPermissionsInFile = false;
  if (stored.permissions && typeof stored.permissions === 'object') {
    hadPermissionsInFile =
      isLegacyFlatPermissions(stored.permissions) ||
      (typeof /** @type {Record<string, unknown>} */ (stored.permissions).default === 'object' &&
        /** @type {Record<string, unknown>} */ (stored.permissions).default !== null);
    config.permissions = normalizePermissionsFromStored(
      stored.permissions,
      config.permissions.default,
    );
  }

  if (!hadPermissionsInFile) {
    for (const id of ALL_TOOL_IDS) {
      config.permissions.default[id] = defaultPermissionForTool(id, config.enabled[id] === true);
    }
  } else {
    for (const id of ALL_TOOL_IDS) {
      const v = config.permissions.default[id];
      if (!isToolPermissionMode(v)) {
        config.permissions.default[id] = defaultPermissionForTool(id, config.enabled[id] === true);
      }
    }
  }

  backfillBrainTools(config, raw);

  for (const id of ALL_TOOL_IDS) {
    const mode = config.permissions.default[id];
    config.enabled[id] = mode !== 'off';
  }

  if (stored.keys && typeof stored.keys === 'object') {
    const keysMap = /** @type {Record<string, unknown>} */ (stored.keys);
    if (typeof keysMap.braveApiKey === 'string') {
      config.keys.braveApiKey = keysMap.braveApiKey;
    }
    if (typeof keysMap.tavilyApiKey === 'string') {
      config.keys.tavilyApiKey = keysMap.tavilyApiKey;
    }
  }

  if (
    stored.webSearchProvider === 'brave' ||
    stored.webSearchProvider === 'tavily' ||
    stored.webSearchProvider === 'duckduckgo'
  ) {
    config.webSearchProvider = stored.webSearchProvider;
  }

  if (stored.toolCache && typeof stored.toolCache === 'object') {
    const cacheMap = /** @type {Record<string, unknown>} */ (stored.toolCache);
    if (typeof cacheMap.enabled === 'boolean') {
      config.toolCache = { enabled: cacheMap.enabled };
    }
  }
  if (!config.toolCache) {
    config.toolCache = { enabled: true };
  }

  config.toolOutput = normalizeToolOutputConfig(stored.toolOutput);
  config.lazyTools = stored.lazyTools !== false;

  if (stored.plugins && typeof stored.plugins === 'object') {
    const pluginsMap = /** @type {Record<string, unknown>} */ (stored.plugins);
    for (const [pluginId, meta] of Object.entries(pluginsMap)) {
      if (!pluginId.trim() || typeof meta !== 'object' || meta === null) continue;
      const row = /** @type {Record<string, unknown>} */ (meta);
      config.plugins[pluginId.trim()] = {
        enabled: row.enabled !== false,
      };
    }
  }

  return config;
}

/**
 * @param {unknown} raw
 * @returns {{ enabled: Record<string, boolean> }}
 */
export function normalizeSkillConfig(raw) {
  const config = { enabled: {} };

  if (!raw || typeof raw !== 'object') return config;

  const stored = /** @type {Record<string, unknown>} */ (raw);
  if (!stored.enabled || typeof stored.enabled !== 'object') return config;

  const enabledMap = /** @type {Record<string, unknown>} */ (stored.enabled);
  for (const [id, value] of Object.entries(enabledMap)) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    if (typeof value === 'boolean') {
      config.enabled[id] = value;
    }
  }

  return config;
}

/**
 * @param {unknown} raw
 * @returns {{ presetId: string, text: string }}
 */
export function validateSystemPromptSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid system prompt settings');
  }

  const parsed = /** @type {Record<string, unknown>} */ (raw);
  return {
    presetId: typeof parsed.presetId === 'string' ? parsed.presetId : '',
    text: typeof parsed.text === 'string' ? parsed.text : '',
  };
}

const MAX_USER_RULES_BYTES = 16 * 1024;
const DEFAULT_USER_RULES_GROUP_ID = 'general';

/**
 * @param {unknown} raw
 * @returns {{ version: 2, enabled: boolean, groups: Array<{ id: string, name: string }>, rules: Array<{ id: string, title: string, text: string, enabled: boolean, groupId: string }> }}
 */
export function validateUserRulesSettings(raw) {
  if (!raw || typeof raw !== 'object') {
    const err = new Error('Invalid user rules settings');
    err.statusCode = 400;
    throw err;
  }

  const parsed = /** @type {Record<string, unknown>} */ (raw);
  if (parsed.version !== 2 || !Array.isArray(parsed.groups) || !Array.isArray(parsed.rules)) {
    return validateUserRulesSettings(migrateLegacyUserRulesSettings(parsed));
  }

  const enabled = parsed.enabled === true;
  /** @type {Array<{ id: string, name: string }>} */
  let groups = parsed.groups
    .map((group, index) => normalizeUserRuleGroupRow(group, index))
    .filter(Boolean);

  if (!groups.length) {
    groups = [{ id: DEFAULT_USER_RULES_GROUP_ID, name: 'General' }];
  }

  /** @type {Array<{ id: string, title: string, text: string, enabled: boolean, groupId: string }>} */
  const rules = parsed.rules
    .map((rule, index) => normalizeUserRuleItemRow(rule, groups, index))
    .filter(Boolean);

  const bytes = Buffer.byteLength(rules.map((rule) => rule.text).join('\n'), 'utf8');
  if (bytes > MAX_USER_RULES_BYTES) {
    const err = new Error(`User rules text exceeds ${MAX_USER_RULES_BYTES} bytes`);
    err.statusCode = 413;
    throw err;
  }

  return { version: 2, enabled, groups, rules };
}

/**
 * @param {Record<string, unknown>} parsed
 */
function migrateLegacyUserRulesSettings(parsed) {
  const enabled = parsed.enabled === true;
  const legacyText = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const groups = [{ id: DEFAULT_USER_RULES_GROUP_ID, name: 'General' }];
  /** @type {Array<{ id: string, title: string, text: string, enabled: boolean, groupId: string }>} */
  const rules = [];

  if (legacyText) {
    rules.push({
      id: crypto.randomUUID(),
      title: 'Imported rule',
      text: legacyText,
      enabled: true,
      groupId: DEFAULT_USER_RULES_GROUP_ID,
    });
  }

  return { version: 2, enabled, groups, rules };
}

/**
 * @param {unknown} raw
 * @param {number} index
 */
function normalizeUserRuleGroupRow(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `group-${index}`;
  const name =
    typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Untitled group';
  return { id, name };
}

/**
 * @param {unknown} raw
 * @param {Array<{ id: string, name: string }>} groups
 * @param {number} index
 */
function normalizeUserRuleItemRow(raw, groups, index) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const fallbackGroupId = groups[0]?.id ?? DEFAULT_USER_RULES_GROUP_ID;
  const groupId =
    typeof row.groupId === 'string' && groups.some((group) => group.id === row.groupId)
      ? row.groupId
      : fallbackGroupId;
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `rule-${index}`;
  const title = typeof row.title === 'string' ? row.title : 'Untitled rule';
  const text = typeof row.text === 'string' ? row.text : '';
  const enabled = row.enabled !== false;
  return { id, title, text, enabled, groupId };
}

const SUPERVISOR_DEFAULTS = {
  enabled: true,
  autoResume: true,
  repetitionDetection: true,
  llmEscalation: true,
  askUserOnBudgetExhausted: true,
  stallMs: 30_000,
  maxRetriesPerTask: 3,
  orchestratorHeartbeatMs: 90_000,
  inProgressNoRunMs: 45_000,
  spawnStuckMs: 30_000,
  parentSilenceAfterToolMs: 20_000,
  subAgentToolSilenceMs: 60_000,
  runRestartCap: 2,
  spawnCapPerTask: 3,
  llmEscalationsPerSession: 10,
  llmEscalationTimeoutMs: 8_000,
  tickIntervalMs: 5_000,
  repetition: {
    duplicateToolCallThreshold: 5,
    sameErrorThreshold: 3,
    maxRestartsPerRun: 2,
  },
  escalationProviderId: '',
  escalationModelId: '',
};

/**
 * @param {Record<string, unknown>} patch
 * @param {Record<string, unknown>} base
 * @returns {object}
 */
export function mergeSupervisorConfig(patch, base) {
  const out = {
    ...SUPERVISOR_DEFAULTS,
    ...(base && typeof base === 'object' ? base : {}),
    repetition: {
      ...SUPERVISOR_DEFAULTS.repetition,
      ...(base?.repetition && typeof base.repetition === 'object' ? base.repetition : {}),
    },
  };
  if (!patch || typeof patch !== 'object') return out;
  const p = /** @type {Record<string, unknown>} */ (patch);

  if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
  if (typeof p.autoResume === 'boolean') out.autoResume = p.autoResume;
  if (typeof p.repetitionDetection === 'boolean') out.repetitionDetection = p.repetitionDetection;
  if (typeof p.llmEscalation === 'boolean') out.llmEscalation = p.llmEscalation;
  if (typeof p.askUserOnBudgetExhausted === 'boolean') {
    out.askUserOnBudgetExhausted = p.askUserOnBudgetExhausted;
  }
  if (typeof p.stallMs === 'number' && Number.isFinite(p.stallMs)) {
    out.stallMs = Math.min(600_000, Math.max(5_000, Math.round(p.stallMs)));
  }
  if (typeof p.maxRetriesPerTask === 'number' && Number.isFinite(p.maxRetriesPerTask)) {
    out.maxRetriesPerTask = Math.min(10, Math.max(0, Math.round(p.maxRetriesPerTask)));
  }
  if (typeof p.orchestratorHeartbeatMs === 'number' && Number.isFinite(p.orchestratorHeartbeatMs)) {
    out.orchestratorHeartbeatMs = Math.min(600_000, Math.max(10_000, Math.round(p.orchestratorHeartbeatMs)));
  }
  if (typeof p.inProgressNoRunMs === 'number' && Number.isFinite(p.inProgressNoRunMs)) {
    out.inProgressNoRunMs = Math.min(300_000, Math.max(10_000, Math.round(p.inProgressNoRunMs)));
  }
  if (typeof p.spawnStuckMs === 'number' && Number.isFinite(p.spawnStuckMs)) {
    out.spawnStuckMs = Math.min(120_000, Math.max(5_000, Math.round(p.spawnStuckMs)));
  }
  if (typeof p.parentSilenceAfterToolMs === 'number' && Number.isFinite(p.parentSilenceAfterToolMs)) {
    out.parentSilenceAfterToolMs = Math.min(120_000, Math.max(5_000, Math.round(p.parentSilenceAfterToolMs)));
  }
  if (typeof p.subAgentToolSilenceMs === 'number' && Number.isFinite(p.subAgentToolSilenceMs)) {
    out.subAgentToolSilenceMs = Math.min(300_000, Math.max(10_000, Math.round(p.subAgentToolSilenceMs)));
  }
  if (typeof p.runRestartCap === 'number' && Number.isFinite(p.runRestartCap)) {
    out.runRestartCap = Math.min(20, Math.max(0, Math.round(p.runRestartCap)));
  }
  if (typeof p.spawnCapPerTask === 'number' && Number.isFinite(p.spawnCapPerTask)) {
    out.spawnCapPerTask = Math.min(20, Math.max(0, Math.round(p.spawnCapPerTask)));
  }
  if (typeof p.llmEscalationsPerSession === 'number' && Number.isFinite(p.llmEscalationsPerSession)) {
    out.llmEscalationsPerSession = Math.min(50, Math.max(0, Math.round(p.llmEscalationsPerSession)));
  }
  if (typeof p.llmEscalationTimeoutMs === 'number' && Number.isFinite(p.llmEscalationTimeoutMs)) {
    out.llmEscalationTimeoutMs = Math.min(60_000, Math.max(1_000, Math.round(p.llmEscalationTimeoutMs)));
  }
  if (typeof p.tickIntervalMs === 'number' && Number.isFinite(p.tickIntervalMs)) {
    out.tickIntervalMs = Math.min(60_000, Math.max(1_000, Math.round(p.tickIntervalMs)));
  }
  if (typeof p.escalationProviderId === 'string') out.escalationProviderId = p.escalationProviderId.trim();
  if (typeof p.escalationModelId === 'string') out.escalationModelId = p.escalationModelId.trim();

  const rep = p.repetition;
  if (rep && typeof rep === 'object') {
    const r = /** @type {Record<string, unknown>} */ (rep);
    if (typeof r.duplicateToolCallThreshold === 'number' && Number.isFinite(r.duplicateToolCallThreshold)) {
      const rounded = Math.round(r.duplicateToolCallThreshold);
      out.repetition.duplicateToolCallThreshold =
        rounded <= 0 ? 0 : Math.min(256, rounded);
    }
    if (typeof r.sameErrorThreshold === 'number' && Number.isFinite(r.sameErrorThreshold)) {
      out.repetition.sameErrorThreshold = Math.min(10, Math.max(2, Math.round(r.sameErrorThreshold)));
    }
    if (typeof r.maxRestartsPerRun === 'number' && Number.isFinite(r.maxRestartsPerRun)) {
      out.repetition.maxRestartsPerRun = Math.min(10, Math.max(0, Math.round(r.maxRestartsPerRun)));
    }
  }

  return out;
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [existing]
 * @returns {object}
 */
export function normalizeSuperPlanConfig(raw, existing = {}) {
  const base = {
    reviewRounds: 2,
    grillQuestionBudget: 20,
    impeccable: 'auto',
    researchScope: 'both',
    researchMaxRounds: 0,
    researchDepth: 'auto',
    models: {
      research: { providerId: '', modelId: '' },
      reviewer: { providerId: '', modelId: '' },
      planner: { providerId: '', modelId: '' },
    },
    ...(existing && typeof existing === 'object' ? existing : {}),
    models: {
      research: { providerId: '', modelId: '' },
      reviewer: { providerId: '', modelId: '' },
      planner: { providerId: '', modelId: '' },
      ...(existing?.models && typeof existing.models === 'object'
        ? /** @type {Record<string, unknown>} */ (existing.models)
        : {}),
    },
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const patch = /** @type {Record<string, unknown>} */ (raw);
  if (typeof patch.reviewRounds === 'number' && Number.isFinite(patch.reviewRounds)) {
    base.reviewRounds = Math.min(4, Math.max(0, Math.round(patch.reviewRounds)));
  }
  if (typeof patch.grillQuestionBudget === 'number' && Number.isFinite(patch.grillQuestionBudget)) {
    base.grillQuestionBudget = Math.min(40, Math.max(5, Math.round(patch.grillQuestionBudget)));
  }
  if (patch.impeccable === 'auto' || patch.impeccable === 'always' || patch.impeccable === 'never') {
    base.impeccable = patch.impeccable;
  }
  if (
    patch.researchScope === 'web' ||
    patch.researchScope === 'codebase' ||
    patch.researchScope === 'both'
  ) {
    base.researchScope = patch.researchScope;
  }
  if (typeof patch.researchMaxRounds === 'number' && Number.isFinite(patch.researchMaxRounds)) {
    base.researchMaxRounds = Math.min(8, Math.max(0, Math.round(patch.researchMaxRounds)));
  }
  if (
    patch.researchDepth === 'auto' ||
    patch.researchDepth === 'quick' ||
    patch.researchDepth === 'standard' ||
    patch.researchDepth === 'deep'
  ) {
    base.researchDepth = patch.researchDepth;
  }

  const modelPatch =
    patch.models && typeof patch.models === 'object'
      ? /** @type {Record<string, unknown>} */ (patch.models)
      : {};
  for (const key of ['research', 'reviewer', 'planner']) {
    const row = modelPatch[key];
    if (!row || typeof row !== 'object') continue;
    const m = /** @type {Record<string, unknown>} */ (row);
    if (typeof m.providerId === 'string') {
      base.models[key].providerId = m.providerId;
    }
    if (typeof m.modelId === 'string') {
      base.models[key].modelId = m.modelId;
    }
  }

  return base;
}

/**
 * @param {object} existing
 * @param {unknown} patch
 * @returns {object}
 */
export function mergeConfigMeta(existing, patch) {
  const base =
    existing && typeof existing === 'object'
      ? { ...existing }
      : {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          migratedFromLocalStorage: false,
          migratedAt: null,
          localStorageKeysMigrated: [],
          layoutVersion: 1,
        };

  if (!patch || typeof patch !== 'object') return base;

  const p = /** @type {Record<string, unknown>} */ (patch);

  if (typeof p.migratedFromLocalStorage === 'boolean') {
    base.migratedFromLocalStorage = p.migratedFromLocalStorage;
  }
  if (p.migratedAt === null || typeof p.migratedAt === 'string') {
    base.migratedAt = p.migratedAt;
  }
  if (Array.isArray(p.localStorageKeysMigrated)) {
    base.localStorageKeysMigrated = p.localStorageKeysMigrated.filter(
      (k) => typeof k === 'string',
    );
  }
  if (typeof p.layoutVersion === 'number') {
    base.layoutVersion = p.layoutVersion;
  }
  if (typeof p.schemaVersion === 'number') {
    base.schemaVersion = p.schemaVersion;
  }

  if (p.titles && typeof p.titles === 'object') {
    const existingTitles =
      base.titles && typeof base.titles === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.titles) }
        : {
            enabled: true,
            modelId: '',
            providerId: '',
            maxTokens: 24,
            temperature: 0.3,
          };
    const t = /** @type {Record<string, unknown>} */ (p.titles);
    if (typeof t.enabled === 'boolean') existingTitles.enabled = t.enabled;
    if (typeof t.modelId === 'string') existingTitles.modelId = t.modelId;
    if (typeof t.providerId === 'string') existingTitles.providerId = t.providerId;
    if (typeof t.maxTokens === 'number' && Number.isFinite(t.maxTokens)) {
      existingTitles.maxTokens = Math.min(32, Math.max(16, Math.round(t.maxTokens)));
    }
    if (typeof t.temperature === 'number' && Number.isFinite(t.temperature)) {
      existingTitles.temperature = Math.min(0.4, Math.max(0.2, t.temperature));
    }
    base.titles = existingTitles;
  }

  if (p.thinking && typeof p.thinking === 'object') {
    const existingThinking =
      base.thinking && typeof base.thinking === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.thinking) }
        : { defaultMode: 'on' };
    const t = /** @type {Record<string, unknown>} */ (p.thinking);
    const mode = normalizeThinkingGlobalDefault(t.defaultMode);
    if (mode) existingThinking.defaultMode = mode;
    if (t.thinkingBudgetTokens !== undefined) {
      if (t.thinkingBudgetTokens === null) {
        existingThinking.thinkingBudgetTokens = null;
      } else {
        const budget = clampThinkingBudgetTokens(t.thinkingBudgetTokens);
        if (budget === null) delete existingThinking.thinkingBudgetTokens;
        else existingThinking.thinkingBudgetTokens = budget;
      }
    }
    base.thinking = existingThinking;
  }

  if (p.sampler !== undefined) {
    if (p.sampler === null) {
      base.sampler = {
        temperature: 0.7,
        maxTokens: 32768,
      };
    } else if (typeof p.sampler === 'object') {
      const normalized = normalizeSamplerPreset(p.sampler);
      const existingSampler =
        base.sampler && typeof base.sampler === 'object'
          ? { .../** @type {Record<string, number>} */ (base.sampler) }
          : { temperature: 0.7, maxTokens: 32768 };
      if (normalized) {
        if (normalized.temperature !== undefined) {
          existingSampler.temperature = normalized.temperature;
        }
        if (normalized.topP !== undefined) existingSampler.topP = normalized.topP;
        if (normalized.topK !== undefined) existingSampler.topK = normalized.topK;
        if (normalized.minP !== undefined) existingSampler.minP = normalized.minP;
        if (normalized.repetitionPenalty !== undefined) {
          existingSampler.repetitionPenalty = normalized.repetitionPenalty;
        }
        if (normalized.presencePenalty !== undefined) {
          existingSampler.presencePenalty = normalized.presencePenalty;
        }
        if (normalized.maxTokens !== undefined) {
          existingSampler.maxTokens = normalized.maxTokens;
        }
      }
      const s = /** @type {Record<string, unknown>} */ (p.sampler);
      if (typeof s.maxTokens === 'number' && Number.isFinite(s.maxTokens)) {
        const mt = Math.min(131072, Math.max(1, Math.floor(s.maxTokens)));
        existingSampler.maxTokens = mt;
      }
      base.sampler = existingSampler;
    }
  }

  if (p.autopilot !== undefined) {
    const AUTOPILOT_ISOLATION_MODES = new Set([
      'auto',
      'off',
      'per-board',
      'per-task',
      'per-wave',
    ]);
    const AUTOPILOT_SHELL_SANDBOX_MODES = new Set(['off', 'prefer', 'require']);
    const clampAutopilotConcurrency = (value, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      return Math.min(20, Math.max(1, Math.round(value)));
    };
    const clampAutopilotAttempts = (value, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      return Math.min(10, Math.max(1, Math.round(value)));
    };

    const clampSelfHealRounds = (value, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      return Math.min(6, Math.max(0, Math.round(value)));
    };
    const clampInfraTimeoutMs = (value, fallback) => {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(600_000, Math.max(30_000, Math.round(n)));
    };
    const parseBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
    const AUTOPILOT_DEFAULTS = {
      defaultStatus: 'stopped',
      maxConcurrentTasks: 3,
      isolationMode: 'auto',
      shellSandbox: 'off',
      maxTestAttempts: 3,
      maxBuildAttempts: 2,
      maxFinalTestAttempts: 3,
      continueSmartRoute: 'conservative',
      plannerProviderId: '',
      plannerModelId: '',
      selfHealMaxRounds: 2,
      autoProvisionInfra: true,
      infraProvisionTimeoutMs: 180000,
      afkAutoRestartStalls: true,
      guardCdOutsideWorktree: true,
    };

    if (p.autopilot === null) {
      base.autopilot = { ...AUTOPILOT_DEFAULTS };
    } else if (typeof p.autopilot === 'object') {
      const existingAutopilot =
        base.autopilot && typeof base.autopilot === 'object'
          ? { .../** @type {Record<string, unknown>} */ (base.autopilot) }
          : { ...AUTOPILOT_DEFAULTS };
      const a = /** @type {Record<string, unknown>} */ (p.autopilot);
      if (typeof a.defaultStatus === 'string') {
        const status = a.defaultStatus.trim();
        if (status === 'running' || status === 'stopped') {
          existingAutopilot.defaultStatus = status;
        }
      }
      existingAutopilot.defaultStatus = foldAutopilotDefaultStatus({
        ...existingAutopilot,
        ...(typeof a.defaultHandsOff === 'boolean' ? { defaultHandsOff: a.defaultHandsOff } : {}),
        ...(typeof a.defaultExecutionMode === 'string'
          ? { defaultExecutionMode: a.defaultExecutionMode }
          : {}),
        ...(a.defaultStatus === 'running' || a.defaultStatus === 'stopped'
          ? { defaultStatus: a.defaultStatus }
          : {}),
      });
      stripStaleAutopilotKeys(existingAutopilot);
      delete existingAutopilot.heartbeatIntervalMs;
      delete existingAutopilot.progressStallMs;
      delete existingAutopilot.heartbeatDeadMs;
      delete a.heartbeatIntervalMs;
      delete a.progressStallMs;
      delete a.heartbeatDeadMs;
      if (a.maxConcurrentTasks !== undefined) {
        existingAutopilot.maxConcurrentTasks = clampAutopilotConcurrency(
          a.maxConcurrentTasks,
          existingAutopilot.maxConcurrentTasks ?? 3,
        );
      }
      if (typeof a.isolationMode === 'string') {
        const iso = a.isolationMode.trim();
        if (AUTOPILOT_ISOLATION_MODES.has(iso)) {
          existingAutopilot.isolationMode = iso;
        }
      }
      if (typeof a.shellSandbox === 'string') {
        const ss = a.shellSandbox.trim();
        if (AUTOPILOT_SHELL_SANDBOX_MODES.has(ss)) {
          existingAutopilot.shellSandbox = ss;
        }
      }
      if (a.maxTestAttempts !== undefined) {
        existingAutopilot.maxTestAttempts = clampAutopilotAttempts(
          a.maxTestAttempts,
          existingAutopilot.maxTestAttempts ?? 3,
        );
      }
      if (a.maxBuildAttempts !== undefined) {
        existingAutopilot.maxBuildAttempts = clampAutopilotAttempts(
          a.maxBuildAttempts,
          existingAutopilot.maxBuildAttempts ?? 2,
        );
      }
      if (a.maxFinalTestAttempts !== undefined) {
        existingAutopilot.maxFinalTestAttempts = clampAutopilotAttempts(
          a.maxFinalTestAttempts,
          existingAutopilot.maxFinalTestAttempts ?? 3,
        );
      }
      if (typeof a.plannerProviderId === 'string') {
        existingAutopilot.plannerProviderId = a.plannerProviderId.trim();
      }
      if (typeof a.plannerModelId === 'string') {
        existingAutopilot.plannerModelId = a.plannerModelId.trim();
      }
      const CONTINUE_SMART_ROUTE_MODES = new Set(['off', 'conservative', 'aggressive']);
      if (typeof a.continueSmartRoute === 'string' && CONTINUE_SMART_ROUTE_MODES.has(a.continueSmartRoute)) {
        existingAutopilot.continueSmartRoute = a.continueSmartRoute;
      }
      if (typeof a.selfHealMaxRounds === 'number') {
        existingAutopilot.selfHealMaxRounds = clampSelfHealRounds(
          a.selfHealMaxRounds,
          existingAutopilot.selfHealMaxRounds ?? 2,
        );
      }
      if (a.autoProvisionInfra !== undefined) {
        existingAutopilot.autoProvisionInfra = parseBool(a.autoProvisionInfra, true);
      }
      if (a.infraProvisionTimeoutMs !== undefined) {
        existingAutopilot.infraProvisionTimeoutMs = clampInfraTimeoutMs(
          a.infraProvisionTimeoutMs,
          existingAutopilot.infraProvisionTimeoutMs ?? 180000,
        );
      }
      if (a.afkAutoRestartStalls !== undefined) {
        existingAutopilot.afkAutoRestartStalls = parseBool(a.afkAutoRestartStalls, true);
      }
      if (a.guardCdOutsideWorktree !== undefined) {
        existingAutopilot.guardCdOutsideWorktree = parseBool(a.guardCdOutsideWorktree, true);
      }
      base.autopilot = existingAutopilot;
    }
  }

  if (p.terminal && typeof p.terminal === 'object') {
    const existingTerminal =
      base.terminal && typeof base.terminal === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.terminal) }
        : {
            open: false,
            heightPx: 240,
            autoOpenOnAgentRun: false,
            autoFollowAgentTab: false,
          };
    const t = /** @type {Record<string, unknown>} */ (p.terminal);
    if (typeof t.open === 'boolean') existingTerminal.open = t.open;
    if (typeof t.heightPx === 'number' && Number.isFinite(t.heightPx)) {
      existingTerminal.heightPx = Math.min(800, Math.max(120, Math.round(t.heightPx)));
    }
    if (typeof t.autoOpenOnAgentRun === 'boolean') {
      existingTerminal.autoOpenOnAgentRun = t.autoOpenOnAgentRun;
    }
    if (typeof t.autoFollowAgentTab === 'boolean') {
      existingTerminal.autoFollowAgentTab = t.autoFollowAgentTab;
    }
    if (typeof t.defaultShellProfileId === 'string') {
      const trimmed = t.defaultShellProfileId.trim();
      if (trimmed) existingTerminal.defaultShellProfileId = trimmed;
      else delete existingTerminal.defaultShellProfileId;
    }
    if (t.workspaceShellProfiles && typeof t.workspaceShellProfiles === 'object') {
      const map = {};
      for (const [key, value] of Object.entries(
        /** @type {Record<string, unknown>} */ (t.workspaceShellProfiles),
      )) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (typeof value !== 'string' || !value.trim()) continue;
        map[normalizeWorkspacePathKey(key)] = value.trim();
      }
      existingTerminal.workspaceShellProfiles = map;
    }
    if (Array.isArray(t.tabs)) {
      const tabs = [];
      for (const row of t.tabs) {
        if (!row || typeof row !== 'object') continue;
        const tab = /** @type {Record<string, unknown>} */ (row);
        const id = typeof tab.id === 'string' ? tab.id.trim() : '';
        const shellProfileId =
          typeof tab.shellProfileId === 'string' ? tab.shellProfileId.trim() : '';
        if (!id || !shellProfileId) continue;
        tabs.push({
          id,
          shellProfileId,
          ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
          ...(typeof tab.boundCwd === 'string' ? { boundCwd: tab.boundCwd } : {}),
          ...(tab.chatId === null || typeof tab.chatId === 'string'
            ? { chatId: tab.chatId }
            : {}),
          ...(tab.sessionId === null || typeof tab.sessionId === 'string'
            ? { sessionId: tab.sessionId }
            : {}),
          order: typeof tab.order === 'number' ? tab.order : tabs.length,
        });
        if (tabs.length >= 12) break;
      }
      existingTerminal.tabs = tabs;
    }
    if (typeof t.activeTabId === 'string') {
      existingTerminal.activeTabId = t.activeTabId;
    } else if (t.activeTabId === null) {
      existingTerminal.activeTabId = null;
    }
    base.terminal = existingTerminal;
  }

  if (p.chat && typeof p.chat === 'object') {
    const existingChat =
      base.chat && typeof base.chat === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.chat) }
        : {
            generationIdleTimeoutMs: DEFAULT_GENERATION_IDLE_TIMEOUT_MS,
            generationMaxDurationMs: DEFAULT_GENERATION_MAX_DURATION_MS,
          };
    let generationIdleTimeoutMs = clampGenerationIdleTimeoutMs(
      existingChat.generationIdleTimeoutMs,
    );
    let generationMaxDurationMs = clampGenerationMaxDurationMs(
      existingChat.generationMaxDurationMs,
    );
    const c = /** @type {Record<string, unknown>} */ (p.chat);
    if (
      typeof c.generationIdleTimeoutMs === 'number' &&
      Number.isFinite(c.generationIdleTimeoutMs)
    ) {
      generationIdleTimeoutMs = clampGenerationIdleTimeoutMs(c.generationIdleTimeoutMs);
    }
    if (
      typeof c.generationMaxDurationMs === 'number' &&
      Number.isFinite(c.generationMaxDurationMs)
    ) {
      generationMaxDurationMs = clampGenerationMaxDurationMs(c.generationMaxDurationMs);
    }
    base.chat = {
      generationIdleTimeoutMs,
      generationMaxDurationMs,
    };
  }

  if (p.toolCalls && typeof p.toolCalls === 'object') {
    const existingToolCalls =
      base.toolCalls && typeof base.toolCalls === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.toolCalls) }
        : { useConstrainedDecoding: false };
    const tc = /** @type {Record<string, unknown>} */ (p.toolCalls);
    if (tc.useConstrainedDecoding === true) {
      existingToolCalls.useConstrainedDecoding = true;
    } else if (tc.useConstrainedDecoding === false) {
      existingToolCalls.useConstrainedDecoding = false;
    }
    base.toolCalls = existingToolCalls;
  }

  if (p.workspace && typeof p.workspace === 'object') {
    const existingWorkspace =
      base.workspace && typeof base.workspace === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.workspace) }
        : { path: '' };
    const w = /** @type {Record<string, unknown>} */ (p.workspace);
    if (typeof w.path === 'string' && w.path.trim()) {
      existingWorkspace.path = w.path.trim();
    }
    if (typeof w.userChosen === 'boolean') {
      existingWorkspace.userChosen = w.userChosen;
    }
    if (typeof w.scratchPath === 'string' && w.scratchPath.trim()) {
      existingWorkspace.scratchPath = w.scratchPath.trim();
    }
    if (Array.isArray(w.recentPaths)) {
      const trimmed = w.recentPaths
        .filter((p) => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      existingWorkspace.recentPaths = trimmed.slice(0, 10);
    }
    if (w.devServerSettingsByPath && typeof w.devServerSettingsByPath === 'object') {
      const prev =
        existingWorkspace.devServerSettingsByPath &&
        typeof existingWorkspace.devServerSettingsByPath === 'object'
          ? /** @type {Record<string, unknown>} */ (existingWorkspace.devServerSettingsByPath)
          : {};
      existingWorkspace.devServerSettingsByPath = {
        ...prev,
        .../** @type {Record<string, unknown>} */ (w.devServerSettingsByPath),
      };
    }
    if (w.devServerByPath && typeof w.devServerByPath === 'object') {
      const prev =
        existingWorkspace.devServerByPath && typeof existingWorkspace.devServerByPath === 'object'
          ? /** @type {Record<string, unknown>} */ (existingWorkspace.devServerByPath)
          : {};
      existingWorkspace.devServerByPath = {
        ...prev,
        .../** @type {Record<string, unknown>} */ (w.devServerByPath),
      };
    }
    if (w.devServersByPath && typeof w.devServersByPath === 'object') {
      const prev =
        existingWorkspace.devServersByPath && typeof existingWorkspace.devServersByPath === 'object'
          ? /** @type {Record<string, unknown>} */ (existingWorkspace.devServersByPath)
          : {};
      existingWorkspace.devServersByPath = {
        ...prev,
        .../** @type {Record<string, unknown>} */ (w.devServersByPath),
      };
    }
    if (w.filePanelByPath && typeof w.filePanelByPath === 'object') {
      const prev =
        existingWorkspace.filePanelByPath &&
        typeof existingWorkspace.filePanelByPath === 'object'
          ? /** @type {Record<string, unknown>} */ (existingWorkspace.filePanelByPath)
          : {};
      const patch = /** @type {Record<string, unknown>} */ (w.filePanelByPath);
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (!value || typeof value !== 'object') continue;
        next[normalizeWorkspacePathKey(key.trim())] = value;
      }
      existingWorkspace.filePanelByPath = next;
    }
    if (w.terminalByPath && typeof w.terminalByPath === 'object') {
      const prev =
        existingWorkspace.terminalByPath && typeof existingWorkspace.terminalByPath === 'object'
          ? /** @type {Record<string, unknown>} */ (existingWorkspace.terminalByPath)
          : {};
      const patch = /** @type {Record<string, unknown>} */ (w.terminalByPath);
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (!value || typeof value !== 'object') continue;
        next[normalizeWorkspacePathKey(key.trim())] = value;
      }
      existingWorkspace.terminalByPath = next;
    }
    base.workspace = existingWorkspace;
  }

  if (p.desktopWorkspace && typeof p.desktopWorkspace === 'object') {
    const existingDesktopWorkspace =
      base.desktopWorkspace && typeof base.desktopWorkspace === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.desktopWorkspace) }
        : { path: '' };
    const dw = /** @type {Record<string, unknown>} */ (p.desktopWorkspace);
    if (typeof dw.path === 'string' && dw.path.trim()) {
      existingDesktopWorkspace.path = dw.path.trim();
    }
    base.desktopWorkspace = existingDesktopWorkspace;
  }

  if (p.filePanel && typeof p.filePanel === 'object') {
    const existingPanel =
      base.filePanel && typeof base.filePanel === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.filePanel) }
        : {
            fileSidebarCollapsed: false,
            viewerOpen: false,
            splitRatio: 0.55,
            expandedDirs: [],
            selectedPath: null,
            treeRoot: '.',
          };
    const fp = /** @type {Record<string, unknown>} */ (p.filePanel);
    if (typeof fp.fileSidebarCollapsed === 'boolean') {
      existingPanel.fileSidebarCollapsed = fp.fileSidebarCollapsed;
    }
    if (typeof fp.viewerOpen === 'boolean') {
      existingPanel.viewerOpen = fp.viewerOpen;
    }
    if (typeof fp.splitRatio === 'number' && Number.isFinite(fp.splitRatio)) {
      existingPanel.splitRatio = Math.min(0.75, Math.max(0.35, fp.splitRatio));
    }
    if (typeof fp.fileSidebarWidth === 'number' && Number.isFinite(fp.fileSidebarWidth)) {
      existingPanel.fileSidebarWidth = Math.min(560, Math.max(220, Math.round(fp.fileSidebarWidth)));
    }
    if (Array.isArray(fp.expandedDirs)) {
      existingPanel.expandedDirs = fp.expandedDirs.filter((d) => typeof d === 'string');
    }
    if (fp.selectedPath === null || typeof fp.selectedPath === 'string') {
      existingPanel.selectedPath = fp.selectedPath;
    }
    if (typeof fp.treeRoot === 'string' && fp.treeRoot.trim()) {
      existingPanel.treeRoot = fp.treeRoot;
    }
    if (fp.rightPaneMode === 'viewer' || fp.rightPaneMode === 'preview' || fp.rightPaneMode === null) {
      existingPanel.rightPaneMode = fp.rightPaneMode;
    }
    if (typeof fp.previewAutoReload === 'boolean') {
      existingPanel.previewAutoReload = fp.previewAutoReload;
    }
    if (
      fp.previewDevToolsDock === 'bottom' ||
      fp.previewDevToolsDock === 'side' ||
      fp.previewDevToolsDock === 'popout'
    ) {
      existingPanel.previewDevToolsDock = fp.previewDevToolsDock;
    }
    if (fp.previewSource === null) {
      existingPanel.previewSource = null;
    } else if (fp.previewSource && typeof fp.previewSource === 'object') {
      const src = /** @type {Record<string, unknown>} */ (fp.previewSource);
      if (src.kind === 'workspace' && typeof src.path === 'string' && src.path.trim()) {
        existingPanel.previewSource = { kind: 'workspace', path: src.path.trim() };
      } else if (src.kind === 'url' && typeof src.url === 'string' && src.url.trim()) {
        existingPanel.previewSource = { kind: 'url', url: src.url.trim() };
      }
    }
    if (Array.isArray(fp.openViewerTabs)) {
      const seen = new Set();
      const tabs = [];
      for (const entry of fp.openViewerTabs) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '');
        if (!trimmed || trimmed.startsWith('.minnow/attachments/') || seen.has(trimmed)) continue;
        seen.add(trimmed);
        tabs.push(trimmed);
        if (tabs.length >= 20) break;
      }
      existingPanel.openViewerTabs = tabs;
    }
    if (fp.activeViewerTab === null) {
      existingPanel.activeViewerTab = null;
    } else if (typeof fp.activeViewerTab === 'string' && fp.activeViewerTab.trim()) {
      existingPanel.activeViewerTab = fp.activeViewerTab
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\.\//, '');
    }
    if (Array.isArray(fp.previewTabs)) {
      const rows = [];
      const seen = new Set();
      for (const entry of fp.previewTabs) {
        if (!entry || typeof entry !== 'object') continue;
        const row = /** @type {Record<string, unknown>} */ (entry);
        const id = typeof row.id === 'string' ? row.id.trim() : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        let source = null;
        if (row.source && typeof row.source === 'object') {
          const src = /** @type {Record<string, unknown>} */ (row.source);
          if (src.kind === 'workspace' && typeof src.path === 'string' && src.path.trim()) {
            source = { kind: 'workspace', path: src.path.trim() };
          } else if (src.kind === 'url' && typeof src.url === 'string' && src.url.trim()) {
            source = { kind: 'url', url: src.url.trim() };
          }
        }
        rows.push({ id, source });
        if (rows.length >= 6) break;
      }
      existingPanel.previewTabs = rows;
    }
    if (fp.activePreviewTab === null) {
      existingPanel.activePreviewTab = null;
    } else if (typeof fp.activePreviewTab === 'string' && fp.activePreviewTab.trim()) {
      existingPanel.activePreviewTab = fp.activePreviewTab.trim();
    }
    base.filePanel = existingPanel;
  }

  if (p.uiDesigner && typeof p.uiDesigner === 'object') {
    const existingUi =
      base.uiDesigner && typeof base.uiDesigner === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.uiDesigner) }
        : {
            providerId: '',
            modelId: '',
            fallbackToChatModel: true,
          };
    const u = /** @type {Record<string, unknown>} */ (p.uiDesigner);
    if (typeof u.providerId === 'string') existingUi.providerId = u.providerId;
    if (typeof u.modelId === 'string') existingUi.modelId = u.modelId;
    if (typeof u.fallbackToChatModel === 'boolean') {
      existingUi.fallbackToChatModel = u.fallbackToChatModel;
    }
    base.uiDesigner = existingUi;
  }

  if (p.toolSecurity && typeof p.toolSecurity === 'object') {
    const existingTs =
      base.toolSecurity && typeof base.toolSecurity === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.toolSecurity) }
        : { filesystemAccess: 'workspace', shellSandbox: 'off', allowUnsandboxedShell: false };
    const ts = /** @type {Record<string, unknown>} */ (p.toolSecurity);
    if (ts.filesystemAccess === 'full' || ts.filesystemAccess === 'workspace') {
      existingTs.filesystemAccess = ts.filesystemAccess;
    }
    if (ts.shellSandbox === 'off' || ts.shellSandbox === 'prefer' || ts.shellSandbox === 'require') {
      existingTs.shellSandbox = ts.shellSandbox;
    }
    if (typeof ts.allowUnsandboxedShell === 'boolean') {
      existingTs.allowUnsandboxedShell = ts.allowUnsandboxedShell;
    }
    base.toolSecurity = existingTs;
  }

  if (p.editorAiCompletion && typeof p.editorAiCompletion === 'object') {
    const existing =
      base.editorAiCompletion && typeof base.editorAiCompletion === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.editorAiCompletion) }
        : {
            enabled: true,
            debounceMs: 450,
            maxPrefixLines: 80,
            maxSuffixLines: 40,
            maxPrefixChars: 6000,
            maxSuffixChars: 2000,
            temperature: 0.3,
            maxTokens: 256,
            useChatModel: true,
            providerId: '',
            modelId: '',
            includeImportContext: true,
            includeLspHover: true,
            includeLspContext: true,
            contextBudgetChars: 4000,
            useNativeFim: true,
            enableCompletionCache: true,
          };
    const e = /** @type {Record<string, unknown>} */ (p.editorAiCompletion);
    if (typeof e.enabled === 'boolean') existing.enabled = e.enabled;
    if (typeof e.debounceMs === 'number' && Number.isFinite(e.debounceMs)) {
      existing.debounceMs = Math.min(2000, Math.max(200, Math.round(e.debounceMs)));
    }
    if (typeof e.maxPrefixLines === 'number' && Number.isFinite(e.maxPrefixLines)) {
      existing.maxPrefixLines = Math.min(200, Math.max(10, Math.round(e.maxPrefixLines)));
    }
    if (typeof e.maxSuffixLines === 'number' && Number.isFinite(e.maxSuffixLines)) {
      existing.maxSuffixLines = Math.min(100, Math.max(0, Math.round(e.maxSuffixLines)));
    }
    if (typeof e.maxPrefixChars === 'number' && Number.isFinite(e.maxPrefixChars)) {
      existing.maxPrefixChars = Math.min(20_000, Math.max(500, Math.round(e.maxPrefixChars)));
    }
    if (typeof e.maxSuffixChars === 'number' && Number.isFinite(e.maxSuffixChars)) {
      existing.maxSuffixChars = Math.min(10_000, Math.max(0, Math.round(e.maxSuffixChars)));
    }
    if (typeof e.temperature === 'number' && Number.isFinite(e.temperature)) {
      existing.temperature = Math.min(1, Math.max(0, e.temperature));
    }
    if (typeof e.maxTokens === 'number' && Number.isFinite(e.maxTokens)) {
      existing.maxTokens = Math.min(1024, Math.max(16, Math.round(e.maxTokens)));
    }
    if (typeof e.useChatModel === 'boolean') existing.useChatModel = e.useChatModel;
    if (typeof e.providerId === 'string') existing.providerId = e.providerId;
    if (typeof e.modelId === 'string') existing.modelId = e.modelId;
    if (typeof e.includeImportContext === 'boolean') {
      existing.includeImportContext = e.includeImportContext;
    }
    if (typeof e.includeLspHover === 'boolean') existing.includeLspHover = e.includeLspHover;
    if (typeof e.includeLspContext === 'boolean') {
      existing.includeLspContext = e.includeLspContext;
    }
    if (typeof e.contextBudgetChars === 'number' && Number.isFinite(e.contextBudgetChars)) {
      existing.contextBudgetChars = Math.min(12_000, Math.max(500, Math.round(e.contextBudgetChars)));
    }
    if (typeof e.useNativeFim === 'boolean') existing.useNativeFim = e.useNativeFim;
    if (typeof e.enableCompletionCache === 'boolean') {
      existing.enableCompletionCache = e.enableCompletionCache;
    }
    base.editorAiCompletion = existing;
  }

  if (p.editorIntentMode && typeof p.editorIntentMode === 'object') {
    const existing =
      base.editorIntentMode && typeof base.editorIntentMode === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.editorIntentMode) }
        : {
            enabledByDefault: false,
            debounceMs: 400,
            contextWindow: 5,
            autoResolveOnLineLeave: false,
            sigil: '',
            providerId: '',
            modelId: '',
            maxTokens: 400,
          };
    const e = /** @type {Record<string, unknown>} */ (p.editorIntentMode);
    if (typeof e.enabledByDefault === 'boolean') existing.enabledByDefault = e.enabledByDefault;
    if (typeof e.autoResolveOnLineLeave === 'boolean') {
      existing.autoResolveOnLineLeave = e.autoResolveOnLineLeave;
    }
    if (typeof e.contextWindow === 'number' && Number.isFinite(e.contextWindow)) {
      existing.contextWindow = Math.min(20, Math.max(1, Math.round(e.contextWindow)));
    }
    if (typeof e.debounceMs === 'number' && Number.isFinite(e.debounceMs)) {
      existing.debounceMs = Math.min(2000, Math.max(100, Math.round(e.debounceMs)));
    }
    if (typeof e.sigil === 'string') existing.sigil = e.sigil.trim();
    if (typeof e.providerId === 'string') existing.providerId = e.providerId.trim();
    if (typeof e.modelId === 'string') existing.modelId = e.modelId.trim();
    if (typeof e.maxTokens === 'number' && Number.isFinite(e.maxTokens)) {
      existing.maxTokens = Math.min(4096, Math.max(128, Math.round(e.maxTokens)));
    }
    base.editorIntentMode = existing;
  }

  if (p.editorSettings && typeof p.editorSettings === 'object') {
    const existing =
      base.editorSettings && typeof base.editorSettings === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.editorSettings) }
        : {
            fontSize: 13,
            tabSize: 2,
            wordWrap: false,
            renderWhitespace: false,
          };
    const e = /** @type {Record<string, unknown>} */ (p.editorSettings);
    if (typeof e.fontSize === 'number' && Number.isFinite(e.fontSize)) {
      existing.fontSize = Math.min(24, Math.max(10, Math.round(e.fontSize)));
    }
    if (typeof e.tabSize === 'number' && Number.isFinite(e.tabSize)) {
      existing.tabSize = Math.min(8, Math.max(1, Math.round(e.tabSize)));
    }
    if (typeof e.wordWrap === 'boolean') existing.wordWrap = e.wordWrap;
    if (typeof e.renderWhitespace === 'boolean') {
      existing.renderWhitespace = e.renderWhitespace;
    }
    base.editorSettings = existing;
  }

  if (p.server && typeof p.server === 'object') {
    const existingServer =
      base.server && typeof base.server === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.server) }
        : { networkAccess: 'local' };
    const s = /** @type {Record<string, unknown>} */ (p.server);
    if (typeof s.networkAccess === 'string') {
      const mode = s.networkAccess.trim().toLowerCase();
      if (mode === 'local' || mode === 'lan') {
        existingServer.networkAccess = mode;
      }
    }
    base.server = existingServer;
  }

  if (p.desktopShell && typeof p.desktopShell === 'object') {
    const existingShell =
      base.desktopShell && typeof base.desktopShell === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.desktopShell) }
        : { closeToTray: true, zoomPercent: 80, hardwareAcceleration: true };
    const ds = /** @type {Record<string, unknown>} */ (p.desktopShell);
    if (typeof ds.closeToTray === 'boolean') {
      existingShell.closeToTray = ds.closeToTray;
    }
    if (
      ds.windowCloseAction === 'ask' ||
      ds.windowCloseAction === 'close' ||
      ds.windowCloseAction === 'background'
    ) {
      existingShell.windowCloseAction = ds.windowCloseAction;
    }
    if (typeof ds.hardwareAcceleration === 'boolean') {
      existingShell.hardwareAcceleration = ds.hardwareAcceleration;
    }
    if (typeof ds.zoomPercent === 'number' && Number.isFinite(ds.zoomPercent)) {
      const rounded = Math.round(ds.zoomPercent);
      if (rounded >= 50 && rounded <= 300) {
        existingShell.zoomPercent = rounded;
      }
    }
    base.desktopShell = existingShell;
  }

  if (p.browser && typeof p.browser === 'object') {
    const existingBrowser =
      base.browser && typeof base.browser === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.browser) }
        : {
            enabled: true,
            allowNavigate: true,
            restoreBrowserTabs: true,
            allowedOriginPatterns: [
              'http://localhost:*',
              'http://127.0.0.1:*',
              'https://localhost:*',
            ],
          };
    const b = /** @type {Record<string, unknown>} */ (p.browser);
    if (typeof b.enabled === 'boolean') existingBrowser.enabled = b.enabled;
    if (typeof b.allowNavigate === 'boolean') {
      existingBrowser.allowNavigate = b.allowNavigate;
    }
    if (typeof b.restoreBrowserTabs === 'boolean') {
      existingBrowser.restoreBrowserTabs = b.restoreBrowserTabs;
    }
    if (Array.isArray(b.allowedOriginPatterns)) {
      existingBrowser.allowedOriginPatterns = b.allowedOriginPatterns.filter(
        (row) => typeof row === 'string' && row.trim(),
      );
    }
    base.browser = existingBrowser;
  }

  if (p.planning && typeof p.planning === 'object') {
    const existingPlanning =
      base.planning && typeof base.planning === 'object'
        ? { .../** @type {Record<string, unknown>} */ (base.planning) }
        : { granularity: 'medium' };
    const pl = /** @type {Record<string, unknown>} */ (p.planning);
    if (pl.granularity === 'large' || pl.granularity === 'medium' || pl.granularity === 'small') {
      existingPlanning.granularity = pl.granularity;
    }
    if (pl.superPlan && typeof pl.superPlan === 'object') {
      existingPlanning.superPlan = normalizeSuperPlanConfig(
        pl.superPlan,
        existingPlanning.superPlan && typeof existingPlanning.superPlan === 'object'
          ? /** @type {Record<string, unknown>} */ (existingPlanning.superPlan)
          : {},
      );
    }
    base.planning = existingPlanning;
  }

  if (
    p.activePromptProfile === 'full' ||
    p.activePromptProfile === 'lite' ||
    p.activePromptProfile === 'custom'
  ) {
    base.activePromptProfile = p.activePromptProfile;
  }
  if (p.activePromptConfigId === null || typeof p.activePromptConfigId === 'string') {
    base.activePromptConfigId = p.activePromptConfigId;
  }
  if (typeof p.activeInfoPresetId === 'string' && p.activeInfoPresetId.trim()) {
    base.activeInfoPresetId = p.activeInfoPresetId.trim();
  }
  if (p.activeSetupProfileId === null || typeof p.activeSetupProfileId === 'string') {
    base.activeSetupProfileId = p.activeSetupProfileId;
  }
  if (typeof p.workspaceProfileAutoApply === 'boolean') {
    base.workspaceProfileAutoApply = p.workspaceProfileAutoApply;
  }
  if (p.workspaceProfiles && typeof p.workspaceProfiles === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (p.workspaceProfiles),
    )) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const normKey = normalizeWorkspacePath(key);
      if (!normKey) continue;
      if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(value.trim())) continue;
      out[normKey] = value.trim();
    }
    base.workspaceProfiles = out;
  }

  if (p.supervisor && typeof p.supervisor === 'object') {
    base.supervisor = mergeSupervisorConfig(
      /** @type {Record<string, unknown>} */ (p.supervisor),
      base.supervisor && typeof base.supervisor === 'object'
        ? /** @type {Record<string, unknown>} */ (base.supervisor)
        : {},
    );
  }

  if (p.memory && typeof p.memory === 'object') {
    base.memory = normalizeMemoryConfig(
      p.memory,
      base.memory && typeof base.memory === 'object'
        ? /** @type {Record<string, unknown>} */ (base.memory)
        : {},
    );
  }

  if (p.synthesis && typeof p.synthesis === 'object') {
    base.synthesis = normalizeSynthesisConfig(
      p.synthesis,
      base.synthesis && typeof base.synthesis === 'object'
        ? /** @type {Record<string, unknown>} */ (base.synthesis)
        : {},
    );
  }

  if (p.fallbackChains !== undefined) {
    base.fallbackChains = normalizeFallbackChainsConfig(
      p.fallbackChains,
      base.fallbackChains && typeof base.fallbackChains === 'object'
        ? /** @type {Record<string, unknown>} */ (base.fallbackChains)
        : {},
    );
  }

  if (p.voice && typeof p.voice === 'object') {
    base.voice = normalizeVoiceConfig(
      p.voice,
      base.voice && typeof base.voice === 'object'
        ? /** @type {Record<string, unknown>} */ (base.voice)
        : {},
    );
  }

  if (p.experts && typeof p.experts === 'object') {
    base.experts = normalizeExpertsConfigBlock(p.experts);
  }

  return base;
}

function normalizeExpertsConfigBlock(raw) {
  if (!raw || typeof raw !== 'object') {
    return { enabled: true, profiles: {} };
  }
  const row = /** @type {Record<string, unknown>} */ (raw);
  const profiles = {};
  if (row.profiles && typeof row.profiles === 'object') {
    for (const [key, value] of Object.entries(
      /** @type {Record<string, unknown>} */ (row.profiles),
    )) {
      const id = String(key).trim().slice(0, 64);
      if (!id || !value || typeof value !== 'object') continue;
      const src = /** @type {Record<string, unknown>} */ (value);
      const prof = {};
      if (typeof src.providerId === 'string' && src.providerId.trim()) {
        prof.providerId = src.providerId.trim().slice(0, 64);
      }
      if (typeof src.modelId === 'string' && src.modelId.trim()) {
        prof.modelId = src.modelId.trim().slice(0, 64);
      }
      if (typeof src.modeId === 'string' && MODE_IDS.includes(src.modeId)) {
        prof.modeId = src.modeId;
      }
      if (Array.isArray(src.toolAllowlist)) {
        const list = src.toolAllowlist
          .filter((t) => typeof t === 'string' && t.trim())
          .map((t) => String(t).trim().slice(0, 128))
          .slice(0, 128);
        if (list.length) prof.toolAllowlist = list;
      }
      if (Array.isArray(src.toolDenylist)) {
        const list = src.toolDenylist
          .filter((t) => typeof t === 'string' && t.trim())
          .map((t) => String(t).trim().slice(0, 128))
          .slice(0, 128);
        if (list.length) prof.toolDenylist = list;
      }
      if (src.memoryEnabled === false) prof.memoryEnabled = false;
      else if (src.memoryEnabled === true) prof.memoryEnabled = true;
      if (Object.keys(prof).length) profiles[id] = prof;
    }
  }
  return { enabled: row.enabled !== false, profiles };
}

/**
 * @returns {object}
 */
export function defaultFallbackChainsConfig() {
  return {
    enabled: false,
    cooldownSeconds: 60,
    maxChainLength: 4,
    roles: {
      _global: [],
      default: [],
      utility: [],
      research: [],
      vision: [],
    },
  };
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [existing]
 */
export function normalizeFallbackChainsConfig(raw, existing = {}) {
  const base = {
    ...defaultFallbackChainsConfig(),
    ...(existing && typeof existing === 'object' ? existing : {}),
    roles: {
      ...defaultFallbackChainsConfig().roles,
      ...(existing?.roles && typeof existing.roles === 'object'
        ? /** @type {Record<string, unknown>} */ (existing.roles)
        : {}),
    },
  };

  if (!raw || typeof raw !== 'object') {
    return base;
  }

  const patch = /** @type {Record<string, unknown>} */ (raw);
  if (typeof patch.enabled === 'boolean') {
    base.enabled = patch.enabled;
  }
  if (typeof patch.cooldownSeconds === 'number' && Number.isFinite(patch.cooldownSeconds)) {
    base.cooldownSeconds = Math.min(3600, Math.max(10, Math.round(patch.cooldownSeconds)));
  }
  if (typeof patch.maxChainLength === 'number' && Number.isFinite(patch.maxChainLength)) {
    base.maxChainLength = Math.min(8, Math.max(1, Math.round(patch.maxChainLength)));
  }

  if (patch.roles && typeof patch.roles === 'object') {
    const roles = { ...base.roles };
    for (const [role, entries] of Object.entries(
      /** @type {Record<string, unknown>} */ (patch.roles),
    )) {
      if (!Array.isArray(entries)) continue;
      const normalized = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const row = /** @type {Record<string, unknown>} */ (entry);
        if (typeof row.providerId !== 'string' || !row.providerId.trim()) continue;
        let providerId;
        try {
          providerId = row.providerId.trim();
        } catch {
          continue;
        }
        normalized.push({
          providerId,
          modelId: typeof row.modelId === 'string' ? row.modelId : '',
        });
        if (normalized.length >= base.maxChainLength) break;
      }
      roles[role] = normalized;
    }
    base.roles = roles;
  }

  return base;
}

const QWEN_CUSTOM_VOICE_06B = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice';

const TTS_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
]);

const TTS_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);

const STT_RESPONSE_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

function clampVoiceNum(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isQwen06bCustomVoice(modelId) {
  return typeof modelId === 'string' && modelId.includes('0.6B-CustomVoice');
}

/**
 * @param {boolean} [cudaAvailable]
 */
function defaultSttLocal(cudaAvailable = false) {
  return {
    modelId: cudaAvailable ? 'openai/whisper-small' : 'openai/whisper-base',
    language: '',
    task: 'transcribe',
    longFormAlgorithm: 'chunked',
    chunkLengthSeconds: 30,
    batchSize: 1,
    returnTimestamps: false,
    timestampGranularity: 'segment',
    maxNewTokens: 448,
    numBeams: 1,
    conditionOnPrevTokens: false,
    compressionRatioThreshold: 1.35,
    temperatureFallback: true,
    temperature: 0,
    logprobThreshold: -1,
    noSpeechThreshold: 0.6,
    device: 'auto',
    computeType: 'auto',
    attnImplementation: 'auto',
    useSafetensors: true,
    lowCpuMemUsage: true,
    torchCompile: false,
    streamingEnabled: true,
  };
}

function defaultSttProvider() {
  return {
    providerId: '',
    model: 'whisper-1',
    language: 'en',
    prompt: '',
    responseFormat: 'json',
    temperature: 0,
  };
}

/**
 * @param {boolean} [cudaAvailable]
 */
function defaultTtsLocal(cudaAvailable = false) {
  return {
    modelId: QWEN_CUSTOM_VOICE_06B,
    deviceMap: 'auto',
    dtype: cudaAvailable ? 'bfloat16' : 'float32',
    attnImplementation: 'auto',
    tokenizerModelId: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
    mode: 'custom_voice',
    customVoice: {
      speaker: 'Ryan',
      language: 'Auto',
      instruct: '',
    },
    voiceDesign: {
      language: 'Auto',
      instruct: '',
    },
    voiceClone: {
      refAudioPath: '',
      refText: '',
      xVectorOnlyMode: false,
      language: 'Auto',
      savedPromptId: '',
    },
    generation: {
      maxNewTokens: 2048,
      topP: 1,
      topK: 50,
      temperature: 0.9,
      repetitionPenalty: 1,
    },
    streaming: defaultTtsLocalStreaming(),
  };
}

function defaultTtsLocalStreaming() {
  return {
    emitEveryFrames: 8,
    decodeWindowFrames: 80,
    firstChunkEmitEvery: 5,
    firstChunkDecodeWindow: 48,
    overlapSamples: 512,
    repetitionPenalty: 1.05,
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeTtsLocalStreaming(raw, base) {
  const out = { ...base };
  out.emitEveryFrames = clampVoiceNum(raw.emitEveryFrames, 1, 32, out.emitEveryFrames);
  out.decodeWindowFrames = clampVoiceNum(raw.decodeWindowFrames, 16, 256, out.decodeWindowFrames);
  out.firstChunkEmitEvery = clampVoiceNum(raw.firstChunkEmitEvery, 1, 32, out.firstChunkEmitEvery);
  out.firstChunkDecodeWindow = clampVoiceNum(
    raw.firstChunkDecodeWindow,
    16,
    256,
    out.firstChunkDecodeWindow,
  );
  out.overlapSamples = clampVoiceNum(raw.overlapSamples, 0, 4096, out.overlapSamples);
  out.repetitionPenalty = clampVoiceNum(raw.repetitionPenalty, 0.5, 2, out.repetitionPenalty);
  return out;
}

function defaultTtsProvider() {
  return {
    providerId: '',
    model: 'tts-1',
    voice: 'alloy',
    speed: 1,
    format: 'mp3',
  };
}

function defaultTtsBrowser() {
  return {
    voiceUri: '',
    rate: 1,
    pitch: 1,
    volume: 1,
  };
}

function defaultVoiceAudio() {
  return {
    inputDeviceId: '',
    outputDeviceId: '',
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

/**
 * @param {boolean} [cudaAvailable]
 * @returns {object}
 */
export function defaultVoiceConfig(cudaAvailable = false) {
  const sttLocal = defaultSttLocal(cudaAvailable);
  const ttsLocal = defaultTtsLocal(cudaAvailable);
  const sttProvider = defaultSttProvider();
  const ttsProvider = defaultTtsProvider();
  return {
    audio: defaultVoiceAudio(),
    stt: {
      enabled: true,
      backend: 'local',
      local: sttLocal,
      provider: sttProvider,
      providerId: '',
      model: sttLocal.modelId,
      language: sttLocal.language,
    },
    tts: {
      enabled: true,
      backend: 'local',
      streaming: true,
      local: ttsLocal,
      provider: ttsProvider,
      browser: defaultTtsBrowser(),
      providerId: '',
      model: ttsLocal.modelId,
      voice: ttsLocal.customVoice.speaker,
      speed: 1,
      format: 'wav',
    },
    limits: {
      maxAudioBytes: 25 * 1024 * 1024,
      maxDurationSeconds: 300,
      silenceTimeoutSeconds: 2.5,
    },
  };
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeSttLocal(raw, base) {
  const out = { ...base };
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) out.modelId = raw.modelId.trim();
  if (typeof raw.language === 'string') out.language = raw.language.trim();
  if (raw.task === 'transcribe' || raw.task === 'translate') out.task = raw.task;
  if (raw.longFormAlgorithm === 'sequential' || raw.longFormAlgorithm === 'chunked') {
    out.longFormAlgorithm = raw.longFormAlgorithm;
  }
  out.chunkLengthSeconds = clampVoiceNum(raw.chunkLengthSeconds, 10, 30, out.chunkLengthSeconds);
  out.batchSize = clampVoiceNum(raw.batchSize, 1, 16, out.batchSize);
  if (typeof raw.returnTimestamps === 'boolean') out.returnTimestamps = raw.returnTimestamps;
  if (raw.timestampGranularity === 'segment' || raw.timestampGranularity === 'word') {
    out.timestampGranularity = raw.timestampGranularity;
  }
  out.maxNewTokens = clampVoiceNum(raw.maxNewTokens, 1, 448, out.maxNewTokens);
  out.numBeams = clampVoiceNum(raw.numBeams, 1, 5, out.numBeams);
  if (typeof raw.conditionOnPrevTokens === 'boolean') {
    out.conditionOnPrevTokens = raw.conditionOnPrevTokens;
  }
  out.compressionRatioThreshold = clampVoiceNum(
    raw.compressionRatioThreshold,
    0.5,
    2,
    out.compressionRatioThreshold,
  );
  if (typeof raw.temperatureFallback === 'boolean') out.temperatureFallback = raw.temperatureFallback;
  out.temperature = clampVoiceNum(raw.temperature, 0, 1, out.temperature);
  out.logprobThreshold = clampVoiceNum(raw.logprobThreshold, -2, 0, out.logprobThreshold);
  out.noSpeechThreshold = clampVoiceNum(raw.noSpeechThreshold, 0, 1, out.noSpeechThreshold);
  if (raw.device === 'auto' || raw.device === 'cpu' || raw.device === 'cuda') out.device = raw.device;
  if (
    raw.computeType === 'auto' ||
    raw.computeType === 'float16' ||
    raw.computeType === 'bfloat16' ||
    raw.computeType === 'float32'
  ) {
    out.computeType = raw.computeType;
  }
  if (
    raw.attnImplementation === 'auto' ||
    raw.attnImplementation === 'sdpa' ||
    raw.attnImplementation === 'flash_attention_2'
  ) {
    out.attnImplementation = raw.attnImplementation;
  }
  if (typeof raw.useSafetensors === 'boolean') out.useSafetensors = raw.useSafetensors;
  if (typeof raw.lowCpuMemUsage === 'boolean') out.lowCpuMemUsage = raw.lowCpuMemUsage;
  if (typeof raw.torchCompile === 'boolean') out.torchCompile = raw.torchCompile;
  if (typeof raw.streamingEnabled === 'boolean') out.streamingEnabled = raw.streamingEnabled;
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeSttProvider(raw, base) {
  const out = { ...base };
  if (typeof raw.providerId === 'string') out.providerId = raw.providerId.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.language === 'string') out.language = raw.language.trim();
  if (typeof raw.prompt === 'string') out.prompt = raw.prompt;
  if (typeof raw.responseFormat === 'string' && STT_RESPONSE_FORMATS.has(raw.responseFormat)) {
    out.responseFormat = raw.responseFormat;
  }
  out.temperature = clampVoiceNum(raw.temperature, 0, 1, out.temperature);
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeTtsLocal(raw, base) {
  const out = { ...base };
  if (typeof raw.modelId === 'string' && raw.modelId.trim()) out.modelId = raw.modelId.trim();
  if (raw.deviceMap === 'auto' || raw.deviceMap === 'cpu' || raw.deviceMap === 'cuda:0') {
    out.deviceMap = raw.deviceMap;
  }
  if (
    raw.dtype === 'auto' ||
    raw.dtype === 'bfloat16' ||
    raw.dtype === 'float16' ||
    raw.dtype === 'float32'
  ) {
    out.dtype = raw.dtype;
  }
  if (
    raw.attnImplementation === 'auto' ||
    raw.attnImplementation === 'flash_attention_2' ||
    raw.attnImplementation === 'sdpa' ||
    raw.attnImplementation === 'eager'
  ) {
    out.attnImplementation = raw.attnImplementation;
  }
  if (typeof raw.tokenizerModelId === 'string' && raw.tokenizerModelId.trim()) {
    out.tokenizerModelId = raw.tokenizerModelId.trim();
  }
  if (raw.mode === 'custom_voice' || raw.mode === 'voice_design' || raw.mode === 'voice_clone') {
    out.mode = raw.mode;
  }
  if (raw.customVoice && typeof raw.customVoice === 'object') {
    const cv = /** @type {Record<string, unknown>} */ (raw.customVoice);
    if (typeof cv.speaker === 'string' && cv.speaker.trim()) {
      out.customVoice.speaker = cv.speaker.trim();
    }
    if (typeof cv.language === 'string') out.customVoice.language = cv.language.trim();
    if (typeof cv.instruct === 'string') out.customVoice.instruct = cv.instruct;
  }
  if (raw.voiceDesign && typeof raw.voiceDesign === 'object') {
    const vd = /** @type {Record<string, unknown>} */ (raw.voiceDesign);
    if (typeof vd.language === 'string') out.voiceDesign.language = vd.language.trim();
    if (typeof vd.instruct === 'string') out.voiceDesign.instruct = vd.instruct;
  }
  if (raw.voiceClone && typeof raw.voiceClone === 'object') {
    const vc = /** @type {Record<string, unknown>} */ (raw.voiceClone);
    if (typeof vc.refAudioPath === 'string') out.voiceClone.refAudioPath = vc.refAudioPath.trim();
    if (typeof vc.refText === 'string') out.voiceClone.refText = vc.refText;
    if (typeof vc.xVectorOnlyMode === 'boolean') out.voiceClone.xVectorOnlyMode = vc.xVectorOnlyMode;
    if (typeof vc.language === 'string') out.voiceClone.language = vc.language.trim();
    if (typeof vc.savedPromptId === 'string') {
      out.voiceClone.savedPromptId = vc.savedPromptId.trim();
    }
  }
  if (raw.generation && typeof raw.generation === 'object') {
    const gen = /** @type {Record<string, unknown>} */ (raw.generation);
    out.generation.maxNewTokens = clampVoiceNum(
      gen.maxNewTokens,
      256,
      4096,
      out.generation.maxNewTokens,
    );
    out.generation.topP = clampVoiceNum(gen.topP, 0, 1, out.generation.topP);
    out.generation.topK = clampVoiceNum(gen.topK, 0, 100, out.generation.topK);
    out.generation.temperature = clampVoiceNum(gen.temperature, 0, 2, out.generation.temperature);
    out.generation.repetitionPenalty = clampVoiceNum(
      gen.repetitionPenalty,
      0,
      2,
      out.generation.repetitionPenalty,
    );
  }
  if (raw.streaming && typeof raw.streaming === 'object') {
    out.streaming = normalizeTtsLocalStreaming(
      /** @type {Record<string, unknown>} */ (raw.streaming),
      out.streaming ?? defaultTtsLocalStreaming(),
    );
  } else if (!out.streaming) {
    out.streaming = defaultTtsLocalStreaming();
  }
  if (isQwen06bCustomVoice(out.modelId)) {
    out.customVoice.instruct = '';
  }
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeTtsProvider(raw, base) {
  const out = { ...base };
  if (typeof raw.providerId === 'string') out.providerId = raw.providerId.trim();
  if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim();
  if (typeof raw.voice === 'string' && raw.voice.trim()) {
    const voice = raw.voice.trim().toLowerCase();
    out.voice = TTS_VOICES.has(voice) ? voice : out.voice;
  }
  out.speed = clampVoiceNum(raw.speed, 0.25, 4, out.speed);
  if (typeof raw.format === 'string' && TTS_FORMATS.has(raw.format.trim().toLowerCase())) {
    out.format = raw.format.trim().toLowerCase();
  }
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>} base
 */
function normalizeTtsBrowser(raw, base) {
  const out = { ...base };
  if (typeof raw.voiceUri === 'string') out.voiceUri = raw.voiceUri.trim();
  out.rate = clampVoiceNum(raw.rate, 0.25, 4, out.rate);
  out.pitch = clampVoiceNum(raw.pitch, 0, 2, out.pitch);
  out.volume = clampVoiceNum(raw.volume, 0, 1, out.volume);
  return out;
}

function syncLegacyVoiceFields(stt, tts) {
  if (stt.backend === 'provider') {
    stt.providerId = stt.provider.providerId;
    stt.model = stt.provider.model;
    stt.language = stt.provider.language;
  } else {
    stt.providerId = '';
    stt.model = stt.local.modelId;
    stt.language = stt.local.language;
  }

  if (tts.backend === 'provider') {
    tts.providerId = tts.provider.providerId;
    tts.model = tts.provider.model;
    tts.voice = tts.provider.voice;
    tts.speed = tts.provider.speed;
    tts.format = tts.provider.format;
  } else if (tts.backend === 'browser') {
    tts.providerId = 'browser';
    tts.model = '';
    tts.voice = tts.browser.voiceUri;
    tts.speed = tts.browser.rate;
    tts.format = 'wav';
  } else {
    tts.providerId = '';
    tts.model = tts.local.modelId;
    tts.voice = tts.local.customVoice.speaker;
    tts.speed = 1;
    tts.format = 'wav';
  }
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [existing]
 * @param {{ cudaAvailable?: boolean, installedManifest?: { stt?: unknown[], tts?: unknown[] } }} [options]
 */
export function normalizeVoiceConfig(raw, existing = {}, options = {}) {
  const cudaAvailable = options.cudaAvailable === true;
  const defaults = defaultVoiceConfig(cudaAvailable);
  const base = {
    audio: {
      ...defaults.audio,
      ...(existing.audio && typeof existing.audio === 'object'
        ? /** @type {Record<string, unknown>} */ (existing.audio)
        : {}),
    },
    stt: {
      ...defaults.stt,
      local: normalizeSttLocal(
        existing.stt &&
          typeof existing.stt === 'object' &&
          existing.stt.local &&
          typeof existing.stt.local === 'object'
          ? /** @type {Record<string, unknown>} */ (existing.stt.local)
          : {},
        defaults.stt.local,
      ),
      provider: normalizeSttProvider(
        existing.stt &&
          typeof existing.stt === 'object' &&
          existing.stt.provider &&
          typeof existing.stt.provider === 'object'
          ? /** @type {Record<string, unknown>} */ (existing.stt.provider)
          : {},
        defaults.stt.provider,
      ),
    },
    tts: {
      ...defaults.tts,
      local: normalizeTtsLocal(
        existing.tts &&
          typeof existing.tts === 'object' &&
          existing.tts.local &&
          typeof existing.tts.local === 'object'
          ? /** @type {Record<string, unknown>} */ (existing.tts.local)
          : {},
        defaults.tts.local,
      ),
      provider: normalizeTtsProvider(
        existing.tts &&
          typeof existing.tts === 'object' &&
          existing.tts.provider &&
          typeof existing.tts.provider === 'object'
          ? /** @type {Record<string, unknown>} */ (existing.tts.provider)
          : {},
        defaults.tts.provider,
      ),
      browser: normalizeTtsBrowser(
        existing.tts &&
          typeof existing.tts === 'object' &&
          existing.tts.browser &&
          typeof existing.tts.browser === 'object'
          ? /** @type {Record<string, unknown>} */ (existing.tts.browser)
          : {},
        defaults.tts.browser,
      ),
    },
    limits: {
      ...defaults.limits,
      ...(existing.limits && typeof existing.limits === 'object'
        ? /** @type {Record<string, unknown>} */ (existing.limits)
        : {}),
    },
  };

  if (existing.stt && typeof existing.stt === 'object') {
    const estt = /** @type {Record<string, unknown>} */ (existing.stt);
    if (typeof estt.enabled === 'boolean') base.stt.enabled = estt.enabled;
    if (estt.backend === 'local' || estt.backend === 'provider') base.stt.backend = estt.backend;
  }
  if (existing.tts && typeof existing.tts === 'object') {
    const etts = /** @type {Record<string, unknown>} */ (existing.tts);
    if (typeof etts.enabled === 'boolean') base.tts.enabled = etts.enabled;
    if (typeof etts.streaming === 'boolean') base.tts.streaming = etts.streaming;
    if (etts.backend === 'local' || etts.backend === 'provider' || etts.backend === 'browser') {
      base.tts.backend = etts.backend;
    }
  }

  if (!raw || typeof raw !== 'object') {
    syncLegacyVoiceFields(base.stt, base.tts);
    return base;
  }
  const row = /** @type {Record<string, unknown>} */ (raw);

  if (row.audio && typeof row.audio === 'object') {
    const audio = /** @type {Record<string, unknown>} */ (row.audio);
    if (typeof audio.inputDeviceId === 'string') {
      base.audio.inputDeviceId = audio.inputDeviceId.trim();
    }
    if (typeof audio.outputDeviceId === 'string') {
      base.audio.outputDeviceId = audio.outputDeviceId.trim();
    }
    if (typeof audio.echoCancellation === 'boolean') {
      base.audio.echoCancellation = audio.echoCancellation;
    }
    if (typeof audio.noiseSuppression === 'boolean') {
      base.audio.noiseSuppression = audio.noiseSuppression;
    }
    if (typeof audio.autoGainControl === 'boolean') {
      base.audio.autoGainControl = audio.autoGainControl;
    }
  }

  if (row.stt && typeof row.stt === 'object') {
    const stt = /** @type {Record<string, unknown>} */ (row.stt);
    if (typeof stt.enabled === 'boolean') base.stt.enabled = stt.enabled;
    if (stt.local && typeof stt.local === 'object') {
      base.stt.local = normalizeSttLocal(
        /** @type {Record<string, unknown>} */ (stt.local),
        base.stt.local,
      );
    }
    if (stt.provider && typeof stt.provider === 'object') {
      base.stt.provider = normalizeSttProvider(
        /** @type {Record<string, unknown>} */ (stt.provider),
        base.stt.provider,
      );
    }
    if (typeof stt.providerId === 'string' && stt.providerId.trim()) {
      base.stt.provider.providerId = stt.providerId.trim();
    }
    if (typeof stt.model === 'string' && stt.model.trim() && !stt.local) {
      base.stt.provider.model = stt.model.trim();
    }
    if (typeof stt.language === 'string' && stt.language.trim() && !stt.local) {
      base.stt.provider.language = stt.language.trim();
    }
    if (stt.backend === 'local' || stt.backend === 'provider') {
      base.stt.backend = stt.backend;
    } else if (base.stt.provider.providerId) {
      base.stt.backend = 'provider';
    } else {
      base.stt.backend = 'local';
    }
  }

  if (row.tts && typeof row.tts === 'object') {
    const tts = /** @type {Record<string, unknown>} */ (row.tts);
    if (typeof tts.enabled === 'boolean') base.tts.enabled = tts.enabled;
    if (typeof tts.streaming === 'boolean') base.tts.streaming = tts.streaming;
    if (tts.local && typeof tts.local === 'object') {
      base.tts.local = normalizeTtsLocal(
        /** @type {Record<string, unknown>} */ (tts.local),
        base.tts.local,
      );
    }
    if (tts.provider && typeof tts.provider === 'object') {
      base.tts.provider = normalizeTtsProvider(
        /** @type {Record<string, unknown>} */ (tts.provider),
        base.tts.provider,
      );
    }
    if (tts.browser && typeof tts.browser === 'object') {
      base.tts.browser = normalizeTtsBrowser(
        /** @type {Record<string, unknown>} */ (tts.browser),
        base.tts.browser,
      );
    }
    if (typeof tts.providerId === 'string' && tts.providerId.trim()) {
      const pid = tts.providerId.trim();
      if (pid === 'browser') {
        base.tts.backend = 'browser';
      } else {
        base.tts.provider.providerId = pid;
      }
    }
    if (typeof tts.model === 'string' && tts.model.trim() && !tts.local) {
      base.tts.provider.model = tts.model.trim();
    }
    if (typeof tts.voice === 'string' && tts.voice.trim() && !tts.local) {
      const voice = tts.voice.trim().toLowerCase();
      base.tts.provider.voice = TTS_VOICES.has(voice) ? voice : base.tts.provider.voice;
    }
    if (typeof tts.speed === 'number' && Number.isFinite(tts.speed) && !tts.provider) {
      base.tts.provider.speed = clampVoiceNum(tts.speed, 0.25, 4, base.tts.provider.speed);
    }
    if (typeof tts.format === 'string' && tts.format.trim() && !tts.provider) {
      const format = tts.format.trim().toLowerCase();
      if (TTS_FORMATS.has(format)) base.tts.provider.format = format;
    }
    if (tts.backend === 'local' || tts.backend === 'provider' || tts.backend === 'browser') {
      base.tts.backend = tts.backend;
    } else if (base.tts.provider.providerId) {
      base.tts.backend = 'provider';
    } else if (tts.providerId === 'browser') {
      base.tts.backend = 'browser';
    } else {
      base.tts.backend = 'local';
    }
  }

  if (row.limits && typeof row.limits === 'object') {
    const limits = /** @type {Record<string, unknown>} */ (row.limits);
    if (typeof limits.maxAudioBytes === 'number' && Number.isFinite(limits.maxAudioBytes)) {
      base.limits.maxAudioBytes = Math.max(1024, Math.round(limits.maxAudioBytes));
    }
    if (
      typeof limits.maxDurationSeconds === 'number' &&
      Number.isFinite(limits.maxDurationSeconds)
    ) {
      base.limits.maxDurationSeconds = Math.max(1, Math.round(limits.maxDurationSeconds));
    }
    if (
      typeof limits.silenceTimeoutSeconds === 'number' &&
      Number.isFinite(limits.silenceTimeoutSeconds)
    ) {
      base.limits.silenceTimeoutSeconds = Math.max(
        0,
        Math.min(30, limits.silenceTimeoutSeconds),
      );
    }
  }

  syncLegacyVoiceFields(base.stt, base.tts);

  const manifest = options.installedManifest;
  if (manifest && typeof manifest === 'object') {
    const sttRows = Array.isArray(manifest.stt) ? manifest.stt : [];
    const ttsRows = Array.isArray(manifest.tts) ? manifest.tts : [];
    const hasLocalStt = sttRows.some(
      (row) =>
        row &&
        typeof row === 'object' &&
        /** @type {{ mode?: string }} */ (row).mode !== 'tokenizer',
    );
    const hasLocalTts = ttsRows.some(
      (row) =>
        row &&
        typeof row === 'object' &&
        /** @type {{ mode?: string }} */ (row).mode !== 'tokenizer',
    );
    if (
      base.stt.backend === 'local' &&
      !hasLocalStt &&
      typeof base.stt.provider?.providerId === 'string' &&
      base.stt.provider.providerId.trim()
    ) {
      base.stt.backend = 'provider';
    }
    if (
      base.tts.backend === 'local' &&
      !hasLocalTts &&
      typeof base.tts.provider?.providerId === 'string' &&
      base.tts.provider.providerId.trim()
    ) {
      base.tts.backend = 'provider';
    }
    syncLegacyVoiceFields(base.stt, base.tts);
  }

  return base;
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [existing]
 */
export function normalizeMemoryConfig(raw, existing = {}) {
  const base = {
    enabled: true,
    maxEntries: 500,
    maxInjectCharsFull: 8000,
    maxInjectCharsLite: 800,
    retrieveLimit: 20,
    defaultTags: [],
    embeddings: {
      enabled: true,
      backend: 'local',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      providerId: '',
      blendWeight: 0.5,
      queryTimeoutMs: 3000,
      reindexNeeded: false,
    },
    ...existing,
  };

  if (!raw || typeof raw !== 'object') return base;
  const row = /** @type {Record<string, unknown>} */ (raw);

  if (typeof row.enabled === 'boolean') base.enabled = row.enabled;
  if (typeof row.maxEntries === 'number' && Number.isFinite(row.maxEntries)) {
    base.maxEntries = Math.min(5000, Math.max(1, Math.floor(row.maxEntries)));
  }
  if (typeof row.maxInjectCharsFull === 'number' && Number.isFinite(row.maxInjectCharsFull)) {
    base.maxInjectCharsFull = Math.min(32_000, Math.max(200, Math.floor(row.maxInjectCharsFull)));
  }
  if (typeof row.maxInjectCharsLite === 'number' && Number.isFinite(row.maxInjectCharsLite)) {
    base.maxInjectCharsLite = Math.min(8000, Math.max(100, Math.floor(row.maxInjectCharsLite)));
  }
  if (typeof row.retrieveLimit === 'number' && Number.isFinite(row.retrieveLimit)) {
    base.retrieveLimit = Math.min(100, Math.max(1, Math.floor(row.retrieveLimit)));
  }
  if (Array.isArray(row.defaultTags)) {
    base.defaultTags = row.defaultTags
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.slice(0, 64));
  }

  const existingEmb =
    base.embeddings && typeof base.embeddings === 'object'
      ? { .../** @type {Record<string, unknown>} */ (base.embeddings) }
      : {};
  const embRaw =
    row.embeddings && typeof row.embeddings === 'object'
      ? /** @type {Record<string, unknown>} */ (row.embeddings)
      : {};

  if (typeof embRaw.enabled === 'boolean') existingEmb.enabled = embRaw.enabled;
  if (embRaw.backend === 'local' || embRaw.backend === 'provider') {
    existingEmb.backend = embRaw.backend;
  }
  if (typeof embRaw.modelId === 'string') existingEmb.modelId = embRaw.modelId.slice(0, 200);
  if (typeof embRaw.providerId === 'string') existingEmb.providerId = embRaw.providerId.slice(0, 64);
  if (typeof embRaw.blendWeight === 'number' && Number.isFinite(embRaw.blendWeight)) {
    existingEmb.blendWeight = Math.min(1, Math.max(0, embRaw.blendWeight));
  }
  if (typeof embRaw.queryTimeoutMs === 'number' && Number.isFinite(embRaw.queryTimeoutMs)) {
    existingEmb.queryTimeoutMs = Math.min(60_000, Math.max(500, Math.floor(embRaw.queryTimeoutMs)));
  }
  if (typeof embRaw.reindexNeeded === 'boolean') existingEmb.reindexNeeded = embRaw.reindexNeeded;

  const prevEmb =
    existing.embeddings && typeof existing.embeddings === 'object'
      ? /** @type {Record<string, unknown>} */ (existing.embeddings)
      : {};

  if (
    (typeof embRaw.backend === 'string' && embRaw.backend !== prevEmb.backend) ||
    (typeof embRaw.modelId === 'string' && embRaw.modelId !== prevEmb.modelId) ||
    (typeof embRaw.providerId === 'string' && embRaw.providerId !== prevEmb.providerId)
  ) {
    existingEmb.reindexNeeded = true;
  }

  base.embeddings = existingEmb;
  return base;
}

/**
 * @param {unknown} raw
 * @param {Record<string, unknown>} [existing]
 */
export function normalizeSynthesisConfig(raw, existing = {}) {
  const base = {
    enabled: true,
    requireConfirmation: false,
    confidenceThreshold: 0.6,
    autoWriteConfidence: 0.85,
    maxProposalsPerTurn: 3,
    throttleMessagePairs: 4,
    skillMinRounds: 2,
    skillMinToolCalls: 2,
    skillMinOccurrences: 2,
    skillObservationRetentionDays: 45,
    utilityProviderId: '',
    utilityModelId: '',
    maxPendingProposals: 100,
    rejectedRetentionDays: 30,
    includeBoardChats: false,
    ...existing,
  };

  if (!raw || typeof raw !== 'object') return base;
  const row = /** @type {Record<string, unknown>} */ (raw);

  if (typeof row.enabled === 'boolean') base.enabled = row.enabled;
  if (typeof row.includeBoardChats === 'boolean') {
    base.includeBoardChats = row.includeBoardChats;
  }
  if (typeof row.requireConfirmation === 'boolean') {
    base.requireConfirmation = row.requireConfirmation;
  }
  if (typeof row.confidenceThreshold === 'number' && Number.isFinite(row.confidenceThreshold)) {
    base.confidenceThreshold = Math.min(1, Math.max(0, row.confidenceThreshold));
  }
  if (typeof row.autoWriteConfidence === 'number' && Number.isFinite(row.autoWriteConfidence)) {
    base.autoWriteConfidence = Math.min(1, Math.max(0, row.autoWriteConfidence));
  }
  if (typeof row.maxProposalsPerTurn === 'number' && Number.isFinite(row.maxProposalsPerTurn)) {
    base.maxProposalsPerTurn = Math.min(10, Math.max(1, Math.floor(row.maxProposalsPerTurn)));
  }
  if (typeof row.throttleMessagePairs === 'number' && Number.isFinite(row.throttleMessagePairs)) {
    base.throttleMessagePairs = Math.min(20, Math.max(1, Math.floor(row.throttleMessagePairs)));
  }
  if (typeof row.skillMinRounds === 'number' && Number.isFinite(row.skillMinRounds)) {
    base.skillMinRounds = Math.min(10, Math.max(1, Math.floor(row.skillMinRounds)));
  }
  if (typeof row.skillMinToolCalls === 'number' && Number.isFinite(row.skillMinToolCalls)) {
    base.skillMinToolCalls = Math.min(20, Math.max(1, Math.floor(row.skillMinToolCalls)));
  }
  if (typeof row.skillMinOccurrences === 'number' && Number.isFinite(row.skillMinOccurrences)) {
    base.skillMinOccurrences = Math.min(5, Math.max(1, Math.floor(row.skillMinOccurrences)));
  }
  if (
    typeof row.skillObservationRetentionDays === 'number' &&
    Number.isFinite(row.skillObservationRetentionDays)
  ) {
    base.skillObservationRetentionDays = Math.min(
      365,
      Math.max(7, Math.floor(row.skillObservationRetentionDays)),
    );
  }
  if (typeof row.utilityProviderId === 'string') {
    base.utilityProviderId = row.utilityProviderId.trim();
  }
  if (typeof row.utilityModelId === 'string') {
    base.utilityModelId = row.utilityModelId.trim();
  }
  if (typeof row.maxPendingProposals === 'number' && Number.isFinite(row.maxPendingProposals)) {
    base.maxPendingProposals = Math.min(500, Math.max(10, Math.floor(row.maxPendingProposals)));
  }
  if (typeof row.rejectedRetentionDays === 'number' && Number.isFinite(row.rejectedRetentionDays)) {
    base.rejectedRetentionDays = Math.min(365, Math.max(1, Math.floor(row.rejectedRetentionDays)));
  }

  return base;
}

const DEFAULT_SUB_AGENTS = {
  version: 1,
  enabled: true,
  globalMaxConcurrent: 3,
  defaultTimeoutMs: 300000,
  types: {},
};

/**
 * @param {unknown} body
 * @returns {{ config: object, warnings: string[] }}
 */
export function normalizeSubAgentsConfig(body) {
  const warnings = [];
  const base =
    body && typeof body === 'object'
      ? { ...DEFAULT_SUB_AGENTS, .../** @type {Record<string, unknown>} */ (body) }
      : { ...DEFAULT_SUB_AGENTS };

  if (typeof base.enabled !== 'boolean') base.enabled = true;
  if (typeof base.globalMaxConcurrent !== 'number' || base.globalMaxConcurrent < 1) {
    base.globalMaxConcurrent = 3;
  }
  if (typeof base.defaultTimeoutMs !== 'number' || base.defaultTimeoutMs < 1000) {
    base.defaultTimeoutMs = 300000;
  }
  if (typeof base.checkInNudgeMs === 'number' && Number.isFinite(base.checkInNudgeMs)) {
    const rounded = Math.round(base.checkInNudgeMs);
    base.checkInNudgeMs = rounded <= 0 ? 0 : Math.min(1_800_000, Math.max(10_000, rounded));
  } else {
    base.checkInNudgeMs = 120_000;
  }
  if (
    typeof base.duplicateToolCallThreshold === 'number' &&
    Number.isFinite(base.duplicateToolCallThreshold)
  ) {
    base.duplicateToolCallThreshold = Math.min(
      256,
      Math.max(0, Math.round(base.duplicateToolCallThreshold)),
    );
  } else {
    base.duplicateToolCallThreshold = 5;
  }
  delete base.maxToolTurns;
  delete base.defaultMaxToolTurns;
  if (typeof base.version !== 'number') base.version = 1;

  if (!base.types || typeof base.types !== 'object') {
    base.types = {};
  }

  const types = /** @type {Record<string, unknown>} */ (base.types);
  for (const [typeId, rawType] of Object.entries(types)) {
    if (!rawType || typeof rawType !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (rawType);

    const checkToolList = (key) => {
      const list = row[key];
      if (!Array.isArray(list)) return;
      for (const name of list) {
        if (typeof name !== 'string') continue;
        if (!ALL_TOOL_IDS.includes(name)) {
          warnings.push(`Unknown tool id "${name}" in types.${typeId}.${key}`);
        }
      }
    };

    checkToolList('allowedTools');
    checkToolList('deniedTools');

    if (typeof row.providerId === 'string') {
      const pid = row.providerId.trim();
      const mid = typeof row.modelId === 'string' ? row.modelId.trim() : '';
      if (pid === 'lm-studio-local' && !mid) {
        row.providerId = '';
      }
    }

    if (row.maxInputTokens !== undefined) {
      delete row.maxInputTokens;
      warnings.push(`Removed deprecated maxInputTokens for types.${typeId}`);
    }

    const policy = row.contextEnforcementPolicy;
    if (
      policy !== undefined &&
      policy !== 'summarize' &&
      policy !== 'dropMiddle' &&
      policy !== 'slide' &&
      policy !== 'truncate' &&
      policy !== 'archive'
    ) {
      delete row.contextEnforcementPolicy;
      warnings.push(
        `Invalid contextEnforcementPolicy for types.${typeId}; removed`,
      );
    } else if (policy === 'archive') {
      warnings.push(
        `Sub-agent type "${typeId}" uses archive policy; treated as slide at runtime`,
      );
      row.contextEnforcementPolicy = 'slide';
    }

    if (row.archive !== undefined) {
      const normalized = normalizeArchiveConfig(row.archive);
      if (normalized) row.archive = normalized;
      else delete row.archive;
    }

    if (row.minRecentTurns !== undefined) {
      const n = Number(row.minRecentTurns);
      row.minRecentTurns =
        Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
    }

    if (row.summaryReserveTokens !== undefined) {
      const n = Number(row.summaryReserveTokens);
      row.summaryReserveTokens =
        Number.isFinite(n) && n >= 64 ? Math.floor(n) : undefined;
    }

    if (row.summarySchema !== undefined) {
      const schema = String(row.summarySchema).trim();
      if (!schema) {
        delete row.summarySchema;
      } else {
        row.summarySchema = schema.slice(0, 64);
      }
    }

    if (row.sampler !== undefined) {
      const normalized = normalizeSamplerPreset(row.sampler);
      if (normalized === null) {
        delete row.sampler;
      } else if (Object.keys(normalized).length === 0) {
        delete row.sampler;
      } else {
        row.sampler = normalized;
      }
    }

    if (row.thinkingMode !== undefined) {
      const normalized = normalizeThinkingTriState(row.thinkingMode);
      if (!normalized) {
        delete row.thinkingMode;
      } else {
        row.thinkingMode = normalized;
      }
    }

    if (row.thinkingBudgetTokens !== undefined) {
      if (row.thinkingBudgetTokens === null) {
        row.thinkingBudgetTokens = null;
      } else {
        const budget = clampThinkingBudgetTokens(row.thinkingBudgetTokens);
        if (budget === null) delete row.thinkingBudgetTokens;
        else row.thinkingBudgetTokens = budget;
      }
    }

    delete row.maxToolTurns;
  }

  if (base.defaultMaxInputTokens !== undefined) {
    delete base.defaultMaxInputTokens;
    warnings.push('Removed deprecated defaultMaxInputTokens');
  }

  const defaultPolicy = base.defaultContextEnforcementPolicy;
  if (
    defaultPolicy !== undefined &&
    defaultPolicy !== 'summarize' &&
    defaultPolicy !== 'dropMiddle' &&
    defaultPolicy !== 'slide' &&
    defaultPolicy !== 'truncate' &&
    defaultPolicy !== 'archive'
  ) {
    delete base.defaultContextEnforcementPolicy;
  }

  if (base.defaultSummarySchema !== undefined) {
    const schema = String(base.defaultSummarySchema).trim();
    if (!schema) delete base.defaultSummarySchema;
    else base.defaultSummarySchema = schema.slice(0, 64);
  }

  return { config: base, warnings };
}

const SEARCH_PROVIDERS = new Set([
  'searxng',
  'tavily',
  'brave',
  'duckduckgo',
  'disabled',
]);
const SEARCH_FALLBACK_PROVIDERS = new Set(['tavily', 'brave', 'duckduckgo']);

/**
 * @returns {object}
 */
export function defaultSearchConfig() {
  return {
    provider: 'searxng',
    fallbackChain: ['tavily', 'brave', 'duckduckgo'],
    searxngUrl: 'http://localhost:8899',
    keys: { braveApiKey: '', tavilyApiKey: '' },
    resultCount: 10,
  };
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeSearchConfig(raw) {
  const config = defaultSearchConfig();
  if (!raw || typeof raw !== 'object') return config;

  const stored = /** @type {Record<string, unknown>} */ (raw);
  if (typeof stored.provider === 'string' && SEARCH_PROVIDERS.has(stored.provider)) {
    config.provider = stored.provider;
  }

  if (Array.isArray(stored.fallbackChain)) {
    const chain = [];
    for (const item of stored.fallbackChain) {
      if (typeof item === 'string' && SEARCH_FALLBACK_PROVIDERS.has(item) && !chain.includes(item)) {
        chain.push(item);
      }
    }
    if (chain.length > 0) {
      config.fallbackChain = chain;
    }
  }

  if (typeof stored.searxngUrl === 'string') {
    const trimmed = stored.searxngUrl.trim();
    if (trimmed) {
      config.searxngUrl = trimmed.replace(/\/+$/, '');
    }
  }

  if (stored.keys && typeof stored.keys === 'object') {
    const keysMap = /** @type {Record<string, unknown>} */ (stored.keys);
    if (typeof keysMap.braveApiKey === 'string') {
      config.keys.braveApiKey = keysMap.braveApiKey;
    }
    if (typeof keysMap.tavilyApiKey === 'string') {
      config.keys.tavilyApiKey = keysMap.tavilyApiKey;
    }
  }

  config.resultCount = clampInt(stored.resultCount, 1, 50, config.resultCount);
  return config;
}

/**
 * @param {object} toolsConfig
 * @returns {object}
 */
export function seedSearchConfigFromTools(toolsConfig) {
  const providerByTools = {
    brave: 'brave',
    tavily: 'tavily',
    duckduckgo: 'duckduckgo',
  };
  const toolsProvider =
    toolsConfig && typeof toolsConfig.webSearchProvider === 'string'
      ? toolsConfig.webSearchProvider
      : 'duckduckgo';
  const mapped = providerByTools[toolsProvider] ?? 'duckduckgo';
  const keys =
    toolsConfig?.keys && typeof toolsConfig.keys === 'object'
      ? toolsConfig.keys
      : { braveApiKey: '', tavilyApiKey: '' };
  return normalizeSearchConfig({
    provider: mapped,
    keys: {
      braveApiKey: typeof keys.braveApiKey === 'string' ? keys.braveApiKey : '',
      tavilyApiKey: typeof keys.tavilyApiKey === 'string' ? keys.tavilyApiKey : '',
    },
  });
}

/**
 * @returns {object}
 */
export function defaultResearchConfig() {
  return {
    model: { providerId: '', model: '' },
    searchProvider: '',
    maxRounds: 0,
    minRounds: 3,
    maxTimeSeconds: 300,
    runTimeoutSeconds: 1800,
    maxReportTokens: 16384,
    extractionTimeoutSeconds: 90,
    extractionConcurrency: 3,
    maxUrlsPerRound: 3,
    maxContentChars: 15000,
    synthesisWindow: 10,
    maxEmptyRounds: 2,
  };
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
export function normalizeResearchConfig(raw) {
  const config = defaultResearchConfig();
  if (!raw || typeof raw !== 'object') return config;

  const stored = /** @type {Record<string, unknown>} */ (raw);

  if (stored.model && typeof stored.model === 'object') {
    const model = /** @type {Record<string, unknown>} */ (stored.model);
    if (typeof model.providerId === 'string') {
      config.model.providerId = model.providerId.trim();
    }
    if (typeof model.model === 'string') {
      config.model.model = model.model.trim();
    }
  }

  if (typeof stored.searchProvider === 'string') {
    const trimmed = stored.searchProvider.trim();
    if (!trimmed || SEARCH_PROVIDERS.has(trimmed)) {
      config.searchProvider = trimmed;
    }
  }

  config.maxRounds = clampInt(stored.maxRounds, 0, 20, config.maxRounds);
  config.minRounds = clampInt(stored.minRounds, 1, 20, config.minRounds);
  config.maxTimeSeconds = clampInt(stored.maxTimeSeconds, 30, 3600, config.maxTimeSeconds);
  config.runTimeoutSeconds = clampInt(
    stored.runTimeoutSeconds,
    0,
    86_400,
    config.runTimeoutSeconds,
  );
  config.maxReportTokens = clampInt(
    stored.maxReportTokens,
    1024,
    131_072,
    config.maxReportTokens,
  );
  config.extractionTimeoutSeconds = clampInt(
    stored.extractionTimeoutSeconds,
    10,
    600,
    config.extractionTimeoutSeconds,
  );
  config.extractionConcurrency = clampInt(
    stored.extractionConcurrency,
    1,
    20,
    config.extractionConcurrency,
  );
  config.maxUrlsPerRound = clampInt(stored.maxUrlsPerRound, 1, 20, config.maxUrlsPerRound);
  config.maxContentChars = clampInt(
    stored.maxContentChars,
    1000,
    100_000,
    config.maxContentChars,
  );
  config.synthesisWindow = clampInt(stored.synthesisWindow, 1, 50, config.synthesisWindow);
  config.maxEmptyRounds = clampInt(stored.maxEmptyRounds, 1, 10, config.maxEmptyRounds);

  return config;
}

const MANAGED_SERVER_IDS = ['searxng', 'llama-cpp', 'mlx-lm'];

const DEFAULT_SERVER_PORTS = {
  searxng: 8899,
  'llama-cpp': 8085,
  'mlx-lm': 8087,
};

/**
 * @returns {Record<string, { enabled: boolean, autoStart: boolean, port: number }>}
 */
export function defaultServersConfig() {
  return {
    searxng: {
      enabled: true,
      autoStart: true,
      port: DEFAULT_SERVER_PORTS.searxng,
    },
    'llama-cpp': {
      enabled: true,
      autoStart: false,
      port: DEFAULT_SERVER_PORTS['llama-cpp'],
    },
    'mlx-lm': {
      enabled: true,
      autoStart: false,
      port: DEFAULT_SERVER_PORTS['mlx-lm'],
    },
  };
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function coerceBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return fallback;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, { enabled: boolean, autoStart: boolean, port: number }>}
 */
export function normalizeServersConfig(raw) {
  const config = defaultServersConfig();
  if (!raw || typeof raw !== 'object') return config;

  const stored = /** @type {Record<string, unknown>} */ (raw);
  for (const id of MANAGED_SERVER_IDS) {
    const entry = stored[id];
    if (!entry || typeof entry !== 'object') continue;

    const row = /** @type {Record<string, unknown>} */ (entry);
    const base = config[id];
    const defaultPort = DEFAULT_SERVER_PORTS[id] ?? 8899;

    config[id] = {
      enabled: coerceBool(row.enabled, base.enabled),
      autoStart: coerceBool(row.autoStart, base.autoStart),
      port: clampInt(row.port, 1024, 65_535, defaultPort),
    };
  }

  return config;
}
