/**
 * Issues taxonomy — types, defaults, validation, and role helpers (MIN-261).
 * User-editable catalog for issue types, statuses, and priorities.
 */

import {
  DEFAULT_ISSUE_STATUS_ICONS,
  DEFAULT_ISSUE_TYPE_COLORS,
  DEFAULT_ISSUE_TYPE_ICONS,
  isIssueTypeIconClass,
} from './type-icons.ts';

// ── Types ────────────────────────────────────────────────────────────────────

/** Semantic workflow roles mapped onto status ids at runtime. */
export type IssueStatusRole =
  | 'triage'
  | 'backlog'
  | 'todo'
  | 'planned'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'canceled';

/** Shared shape for type and priority catalog entries. */
export type TaxonomyItem = {
  id: string;
  label: string;
  order: number;
  /** Optional chip color (CSS token name or hex from the fixed palette). */
  color?: string;
  /** Optional Uicons class for type/status chips (e.g. fi-sr-bug). Settings → Issues picker only. */
  icon?: string;
};

/** Status catalog entry with workflow and board metadata. */
export type StatusItem = TaxonomyItem & {
  /** At most one status per role; workflows resolve roles at runtime. */
  role?: IssueStatusRole;
  /** Closed statuses are hidden when "Hide done" is on and excluded from open counts. */
  isClosed?: boolean;
  /** When true, status appears as a kanban column on the Issues board. */
  boardVisible?: boolean;
};

/**
 * One-shot seed for built-in types added after first ship (Feature / Improvement).
 * Increment when adding new default type ids that existing catalogs should receive once.
 */
export const ISSUE_TYPE_SEED_REVISION = 2;

/** One-shot migration for board visibility defaults added after first ship. */
export const ISSUE_BOARD_SEED_REVISION = 1;

/** Persisted taxonomy catalog (Settings → Issues). */
export type IssuesTaxonomy = {
  version: 1;
  /** Last applied built-in type seed; omit on legacy files (treated as 1). */
  typeSeedRevision?: number;
  /** Last applied board visibility seed; omit on catalogs created before Backlog shipped visible. */
  boardSeedRevision?: number;
  types: TaxonomyItem[];
  statuses: StatusItem[];
  priorities: TaxonomyItem[];
};

export const TAXONOMY_SLUG_RE = /^[a-z][a-z0-9_]*$/;

export const ISSUE_STATUS_ROLES: readonly IssueStatusRole[] = [
  'triage',
  'backlog',
  'todo',
  'planned',
  'in_progress',
  'review',
  'done',
  'canceled',
] as const;

/** Settings picker + stored chip colors (CSS tokens or hex). */
export const TAXONOMY_COLOR_PALETTE = [
  'var(--mn-danger)',
  'var(--mn-accent)',
  'var(--mn-warning)',
  'var(--mn-success)',
  'var(--mn-fg-muted)',
  'var(--mn-label-fig)',
  'var(--mn-label-kelp)',
  'var(--mn-label-dusk)',
  'var(--mn-label-tide)',
  'var(--mn-label-apricot)',
] as const;

const TAXONOMY_COLOR_SET = new Set<string>(TAXONOMY_COLOR_PALETTE);

/** Token or hex stored on taxonomy rows (no arbitrary CSS). */
export const TAXONOMY_COLOR_RE = /^(var\(--mn-[a-z0-9-]+\)|#[0-9a-fA-F]{3,8})$/;

/** True when a stored color is a palette entry or a safe hex/token. */
export function isTaxonomyColor(value: string): boolean {
  const color = value.trim();
  if (!color) return false;
  if (TAXONOMY_COLOR_SET.has(color)) return true;
  return TAXONOMY_COLOR_RE.test(color);
}

/** Next unused palette swatch so a new custom type is not grey. */
export function pickNextTaxonomyColor(used: readonly (string | undefined)[]): string {
  const taken = new Set(used.filter((c): c is string => Boolean(c?.trim())));
  for (const color of TAXONOMY_COLOR_PALETTE) {
    if (!taken.has(color)) return color;
  }
  return TAXONOMY_COLOR_PALETTE[taken.size % TAXONOMY_COLOR_PALETTE.length];
}

function readCatalogColor(
  kind: 'types' | 'statuses' | 'priorities',
  id: string,
  row: Record<string, unknown>,
  errors: TaxonomyValidationError[],
): string | undefined {
  if (typeof row.color !== 'string' || !row.color.trim()) return undefined;
  const color = row.color.trim();
  if (!isTaxonomyColor(color)) {
    errors.push({
      field: `${kind}.${id}.color`,
      message: `Unknown ${kind.slice(0, -1)} color "${color}"`,
    });
    return undefined;
  }
  return color;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Seed defaults matching the original hardcoded unions. */
export function createDefaultIssuesTaxonomy(): IssuesTaxonomy {
  return {
    version: 1,
    typeSeedRevision: ISSUE_TYPE_SEED_REVISION,
    boardSeedRevision: ISSUE_BOARD_SEED_REVISION,
    types: [
      {
        id: 'bug',
        label: 'Bug',
        order: 0,
        icon: DEFAULT_ISSUE_TYPE_ICONS.bug,
        color: DEFAULT_ISSUE_TYPE_COLORS.bug,
      },
      {
        id: 'task',
        label: 'Task',
        order: 1,
        icon: DEFAULT_ISSUE_TYPE_ICONS.task,
        color: DEFAULT_ISSUE_TYPE_COLORS.task,
      },
      {
        id: 'idea',
        label: 'Idea',
        order: 2,
        icon: DEFAULT_ISSUE_TYPE_ICONS.idea,
        color: DEFAULT_ISSUE_TYPE_COLORS.idea,
      },
      {
        id: 'note',
        label: 'Note',
        order: 3,
        icon: DEFAULT_ISSUE_TYPE_ICONS.note,
        color: DEFAULT_ISSUE_TYPE_COLORS.note,
      },
      {
        id: 'feature',
        label: 'Feature',
        order: 4,
        icon: DEFAULT_ISSUE_TYPE_ICONS.feature,
        color: DEFAULT_ISSUE_TYPE_COLORS.feature,
      },
      {
        id: 'improvement',
        label: 'Improvement',
        order: 5,
        icon: DEFAULT_ISSUE_TYPE_ICONS.improvement,
        color: DEFAULT_ISSUE_TYPE_COLORS.improvement,
      },
    ],
    statuses: [
      {
        id: 'triage',
        label: 'Triage',
        order: 0,
        role: 'triage',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.triage,
      },
      {
        id: 'backlog',
        label: 'Backlog',
        order: 1,
        role: 'backlog',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.backlog,
      },
      {
        id: 'todo',
        label: 'Todo',
        order: 2,
        role: 'todo',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.todo,
      },
      {
        id: 'planned',
        label: 'Planned',
        order: 3,
        role: 'planned',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.planned,
      },
      {
        id: 'in_progress',
        label: 'In progress',
        order: 4,
        role: 'in_progress',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.in_progress,
      },
      {
        id: 'review',
        label: 'Review',
        order: 5,
        role: 'review',
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.review,
      },
      {
        id: 'done',
        label: 'Done',
        order: 6,
        role: 'done',
        isClosed: true,
        boardVisible: true,
        icon: DEFAULT_ISSUE_STATUS_ICONS.done,
      },
      {
        id: 'canceled',
        label: 'Canceled',
        order: 7,
        role: 'canceled',
        isClosed: true,
        boardVisible: false,
        icon: DEFAULT_ISSUE_STATUS_ICONS.canceled,
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

export type TaxonomyValidationError = { field: string; message: string };

export type ValidateTaxonomyOptions = {
  /** When set, block removal of ids still referenced by issues. */
  previous?: IssuesTaxonomy;
  /** Issue cards to check for in-use ids on delete. */
  issues?: Array<{ type: string; status: string; priority: string }>;
};

/** True when id matches slug format [a-z][a-z0-9_]*. */
export function isTaxonomySlug(id: string): boolean {
  return TAXONOMY_SLUG_RE.test(id.trim());
}

function sortByOrder<T extends TaxonomyItem>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Parse a picker icon from a taxonomy row; unknown classes become validation errors. */
function readCatalogIcon(
  kind: 'types' | 'statuses',
  id: string,
  row: Record<string, unknown>,
  errors: TaxonomyValidationError[],
): string | undefined {
  if (typeof row.icon !== 'string' || !row.icon.trim()) return undefined;
  const icon = row.icon.trim();
  if (!isIssueTypeIconClass(icon)) {
    errors.push({
      field: `${kind}.${id}.icon`,
      message: `Unknown ${kind === 'types' ? 'type' : 'status'} icon "${icon}"`,
    });
    return undefined;
  }
  return icon;
}

function validateItemList(
  kind: 'types' | 'statuses' | 'priorities',
  items: unknown[],
  errors: TaxonomyValidationError[],
): TaxonomyItem[] | StatusItem[] {
  const out: TaxonomyItem[] = [];
  const seen = new Set<string>();

  if (!items.length) {
    errors.push({ field: kind, message: `${kind} must include at least one item` });
    return out;
  }

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object') {
      errors.push({ field: kind, message: `Invalid ${kind} entry at index ${i}` });
      continue;
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const order = typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : i;

    if (!id || !isTaxonomySlug(id)) {
      errors.push({
        field: `${kind}.${i}.id`,
        message: `Id must match [a-z][a-z0-9_]* (got "${id || '(empty)'}")`,
      });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ field: `${kind}.${id}`, message: `Duplicate id "${id}"` });
      continue;
    }
    if (!label) {
      errors.push({ field: `${kind}.${id}`, message: 'Label is required' });
      continue;
    }
    seen.add(id);

    if (kind === 'statuses') {
      const status: StatusItem = { id, label, order };
      const color = readCatalogColor('statuses', id, row, errors);
      if (color) status.color = color;
      const icon = readCatalogIcon('statuses', id, row, errors);
      if (icon) status.icon = icon;
      if (typeof row.role === 'string' && row.role.trim()) {
        const role = row.role.trim() as IssueStatusRole;
        if (!(ISSUE_STATUS_ROLES as readonly string[]).includes(role)) {
          errors.push({ field: `${kind}.${id}.role`, message: `Unknown role "${role}"` });
        } else {
          status.role = role;
        }
      }
      if (row.isClosed === true) status.isClosed = true;
      if (row.boardVisible === true) status.boardVisible = true;
      if (row.boardVisible === false) status.boardVisible = false;
      out.push(status);
      continue;
    }

    const item: TaxonomyItem = { id, label, order };
    const color = readCatalogColor(kind, id, row, errors);
    if (color) item.color = color;
    if (kind === 'types') {
      const icon = readCatalogIcon('types', id, row, errors);
      if (icon) item.icon = icon;
    }
    out.push(item);
  }

  return sortByOrder(out);
}

// ── Validate ─────────────────────────────────────────────────────────────────

/** Normalize and validate a taxonomy payload; throws on hard errors. */
export function validateIssuesTaxonomy(
  raw: unknown,
  options: ValidateTaxonomyOptions = {},
): IssuesTaxonomy {
  const errors: TaxonomyValidationError[] = [];

  if (!raw || typeof raw !== 'object') {
    return createDefaultIssuesTaxonomy();
  }

  const row = raw as Record<string, unknown>;
  if (row.version !== 1) {
    errors.push({ field: 'version', message: 'version must be 1' });
  }

  const types = validateItemList('types', Array.isArray(row.types) ? row.types : [], errors);
  const statuses = validateItemList(
    'statuses',
    Array.isArray(row.statuses) ? row.statuses : [],
    errors,
  ) as StatusItem[];
  const priorities = validateItemList(
    'priorities',
    Array.isArray(row.priorities) ? row.priorities : [],
    errors,
  );

  const roleSeen = new Map<IssueStatusRole, string>();
  for (const status of statuses) {
    if (!status.role) continue;
    const prior = roleSeen.get(status.role);
    if (prior) {
      errors.push({
        field: `statuses.${status.id}.role`,
        message: `Role "${status.role}" is already assigned to "${prior}"`,
      });
    } else {
      roleSeen.set(status.role, status.id);
    }
  }

  if (options.previous && options.issues?.length) {
    const removed = collectRemovedIds(options.previous, {
      version: 1,
      types,
      statuses,
      priorities,
    });
    for (const [kind, ids] of Object.entries(removed)) {
      for (const id of ids) {
        const count = countIssuesUsingTaxonomyId(
          kind as 'type' | 'status' | 'priority',
          id,
          options.issues,
        );
        if (count > 0) {
          errors.push({
            field: `${kind}s.${id}`,
            message: `Used by ${count} issue${count === 1 ? '' : 's'} — reassign first`,
          });
        }
      }
    }
  }

  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join('; '));
  }

  const typeSeedRevision = readSeedRevision(row.typeSeedRevision, 1);
  const boardSeedRevision = readSeedRevision(row.boardSeedRevision, 0);
  return { version: 1, typeSeedRevision, boardSeedRevision, types, statuses, priorities };
}

function readSeedRevision(raw: unknown, minimum: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  return n >= minimum ? n : undefined;
}

/**
 * Append Feature / Improvement when an older catalog has not received that seed yet.
 * After revision 2 is stored, deleting those ids is not undone on the next load.
 */
export function seedDefaultIssueTypes(taxonomy: IssuesTaxonomy): IssuesTaxonomy {
  const revision = taxonomy.typeSeedRevision ?? 1;
  if (revision >= ISSUE_TYPE_SEED_REVISION) {
    return taxonomy.typeSeedRevision ? taxonomy : { ...taxonomy, typeSeedRevision: revision };
  }

  const defaults = createDefaultIssuesTaxonomy();
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
    types: sortByOrder(nextTypes),
  };
}

/**
 * Reveal Backlog once for catalogs created with the old hidden-by-default board.
 * Once the revision is stored, a user can hide the lane again without it being
 * re-enabled on the next load.
 */
export function seedDefaultBoardVisibility(taxonomy: IssuesTaxonomy): IssuesTaxonomy {
  if ((taxonomy.boardSeedRevision ?? 0) >= ISSUE_BOARD_SEED_REVISION) return taxonomy;
  return {
    ...taxonomy,
    boardSeedRevision: ISSUE_BOARD_SEED_REVISION,
    statuses: taxonomy.statuses.map((status) =>
      status.role === 'backlog' ? { ...status, boardVisible: true } : status,
    ),
  };
}

function collectRemovedIds(
  previous: IssuesTaxonomy,
  next: IssuesTaxonomy,
): Record<'type' | 'status' | 'priority', string[]> {
  const prevTypeIds = new Set(previous.types.map((t) => t.id));
  const nextTypeIds = new Set(next.types.map((t) => t.id));
  const prevStatusIds = new Set(previous.statuses.map((s) => s.id));
  const nextStatusIds = new Set(next.statuses.map((s) => s.id));
  const prevPriorityIds = new Set(previous.priorities.map((p) => p.id));
  const nextPriorityIds = new Set(next.priorities.map((p) => p.id));

  return {
    type: [...prevTypeIds].filter((id) => !nextTypeIds.has(id)),
    status: [...prevStatusIds].filter((id) => !nextStatusIds.has(id)),
    priority: [...prevPriorityIds].filter((id) => !nextPriorityIds.has(id)),
  };
}

/** Count issues referencing a taxonomy id. */
export function countIssuesUsingTaxonomyId(
  kind: 'type' | 'status' | 'priority',
  id: string,
  issues: Array<{ type: string; status: string; priority: string }>,
): number {
  let n = 0;
  for (const issue of issues) {
    const value = kind === 'type' ? issue.type : kind === 'status' ? issue.status : issue.priority;
    if (value === id) n += 1;
  }
  return n;
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Sorted catalog helpers for UI and guards. */
export function sortedTypes(taxonomy: IssuesTaxonomy): TaxonomyItem[] {
  return sortByOrder(taxonomy.types);
}

export function sortedStatuses(taxonomy: IssuesTaxonomy): StatusItem[] {
  return sortByOrder(taxonomy.statuses);
}

export function sortedPriorities(taxonomy: IssuesTaxonomy): TaxonomyItem[] {
  return sortByOrder(taxonomy.priorities);
}

export function findType(taxonomy: IssuesTaxonomy, id: string): TaxonomyItem | undefined {
  return taxonomy.types.find((t) => t.id === id);
}

export function findStatus(taxonomy: IssuesTaxonomy, id: string): StatusItem | undefined {
  return taxonomy.statuses.find((s) => s.id === id);
}

export function findPriority(taxonomy: IssuesTaxonomy, id: string): TaxonomyItem | undefined {
  return taxonomy.priorities.find((p) => p.id === id);
}

export function isKnownIssueType(taxonomy: IssuesTaxonomy, id: string): boolean {
  return Boolean(findType(taxonomy, id));
}

export function isKnownIssueStatus(taxonomy: IssuesTaxonomy, id: string): boolean {
  return Boolean(findStatus(taxonomy, id));
}

export function isKnownIssuePriority(taxonomy: IssuesTaxonomy, id: string): boolean {
  return Boolean(findPriority(taxonomy, id));
}

/** Resolve the status id carrying a workflow role; undefined when unassigned. */
export function statusIdForRole(
  taxonomy: IssuesTaxonomy,
  role: IssueStatusRole,
): string | undefined {
  return taxonomy.statuses.find((s) => s.role === role)?.id;
}

/** Require a role-bearing status id; throws with a Settings hint when missing. */
export function requireStatusIdForRole(
  taxonomy: IssuesTaxonomy,
  role: IssueStatusRole,
): string {
  const id = statusIdForRole(taxonomy, role);
  if (!id) {
    throw new Error(
      `No status with role ${role} — assign one in Settings → Issues`,
    );
  }
  return id;
}

/** True when the status is marked closed (or carries the done/canceled role as fallback). */
export function isClosedStatus(taxonomy: IssuesTaxonomy, statusId: string): boolean {
  const status = findStatus(taxonomy, statusId);
  if (!status) return false;
  if (status.isClosed) return true;
  return status.role === 'done' || status.role === 'canceled';
}

/** Status ids counted as open for sidebar badge and filters. */
export function openIssueStatusIds(taxonomy: IssuesTaxonomy): string[] {
  return taxonomy.statuses.filter((s) => !isClosedStatus(taxonomy, s.id)).map((s) => s.id);
}

/** Board column statuses in display order. */
export function boardStatuses(taxonomy: IssuesTaxonomy): StatusItem[] {
  return sortedStatuses(taxonomy).filter((s) => s.boardVisible !== false);
}

/** Default type id (task when present, else first). */
export function defaultIssueTypeId(taxonomy: IssuesTaxonomy): string {
  if (findType(taxonomy, 'task')) return 'task';
  return sortedTypes(taxonomy)[0]?.id ?? 'task';
}

/** Default status id (triage role, else first status). */
export function defaultIssueStatusId(taxonomy: IssuesTaxonomy): string {
  return statusIdForRole(taxonomy, 'triage') ?? sortedStatuses(taxonomy)[0]?.id ?? 'triage';
}

/** Default priority id (none when present, else first). */
export function defaultIssuePriorityId(taxonomy: IssuesTaxonomy): string {
  const none = findPriority(taxonomy, 'none');
  if (none) return 'none';
  return sortedPriorities(taxonomy)[0]?.id ?? 'none';
}

/** True when a status carries the triage role. */
export function isTriageStatus(taxonomy: IssuesTaxonomy, statusId: string): boolean {
  const status = findStatus(taxonomy, statusId);
  return status?.role === 'triage';
}

/** True when a status carries the review role. */
export function isReviewStatus(taxonomy: IssuesTaxonomy, statusId: string): boolean {
  const status = findStatus(taxonomy, statusId);
  return status?.role === 'review';
}

/** True when a status carries the in_progress role. */
export function isInProgressStatus(taxonomy: IssuesTaxonomy, statusId: string): boolean {
  const status = findStatus(taxonomy, statusId);
  return status?.role === 'in_progress';
}

/** Comma-separated allowed ids for tool validation errors. */
export function formatAllowedIds(items: TaxonomyItem[]): string {
  return items.map((i) => i.id).join(', ');
}

/** Auto-slug a label for new taxonomy entries. */
export function slugifyTaxonomyLabel(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!base) return '';
  const withPrefix = /^[a-z]/.test(base) ? base : `x_${base}`;
  return withPrefix.slice(0, 48);
}
