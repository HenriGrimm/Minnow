import { isImpeccableDetectFindingsResult } from '../lib/impeccable-detect-result.ts';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path.ts';
import type { ToolExecutionResult } from '../types.ts';
import { extractPathLikeArgs, normalizePathArg } from './path-args.ts';
import { loadToolConfig } from './config.ts';
import { getCachePolicyForTool, type ToolCachePolicy } from './tool-cache-policy.ts';

/** Minimal executeTool context for cache scoping (avoids circular import with client.ts). */
export interface ToolCacheContext {
  chatId?: string;
  /** Override workspace root (desktop drawer, chats sandbox, worktree listing). */
  workspaceRoot?: string;
}

/** Workspace root reader (bound at app init to avoid importing workspace state in tests). */
let readWorkspacePathForCache: () => string = () => '';

// ── Bind ─────────────────────────────────────────────────────────────────────

/** Wire workspace path into cache scope ids (call from initApp). */
export function bindWorkspacePathForToolCache(reader: () => string): void {
  readWorkspacePathForCache = reader;
}

/** Aligns with {@link FILE_TREE_MUTATING_TOOLS} in file-tree-auto-refresh (no UI import). */
const FILE_TREE_MUTATING_TOOLS = new Set([
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
]);

/** Max entries per scope before LRU eviction of oldest keys. */
const MAX_ENTRIES_PER_SCOPE = 500;

/** Separator between tool name and serialized args in cache keys. */
const CACHE_KEY_SEP = '\0';

type CachePolicy = ToolCachePolicy;

type CacheEntry = {
  result: ToolExecutionResult;
  storedAtMs: number;
  ttlMs: number;
};

type InvalidationRule = {
  invalidateTools: readonly string[];
  pathFromArgs: (name: string, args: Record<string, unknown>) => string[];
};

const DEFAULT_CACHE_POLICY: CachePolicy = { cacheable: false, ttlMs: 0 };

const FILE_READ_INVALIDATION_TARGETS = [
  'read_file',
  'read_file_range',
  'search_in_file',
  'grep',
  'get_file_metadata',
  'list_directory',
  'find_files',
  'get_lsp_diagnostics',
  'read_document',
] as const;

const GIT_READ_INVALIDATION_TARGETS = ['git_status', 'git_diff', 'git_log'] as const;

const PATH_WRITE_KEYS = ['path'] as const;

function pathKeysFromArgs(
  args: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      out.push(normalizePathArg(v.trim()));
    }
  }
  return out;
}

const FILE_AND_GIT_READ_INVALIDATION_TARGETS = [
  ...FILE_READ_INVALIDATION_TARGETS,
  ...GIT_READ_INVALIDATION_TARGETS,
] as const;

const saveFileInvalidation: InvalidationRule = {
  invalidateTools: FILE_AND_GIT_READ_INVALIDATION_TARGETS,
  pathFromArgs: (_, args) => pathKeysFromArgs(args, PATH_WRITE_KEYS),
};

const opaqueWriteInvalidation: InvalidationRule = {
  invalidateTools: FILE_AND_GIT_READ_INVALIDATION_TARGETS,
  pathFromArgs: () => ['**'],
};

/** Tools that run arbitrary user code and may touch any file in the workspace. */
const OPAQUE_WRITE_TOOLS = new Set([
  'execute_command',
  'run_javascript',
  'run_python',
  'start_background_command',
]);

/** True when a tool can mutate the workspace in ways its args do not describe. */
function isOpaqueWriteTool(name: string): boolean {
  return (
    OPAQUE_WRITE_TOOLS.has(name) ||
    name.startsWith('mcp__') ||
    name.startsWith('plugin__')
  );
}

const INVALIDATION_MAP: Record<string, InvalidationRule> = {
  save_file: saveFileInvalidation,
  create_pdf: saveFileInvalidation,
  create_spreadsheet: saveFileInvalidation,
  create_word_document: saveFileInvalidation,
  append_file: saveFileInvalidation,
  insert_at_line: saveFileInvalidation,
  replace_text_in_file: saveFileInvalidation,
  make_directory: {
    invalidateTools: ['list_directory', 'find_files'],
    pathFromArgs: (_, args) => pathKeysFromArgs(args, PATH_WRITE_KEYS),
  },
  move_file: {
    invalidateTools: FILE_AND_GIT_READ_INVALIDATION_TARGETS,
    pathFromArgs: (_, args) =>
      pathKeysFromArgs(args, ['source', 'destination'] as const),
  },
  copy_file: {
    invalidateTools: FILE_AND_GIT_READ_INVALIDATION_TARGETS,
    pathFromArgs: (_, args) =>
      pathKeysFromArgs(args, ['source', 'destination'] as const),
  },
  delete_path: {
    invalidateTools: FILE_AND_GIT_READ_INVALIDATION_TARGETS,
    pathFromArgs: (_, args) => pathKeysFromArgs(args, PATH_WRITE_KEYS),
  },
  git_add: {
    invalidateTools: GIT_READ_INVALIDATION_TARGETS,
    pathFromArgs: () => [],
  },
  git_commit: {
    invalidateTools: GIT_READ_INVALIDATION_TARGETS,
    pathFromArgs: () => [],
  },
  git_checkout: {
    invalidateTools: [...GIT_READ_INVALIDATION_TARGETS, ...FILE_READ_INVALIDATION_TARGETS],
    pathFromArgs: () => ['**'],
  },
};

const scopeStores = new Map<string, Map<string, CacheEntry>>();

let cacheNowMs = 0;

function nowMs(): number {
  return cacheNowMs > 0 ? cacheNowMs : Date.now();
}

/** Test hook — freeze logical time for TTL assertions. */
export function setResultCacheNowForTests(ms: number): void {
  cacheNowMs = ms;
}

/** Reset test clock and all cached data. */
export function resetResultCacheForTests(): void {
  cacheNowMs = 0;
  scopeStores.clear();
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** Whether session tool caching is enabled in settings (default on). */
export function isToolCacheEnabled(): boolean {
  const config = loadToolConfig();
  return config.toolCache?.enabled !== false;
}

export { getCachePolicyForTool } from './tool-cache-policy.ts';

/** Whether session tool caching is enabled in settings (default on). */
export function isErrorToolResult(result: ToolExecutionResult): boolean {
  const text = typeof result.content === 'string' ? result.content : '';
  if (isImpeccableDetectFindingsResult(text)) return false;
  return text.startsWith('Error:');
}

/** Skip cache for tools whose args embed large opaque payloads (e.g. base64 attachments). */
function shouldBypassToolCache(name: string, args: Record<string, unknown>): boolean {
  if (name === 'read_document' && typeof args.content === 'string' && args.content.trim()) {
    return true;
  }
  return false;
}

/**
 * Normalize tool args for stable cache keys (sorted keys, trimmed strings, paths).
 */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const pathKeys = new Set(extractPathLikeArgs(name, args).length > 0
    ? getPathArgKeysForTool(name)
    : []);

  return normalizeValue(args, pathKeys) as Record<string, unknown>;
}

function getPathArgKeysForTool(toolName: string): string[] {
  const keys: string[] = [];
  const map: Record<string, readonly string[]> = {
    list_directory: ['path'],
    read_file: ['path'],
    read_file_range: ['path'],
    read_document: ['path'],
    save_file: ['path'],
    create_pdf: ['path'],
    create_spreadsheet: ['path'],
    create_word_document: ['path'],
    append_file: ['path'],
    insert_at_line: ['path'],
    replace_text_in_file: ['path'],
    search_in_file: ['path'],
    grep: ['path'],
    make_directory: ['path'],
    move_file: ['source', 'destination'],
    copy_file: ['source', 'destination'],
    delete_path: ['path'],
    find_files: ['path'],
    get_file_metadata: ['path'],
    get_lsp_diagnostics: ['path'],
  };
  const fromMap = map[toolName];
  if (fromMap) keys.push(...fromMap);
  if (toolName === 'git_diff') keys.push('path');
  if (toolName === 'git_add') keys.push('paths');
  return keys;
}

function normalizeValue(value: unknown, pathKeys: Set<string>, key?: string): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (key && pathKeys.has(key)) {
      return normalizePathArg(trimmed);
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    if (key === 'paths') {
      return value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => normalizePathArg(item.trim()))
        .sort();
    }
    return value.map((item) => normalizeValue(item, pathKeys));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const sortedKeys = Object.keys(obj).sort();
    for (const k of sortedKeys) {
      const normalized = normalizeValue(obj[k], pathKeys, k);
      if (normalized !== undefined) {
        out[k] = normalized;
      }
    }
    return out;
  }
  return value;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** Build a stable cache key from tool name and normalized args. */
export function buildCacheKey(name: string, normalizedArgs: Record<string, unknown>): string {
  return `${name}${CACHE_KEY_SEP}${JSON.stringify(normalizedArgs)}`;
}

/** Scope id: normalized workspace path + chat id (or __no_chat__). */
export function getCacheScope(context: ToolCacheContext): string {
  const workspace = normalizeWorkspacePath(
    context.workspaceRoot?.trim() || readWorkspacePathForCache(),
  );
  const chat = context.chatId?.trim() || '__no_chat__';
  return `${workspace}:${chat}`;
}

function cloneResult(result: ToolExecutionResult): ToolExecutionResult {
  const cloned: ToolExecutionResult = {
    content: result.content,
  };
  if (result.attachments?.length) {
    cloned.attachments = result.attachments.map((a) => ({ ...a }));
  }
  if (result.codeChange) {
    cloned.codeChange = { ...result.codeChange };
  }
  return cloned;
}

function touchLru(scopeId: string, key: string, entry: CacheEntry): void {
  const scope = scopeStores.get(scopeId);
  if (!scope) return;
  scope.delete(key);
  scope.set(key, entry);
}

function evictIfNeeded(scopeId: string): void {
  const scope = scopeStores.get(scopeId);
  if (!scope || scope.size <= MAX_ENTRIES_PER_SCOPE) return;
  const oldest = scope.keys().next().value as string | undefined;
  if (oldest) scope.delete(oldest);
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** Lookup a cached result when policy + TTL allow. */
export function getCachedResult(
  scopeId: string,
  cacheKey: string,
): ToolExecutionResult | undefined {
  const scope = scopeStores.get(scopeId);
  if (!scope) return undefined;
  const entry = scope.get(cacheKey);
  if (!entry) return undefined;
  if (entry.ttlMs > 0 && nowMs() - entry.storedAtMs > entry.ttlMs) {
    scope.delete(cacheKey);
    logCacheDebug('expire', scopeId, cacheKey);
    return undefined;
  }
  touchLru(scopeId, cacheKey, entry);
  logCacheDebug('hit', scopeId, cacheKey);
  return cloneResult(entry.result);
}

/** Store a successful tool result copy. */
export function setCachedResult(
  scopeId: string,
  cacheKey: string,
  result: ToolExecutionResult,
  policy: CachePolicy,
): void {
  let scope = scopeStores.get(scopeId);
  if (!scope) {
    scope = new Map();
    scopeStores.set(scopeId, scope);
  }
  scope.set(cacheKey, {
    result: cloneResult(result),
    storedAtMs: nowMs(),
    ttlMs: policy.ttlMs,
  });
  evictIfNeeded(scopeId);
  logCacheDebug('set', scopeId, cacheKey);
}

function parseCacheKey(cacheKey: string): { name: string; args: Record<string, unknown> } | null {
  const sep = cacheKey.indexOf(CACHE_KEY_SEP);
  if (sep < 0) return null;
  const name = cacheKey.slice(0, sep);
  try {
    const args = JSON.parse(cacheKey.slice(sep + 1)) as Record<string, unknown>;
    return { name, args };
  } catch {
    return null;
  }
}

/** True when a cached path arg is equal to or nested under a bust prefix. */
export function pathMatchesBustPrefix(cachedPath: string, bustPrefix: string): boolean {
  const c = normalizePathArg(cachedPath);
  const b = normalizePathArg(bustPrefix);
  if (!b || b === '**') return true;
  if (!c) return false;
  if (c === b) return true;
  return c.startsWith(`${b}/`);
}

/** Parent directory of a normalized relative path (`.` for root-level files). */
function parentDirOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/');
  return slash >= 0 ? normalizedPath.slice(0, slash) : '.';
}

export function changedPathAffectsDirectoryListing(
  listingDir: string,
  changedPath: string,
): boolean {
  const dir = normalizePathArg(listingDir || '.');
  const changed = normalizePathArg(changedPath);
  if (!changed || changed === '**') return true;
  if (!dir || dir === '.') return true;
  if (changed === dir) return true;
  if (changed.startsWith(`${dir}/`)) return true;
  return parentDirOf(changed) === dir;
}

function cachedEntryMatchesBust(
  cachedTool: string,
  cachedArgs: Record<string, unknown>,
  rule: InvalidationRule,
  bustPrefixes: string[],
): boolean {
  if (!rule.invalidateTools.includes(cachedTool)) {
    return false;
  }
  if (bustPrefixes.includes('**')) {
    return true;
  }
  if (bustPrefixes.length === 0) {
    return true;
  }
  const cachedPaths = extractPathLikeArgs(cachedTool, cachedArgs);
  if (cachedPaths.length === 0) {
    return true;
  }
  const usesDirectoryListing =
    cachedTool === 'list_directory' || cachedTool === 'find_files';

  for (const cp of cachedPaths) {
    for (const bp of bustPrefixes) {
      if (pathMatchesBustPrefix(cp, bp)) {
        return true;
      }
      if (usesDirectoryListing && changedPathAffectsDirectoryListing(cp, bp)) {
        return true;
      }
    }
  }
  return false;
}

const DIRECTORY_LISTING_CACHE_TOOLS = new Set(['list_directory', 'find_files']);

/** Scope ids sharing the same workspace (all chat buckets + __no_chat__). */
function getScopeIdsForWorkspace(scopeId: string): string[] {
  const colon = scopeId.lastIndexOf(':');
  if (colon < 0) {
    return scopeStores.has(scopeId) ? [scopeId] : [];
  }
  const prefix = scopeId.slice(0, colon + 1);
  const matching = [...scopeStores.keys()].filter((id) => id.startsWith(prefix));
  return matching.length > 0 ? matching : scopeStores.has(scopeId) ? [scopeId] : [];
}

function invalidateScopeEntries(
  scopeId: string,
  rule: InvalidationRule,
  bustPrefixes: string[],
): number {
  const scope = scopeStores.get(scopeId);
  if (!scope) return 0;

  let removed = 0;
  for (const key of [...scope.keys()]) {
    const parsed = parseCacheKey(key);
    if (!parsed) continue;
    if (cachedEntryMatchesBust(parsed.name, parsed.args, rule, bustPrefixes)) {
      scope.delete(key);
      removed += 1;
    }
  }
  if (scope.size === 0) {
    scopeStores.delete(scopeId);
  }
  return removed;
}

// ── Invalidate ───────────────────────────────────────────────────────────────

/** Remove cache entries invalidated by a successful mutating tool. */
export function invalidateAfterTool(
  scopeId: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolExecutionResult,
): void {
  if (isErrorToolResult(result)) return;

  let rule = INVALIDATION_MAP[name];
  if (!rule && FILE_TREE_MUTATING_TOOLS.has(name)) {
    rule = saveFileInvalidation;
  }
  if (!rule && isOpaqueWriteTool(name)) {
    rule = opaqueWriteInvalidation;
  }
  if (!rule) return;

  const bustPrefixes = rule.pathFromArgs(name, args);
  for (const sid of getScopeIdsForWorkspace(scopeId)) {
    const removed = invalidateScopeEntries(sid, rule, bustPrefixes);
    if (removed > 0) {
      logCacheDebug('bust', sid, `${name} (${removed})`);
    }
  }
}

export function invalidateCachedDirectoryListings(workspacePath?: string): void {
  const prefix = workspacePath
    ? `${normalizeWorkspacePath(workspacePath)}:`
    : null;

  for (const scopeId of [...scopeStores.keys()]) {
    if (prefix && !scopeId.startsWith(prefix)) {
      continue;
    }
    const scope = scopeStores.get(scopeId);
    if (!scope) continue;

    let removed = 0;
    for (const key of [...scope.keys()]) {
      const parsed = parseCacheKey(key);
      if (!parsed) continue;
      if (DIRECTORY_LISTING_CACHE_TOOLS.has(parsed.name)) {
        scope.delete(key);
        removed += 1;
      }
    }
    if (scope.size === 0) {
      scopeStores.delete(scopeId);
    }
    if (removed > 0) {
      logCacheDebug('bust-listings', scopeId, String(removed));
    }
  }
}

/** Bust directory listing cache for the bound workspace (file tree refresh). */
export function invalidateCachedDirectoryListingsForCurrentWorkspace(): void {
  const workspace = normalizeWorkspacePath(readWorkspacePathForCache());
  if (!workspace) {
    invalidateCachedDirectoryListings();
    return;
  }
  invalidateCachedDirectoryListings(workspace);
}

/** Drop all entries for one scope id. */
export function clearCacheScope(scopeId: string): void {
  scopeStores.delete(scopeId);
}

/** Drop every cached scope (workspace switch helper). */
export function clearAllCaches(): void {
  scopeStores.clear();
}

/** Remove scopes tied to a workspace path prefix (any chat bucket). */
export function clearCachesForWorkspace(workspacePath: string): void {
  const norm = normalizeWorkspacePath(workspacePath);
  if (!norm) {
    clearAllCaches();
    return;
  }
  const prefix = `${norm}:`;
  for (const scopeId of [...scopeStores.keys()]) {
    if (scopeId.startsWith(prefix)) {
      scopeStores.delete(scopeId);
    }
  }
}

function logCacheDebug(kind: string, scopeId: string, detail: string): void {
  if (typeof localStorage === 'undefined') return;
  if (localStorage.getItem('minnowDebugToolCache') !== '1') return;
  console.debug(`[tool-cache] ${kind} scope=${scopeId} ${detail}`);
}

// ── Execute ──────────────────────────────────────────────────────────────────

/**
 * Run tool execution with session cache lookup/store and post-write invalidation.
 */
export async function executeWithResultCache(
  name: string,
  args: Record<string, unknown>,
  context: ToolCacheContext,
  inner: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const policy = getCachePolicyForTool(name);
  const scopeId = getCacheScope(context);
  const bypassCache = shouldBypassToolCache(name, args);

  if (!isToolCacheEnabled()) {
    const result = await inner();
    invalidateAfterTool(scopeId, name, args, result);
    return result;
  }

  if (!policy.cacheable || bypassCache) {
    const result = await inner();
    invalidateAfterTool(scopeId, name, args, result);
    return result;
  }

  const normalizedArgs = normalizeToolArgs(name, args);
  const cacheKey = buildCacheKey(name, normalizedArgs);
  const cached = getCachedResult(scopeId, cacheKey);
  if (cached) {
    return cached;
  }

  logCacheDebug('miss', scopeId, cacheKey);
  const result = await inner();
  invalidateAfterTool(scopeId, name, args, result);

  if (!isErrorToolResult(result)) {
    setCachedResult(scopeId, cacheKey, result, policy);
  }

  return result;
}
