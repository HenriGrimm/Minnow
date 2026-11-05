/**
 * Brain wiki paths under ~/.minnow/brain/ and page path sandbox.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { realpathForBoundaryCheck } from '../workspace/safe-path.js';
import { getMinnowHome } from '../config/home.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Typed error for rejected page paths (traversal, invalid extension, etc.). */
export class BrainPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrainPathError';
  }
}

/** Brain root directory (~/.minnow/brain/). */
export function getBrainDir() {
  return path.join(getMinnowHome(), 'brain');
}

/** Wiki page tree root. */
export function getBrainPagesDir() {
  return path.join(getBrainDir(), 'pages');
}

/** Raw ingested non-code sources (immutable). */
export function getBrainSourcesDir() {
  return path.join(getBrainDir(), 'sources');
}

/** Derived code index artifacts (MIN-B7). */
export function getBrainCodeDir() {
  return path.join(getBrainDir(), 'code');
}

/** Rebuildable page metadata cache. */
export function getCatalogPath() {
  return path.join(getBrainDir(), 'catalog.json');
}

/** LLM-maintained wiki index view. */
export function getBrainIndexPath() {
  return path.join(getBrainDir(), 'index.md');
}

/** Append-only changelog. */
export function getBrainLogPath() {
  return path.join(getBrainDir(), 'log.md');
}

/** Routing conventions and schema doc. */
export function getBrainSchemaPath() {
  return path.join(getBrainDir(), 'schema.md');
}

/** Migration / bootstrap state. */
export function getBrainStatePath() {
  return path.join(getBrainDir(), 'state.json');
}

/** Persisted wiki cleanup plans (LLM-generated, review-only). */
export function getBrainCleanupDir() {
  return path.join(getBrainDir(), '.cleanup');
}

/** Validate page id (UUID v4 style). */
export function isValidPageId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/**
 * Derive a stable wiki workspace key from an absolute workspace root.
 * Matches pages/workspaces/<key>/ folder names (basename slug).
 * @param {string} workspacePath
 * @returns {string}
 */
export function brainWorkspaceKeyFromPath(workspacePath) {
  const trimmed = String(workspacePath ?? '').trim();
  if (!trimmed) return '';
  const base = path.basename(path.resolve(trimmed));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workspace';
}

/**
 * Reject unsafe relative page paths before joining under pages/.
 * @param {string} relPath
 */
export function assertSafeRelativePagePath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new BrainPathError('Page path is required');
  }
  if (relPath.includes('\0')) {
    throw new BrainPathError('Page path contains null bytes');
  }
  if (path.isAbsolute(relPath)) {
    throw new BrainPathError('Page path must be relative');
  }
  if (/^[a-zA-Z]:[/\\]/.test(relPath)) {
    throw new BrainPathError('Page path must not include a drive letter');
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new BrainPathError('Page path must not start with a slash');
  }

  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '..') {
      throw new BrainPathError('Page path must not contain parent segments');
    }
  }

  if (!/\.md$/i.test(normalized)) {
    throw new BrainPathError('Page path must end with .md');
  }
  return normalized;
}

/**
 * Resolve a relative page path under pages/ with realpath containment check.
 * Skip a pre-realpath path.relative check — Windows CI mixes 8.3 and long paths.
 * @param {string} relPath — e.g. facts/my-note.md
 * @returns {Promise<string>} Absolute path inside the pages tree
 */
export async function resolvePagePath(relPath) {
  const normalized = assertSafeRelativePagePath(relPath);
  const pagesDir = getBrainPagesDir();

  await fs.mkdir(pagesDir, { recursive: true });
  const realPagesRoot = realpathForBoundaryCheck(pagesDir);
  const candidate = path.resolve(realPagesRoot, ...normalized.split('/'));
  const target = realpathForBoundaryCheck(candidate);
  const relative = path.relative(realPagesRoot, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new BrainPathError('Page path escapes the pages directory via symlink');
  }
  // A dangling final symlink also looks missing to realpath, but writeFile follows it.
  const stat = await fs.lstat(candidate).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (stat?.isSymbolicLink()) await fs.realpath(candidate);
  return target;
}
