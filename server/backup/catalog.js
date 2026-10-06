/**
 * What a Minnow backup contains.
 *
 * A backup is a list of **roots** — top-level entries of the Minnow home — grouped
 * into user-facing categories. Restore swaps roots wholesale, so a root is never
 * nested inside another root. Anything not listed here is not backed up: the home
 * also holds caches, logs, installed runtimes and git worktrees that are either
 * regenerable or far too large to archive (see {@link NEVER_BACKED_UP}).
 *
 * This module is pure data + path predicates. `restore-apply.js` imports it at
 * boot before anything else touches the home, so it must not import stores.
 */

/**
 * @typedef {{
 *   path: string,
 *   exclude?: string[],
 *   omit?: string[],
 *   secrets?: boolean,
 *   skipDirNames?: string[],
 * }} BackupRootSpec
 * `path` is home-relative with forward slashes. `exclude` lists root-relative
 * subpaths left out of the archive and kept from the existing home on restore
 * (caches and indexes that stay valid). `omit` lists subpaths left out and *not*
 * kept — recovery copies of the data being replaced, which would otherwise
 * resurface as the wrong timeline. `secrets` marks roots whose JSON files may hold
 * secret-box envelopes or plaintext keys. `skipDirNames` drops dependency
 * folders anywhere inside the root.
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   description: string,
 *   defaultOn: boolean,
 *   requiresPassphrase?: boolean,
 *   roots: BackupRootSpec[],
 * }} BackupCategory
 */

/** Category that carries `.key` and everything encrypted under it. */
export const CREDENTIALS_CATEGORY = 'credentials';

/** @type {BackupCategory[]} */
export const BACKUP_CATEGORIES = [
  {
    id: 'settings',
    label: 'Settings and preferences',
    description:
      'Preferences, appearance, tool permissions, provider profiles, MCP and language servers, prompts, rules and agents.',
    defaultOn: true,
    roots: [
      { path: 'config.json', secrets: true },
      { path: 'appearance.json' },
      { path: 'default-model.json' },
      { path: 'model-reasoning-defaults.json' },
      { path: 'tools.json', secrets: true },
      { path: 'search.json', secrets: true },
      { path: 'servers.json', secrets: true },
      { path: 'research.json', secrets: true },
      { path: 'rules.json' },
      { path: 'system-prompt.json' },
      { path: 'sub-agents.json' },
      { path: 'work-agents.json' },
      { path: 'skills.json' },
      { path: 'agent-packs.json' },
      { path: 'lsp.json', secrets: true },
      { path: 'lsp', secrets: true },
      { path: 'mcp.json', secrets: true },
      { path: 'llama-cpp.json', secrets: true },
      { path: 'mtplx.json', secrets: true },
      { path: 'onboarding.json' },
      { path: 'updater.json' },
      { path: 'backup.json', secrets: true },
      { path: 'providers', secrets: true },
      { path: 'mcp', secrets: true },
      { path: 'prompts' },
      { path: 'prompt-configs' },
      { path: 'profiles' },
      { path: 'model-routers' },
    ],
  },
  {
    id: CREDENTIALS_CATEGORY,
    label: 'Credentials and encryption key',
    description:
      'API keys, sign-in tokens, connection secrets and scheduled-job prompts, plus the key that unlocks them.',
    defaultOn: true,
    requiresPassphrase: true,
    roots: [
      { path: '.key' },
      { path: 'oauth', secrets: true },
      { path: 'auth', secrets: true },
      { path: 'webhooks.json', secrets: true },
      { path: 'webhooks', secrets: true },
    ],
  },
  {
    id: 'chats',
    label: 'Chats and usage history',
    description: 'Every conversation, sub-agent transcripts, plan drafts and usage statistics.',
    defaultOn: true,
    roots: [
      { path: 'sessions', omit: ['snapshots', 'state.json.backup', 'state.json.migrated'] },
      { path: 'agents' },
      { path: 'superplan' },
      { path: 'activity' },
    ],
  },
  {
    id: 'brain',
    label: 'Brain and memory',
    description: 'Wiki pages, memories, ingested sources and search vectors. Code indexes are rebuilt, not saved.',
    defaultOn: true,
    roots: [
      { path: 'brain', exclude: ['code'], omit: ['.cleanup'] },
      { path: 'memory' },
    ],
  },
  {
    id: 'issues',
    label: 'Issues and reviews',
    description: 'The issue tracker with its attachments and taxonomy, and in-app pull request reviews.',
    defaultOn: true,
    roots: [
      { path: 'issues', omit: ['backups'] },
      // Pre-Issues bug tracker blob: only read once to migrate, but it is the
      // user's data until that has happened.
      { path: 'bugs' },
      { path: 'reviews' },
    ],
  },
  {
    id: 'boards',
    label: 'Boards',
    description: 'Orchestrate board journals and their run transcripts.',
    defaultOn: true,
    roots: [{ path: 'boards' }],
  },
  {
    id: 'scheduler',
    label: 'Scheduled jobs',
    description: 'Scheduler jobs and their run history. Job prompts are encrypted, so they travel with credentials.',
    defaultOn: true,
    roots: [
      { path: 'scheduler.json', secrets: true },
      { path: 'scheduler-runs' },
      { path: 'scheduler-workspace' },
    ],
  },
  {
    id: 'extensions',
    label: 'Skills, plugins and agent packs',
    description: 'Installed skills, plugin packages with their data, and agent packs.',
    defaultOn: true,
    roots: [
      { path: 'skills' },
      { path: 'plugins', secrets: true },
      { path: 'agent-packs' },
      { path: 'tools' },
    ],
  },
  {
    id: 'sandbox',
    label: 'Sandbox files',
    description: 'Files in the Sandbox workspace used by chats without a project folder. Dependency folders are skipped.',
    defaultOn: true,
    roots: [
      { path: 'workspace', skipDirNames: ['node_modules', '.venv', 'venv', '__pycache__'] },
      { path: 'chats', skipDirNames: ['node_modules', '.venv', 'venv', '__pycache__'] },
    ],
  },
  {
    id: 'other',
    label: 'Other saved data',
    description: 'Saved reports and run history from the rest of Minnow.',
    defaultOn: true,
    roots: [
      { path: 'research', exclude: ['cache'] },
      { path: 'compare' },
      { path: 'benchmarks' },
      { path: 'evals' },
    ],
  },
  {
    id: 'models',
    label: 'Downloaded models',
    description: 'Model files under models/. Large, and re-downloadable from the Models app.',
    defaultOn: false,
    roots: [{ path: 'models' }],
  },
];

/**
 * Home entries a backup never contains: logs, caches, per-boot state, installed
 * runtimes and git worktrees. Exclusion is by omission from the catalog; this
 * list exists so the choice is written down. `test/backup/catalog.test.mjs`
 * fails when the server starts using a home entry that is in neither list.
 */
export const NEVER_BACKED_UP = [
  'cli-sessions',
  'logs',
  'debug',
  'tmp',
  'run',
  'runs',
  'screenshots',
  'tts-cache',
  'generations',
  'browser-profiles',
  'worktrees',
  'backups',
  'lsp-servers',
  'servers',
  'models-runtime',
  'runtimes',
  'voice',
  'benchmark-workspace',
  'session-token',
  'scheduler-notifications.json',
  'webhooks-deliveries.json',
];

/** Home-relative names owned by backup/restore itself. */
export const RESTORE_STAGING_DIRNAME = 'restore-staging';
export const PRE_RESTORE_DIRNAME = 'pre-restore';
export const RESTORE_PENDING_FILENAME = 'restore-pending.json';
export const RESTORE_LAST_FILENAME = 'restore-last.json';

/** Restore bookkeeping: never archived, never swapped. */
export const RESTORE_OWN_ENTRIES = [
  RESTORE_STAGING_DIRNAME,
  PRE_RESTORE_DIRNAME,
  RESTORE_PENDING_FILENAME,
  RESTORE_LAST_FILENAME,
];

/** Basename patterns that are never archived wherever they appear. */
const JUNK_NAME_PATTERNS = [
  /^\.gitkeep$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/i,
  /\.tmp-\d+-\d+$/,
  /-wal$/,
  /-shm$/,
  /\.partial$/,
  /\.corrupt-[\w-]+(\.bin)?$/,
  /\.bak-[\w.-]+$/,
];

/**
 * Paths that hold credentials whichever root they sit in. Files matching these
 * ride with the credentials category, like any file carrying a secret-box envelope.
 */
const CREDENTIAL_PATH_PATTERNS = [
  /^\.key$/,
  /^oauth\//,
  /^auth\//,
  /^webhooks\.json$/,
  /^webhooks\//,
  /^mcp\/secrets\.json$/,
  /^mcp\/oauth\//,
  /^providers\/[^/]+\/secrets\.json$/,
  /^plugins\/connections\//,
];

/** @param {string} name */
export function isJunkName(name) {
  return JUNK_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** @param {string} relPath home-relative, forward slashes */
export function isCredentialPath(relPath) {
  return CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

/** @returns {string[]} */
export function allCategoryIds() {
  return BACKUP_CATEGORIES.map((category) => category.id);
}

/** @returns {string[]} */
export function defaultCategoryIds() {
  return BACKUP_CATEGORIES.filter((category) => category.defaultOn).map((category) => category.id);
}

/** @param {string} id */
export function getCategory(id) {
  return BACKUP_CATEGORIES.find((category) => category.id === id) ?? null;
}

/**
 * Keep known ids, in catalog order, without duplicates.
 * @param {unknown} ids
 * @param {string[]} [fallback]
 * @returns {string[]}
 */
export function normalizeCategoryIds(ids, fallback = defaultCategoryIds()) {
  if (!Array.isArray(ids)) return [...fallback];
  const wanted = new Set(ids.map((id) => String(id)));
  return allCategoryIds().filter((id) => wanted.has(id));
}

/** @type {Map<string, { category: string, spec: BackupRootSpec }> | null} */
let rootIndex = null;

function getRootIndex() {
  if (rootIndex) return rootIndex;
  rootIndex = new Map();
  for (const category of BACKUP_CATEGORIES) {
    for (const spec of category.roots) {
      rootIndex.set(spec.path, { category: category.id, spec });
    }
  }
  return rootIndex;
}

/**
 * Catalog root for a home-relative root path.
 * @param {string} rootPath
 */
export function findRoot(rootPath) {
  return getRootIndex().get(rootPath) ?? null;
}

/**
 * The catalog root a home-relative file path belongs to.
 * @param {string} relPath
 */
export function findRootForPath(relPath) {
  const top = relPath.split('/')[0];
  const hit = getRootIndex().get(top);
  if (!hit) return null;
  return { rootPath: top, ...hit };
}

/**
 * True when `relPath` (home-relative) sits under one of the root's `exclude` or
 * `omit` subpaths, so it is not archived.
 * @param {BackupRootSpec} spec
 * @param {string} relPath
 */
export function isExcludedByRoot(spec, relPath) {
  const subpaths = [...(spec.exclude ?? []), ...(spec.omit ?? [])];
  if (!subpaths.length) return false;
  const inner = relPath === spec.path ? '' : relPath.slice(spec.path.length + 1);
  if (!inner) return false;
  return subpaths.some((sub) => inner === sub || inner.startsWith(`${sub}/`));
}
