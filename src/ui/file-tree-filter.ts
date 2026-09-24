import { parseListDirectoryResult, type ParsedListing } from '../lib/list-directory-parse';

/** Directory basenames skipped during workspace index walks. */
const SKIP_DIR_NAMES = new Set(['.git', '.godot', 'node_modules', 'dist', '.minnow']);

export type ListDirectoryFetcher = (
  relativePath: string,
) => Promise<ParsedListing | { error: string }>;

let indexCache: { root: string; paths: string[] } | null = null;
let indexBuildPromise: Promise<string[] | { error: string }> | null = null;

/** Session-only name filter (not persisted in filePanel). */
let filterQuery = '';

/** Current name filter query. */
export function getFilterQuery(): string {
  return filterQuery;
}

/** Update filter query without triggering UI render. */
export function setFilterQueryValue(value: string): void {
  filterQuery = value;
}

function joinPath(parent: string, name: string): string {
  if (parent === '.' || parent === '') return name;
  return `${parent}/${name}`;
}

/** True when a directory basename should not be traversed during indexing. */
export function shouldSkipDirName(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}

/** Trim and lowercase a filter query for matching. */
export function normalizeFilterQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Last path segment of a relative workspace path. */
export function basenameOf(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * Case-insensitive subsequence match: every query character appears in order in the name.
 */
export function matchesNameFilter(query: string, name: string): boolean {
  const q = normalizeFilterQuery(query);
  if (!q) return true;
  const n = name.toLowerCase();
  let qi = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Rank paths for flat result ordering (earlier subsequence / shorter path first). */
function matchScore(query: string, path: string): number {
  const name = basenameOf(path).toLowerCase();
  const q = normalizeFilterQuery(query);
  const subIdx = name.indexOf(q);
  if (subIdx >= 0) return subIdx;
  let qi = 0;
  let lastMatch = 0;
  for (let i = 0; i < name.length && qi < q.length; i++) {
    if (name[i] === q[qi]) {
      lastMatch = i;
      qi++;
    }
  }
  return qi === q.length ? lastMatch + 1000 : 9999;
}

/** Sort filtered file paths for display. */
export function sortFilteredPaths(paths: string[], query: string): string[] {
  const q = normalizeFilterQuery(query);
  return [...paths].sort((a, b) => {
    const scoreA = matchScore(q, a);
    const scoreB = matchScore(q, b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
}

/** Keep paths whose basename matches the filter query. */
export function filterPaths(paths: string[], query: string): string[] {
  const q = normalizeFilterQuery(query);
  if (!q) return paths;
  return paths.filter((p) => matchesNameFilter(q, basenameOf(p)));
}

/** Walk workspace with list_directory (BFS); returns relative file paths only. */
export async function buildWorkspaceIndex(
  root: string,
  fetchListing: ListDirectoryFetcher,
): Promise<string[] | { error: string }> {
  const files: string[] = [];
  const queue: string[] = [root || '.'];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);

    const result = await fetchListing(dir);
    if ('error' in result) return result;

    for (const file of result.files) {
      files.push(joinPath(dir, file));
    }
    for (const subdir of result.dirs) {
      if (shouldSkipDirName(subdir)) continue;
      queue.push(joinPath(dir, subdir));
    }
  }

  return files;
}

/** Drop cached workspace index (e.g. after tree refresh). */
export function invalidateFileTreeIndex(): void {
  indexCache = null;
  indexBuildPromise = null;
}

/** Cached file paths for the workspace root; builds on first call per root. */
export async function ensureWorkspaceIndex(
  root: string,
  fetchListing: ListDirectoryFetcher,
): Promise<string[] | { error: string }> {
  const key = root || '.';
  if (indexCache?.root === key) return indexCache.paths;

  if (!indexBuildPromise) {
    indexBuildPromise = (async () => {
      const built = await buildWorkspaceIndex(key, fetchListing);
      indexBuildPromise = null;
      if (typeof built === 'object' && 'error' in built) return built;
      indexCache = { root: key, paths: built };
      return built;
    })();
  }

  return indexBuildPromise;
}

/** Test hook: inject a fixed index without network. */
export function setWorkspaceIndexForTest(root: string, paths: string[]): void {
  indexCache = { root: root || '.', paths };
  indexBuildPromise = null;
}

/** Parse list_directory tool output for index walks. */
export async function fetchListingFromTool(
  executeTool: (name: string, args: { path: string }) => Promise<{ content: string }>,
  relativePath: string,
): Promise<ParsedListing | { error: string }> {
  const raw = (await executeTool('list_directory', { path: relativePath })).content;
  return parseListDirectoryResult(raw);
}
