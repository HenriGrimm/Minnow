/**
 * MIN-B10 — unified staleness, incremental reindex, and propagation.
 * Watched inputs: code files (Merkle), raw sources (content hash), wiki pages (anchors).
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getEffectiveWorkspaceRoot, runWithToolContext } from '../../runtime/path-access.js';
import { brainWorkspaceKeyFromPath, getBrainSourcesDir, getBrainStatePath } from '../paths.js';
import { loadCatalog, updatePage } from '../store.js';
import { loadBrainConfig } from '../store.js';
import { detectAndApplyAnchorDrift } from './anchors.js';
import { normalizeBrainCodeConfig } from './config.js';
import {
  listIndexableFiles,
  normalizeIndexableRelPath,
} from './indexer.js';
import { getCodeDb, refreshFileMtimes } from './schema.js';
import { runBrainCodeReindex } from './index-host.js';
import { runBoundedPool } from './indexer.js';
import { getIndexProgress, getIndexRun, recordIndexRun, reportIndexProgress } from './index-progress.js';

/** Load merged config.brain.code settings (avoids circular import with query.js). */
async function loadBrainCodeConfig() {
  const brain = await loadBrainConfig();
  const raw = brain.code && typeof brain.code === 'object' ? brain.code : {};
  return normalizeBrainCodeConfig(raw);
}

const execFileAsync = promisify(execFile);

/** @typedef {'manual' | 'workspace-switch' | 'git-hook' | 'lazy-query'} CascadeTrigger */

const HOOK_MARKER = '# minnow-brain-cascade-hook';
const GIT_HOOK_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/brain-git-post-commit.mjs',
);

/**
 * Both of these used to be single global slots, unlike the `cascadeInFlightByRepo`
 * map right below them. With two workspaces open that is not just starvation:
 * a lazy refresh for folder B would return folder A's in-flight promise, so B
 * got A's answer. Key both per repo.
 */
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const wikiResynthesisTimerByRepo = new Map();

/** @type {Map<string, Promise<unknown>>} */
const lazyRefreshInFlightByRepo = new Map();

/** Repo key for the workspace this call is scoped to. */
function currentBrainRepoKey() {
  return brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot()) || 'workspace';
}

/** @type {Map<string, Promise<unknown>>} */
const cascadeInFlightByRepo = new Map();

/** Detached reindex jobs started by the HTTP layer, keyed by repo. */
/** @type {Map<string, Promise<unknown>>} */
const reindexJobByRepo = new Map();

const STALE_STAT_CONCURRENCY = 32;

// ── Merkle ───────────────────────────────────────────────────────────────────

/**
 * Hash one Merkle leaf from a workspace-relative file path and content hash.
 * @param {string} file
 * @param {string} contentHash
 */
export function merkleLeafHash(file, contentHash) {
  return createHash('sha256').update(`${file}\0${contentHash}`, 'utf8').digest('hex');
}

/**
 * Build a binary Merkle root from sorted leaf hashes.
 * @param {string[]} leafHashes
 */
export function merkleRootFromLeaves(leafHashes) {
  if (!leafHashes.length) {
    return createHash('sha256').update('empty', 'utf8').digest('hex');
  }
  let level = [...leafHashes];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(createHash('sha256').update(`${left}${right}`, 'utf8').digest('hex'));
    }
    level = next;
  }
  return level[0];
}

/**
 * Merkle root for a repo from sorted { file, hash } rows.
 * @param {Array<{ file: string, hash: string }>} entries
 */
export function merkleRootFromEntries(entries) {
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file));
  return merkleRootFromLeaves(sorted.map((row) => merkleLeafHash(row.file, row.hash)));
}

/**
 * Return file paths whose leaf hash differs between two sorted entry maps.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
export function diffMerkleEntries(before, after) {
  const changed = new Set();
  const files = new Set([...before.keys(), ...after.keys()]);
  for (const file of files) {
    if (before.get(file) !== after.get(file)) {
      changed.add(file);
    }
  }
  return [...changed];
}

/** @returns {Promise<Record<string, unknown>>} */
async function readBrainState() {
  try {
    const raw = await fs.readFile(getBrainStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} patch */
async function writeBrainState(patch) {
  const current = await readBrainState();
  const next = { ...current, ...patch };
  await fs.mkdir(path.dirname(getBrainStatePath()), { recursive: true });
  await fs.writeFile(getBrainStatePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Read persisted Merkle root for a workspace repo key.
 * @param {string} repo
 */
async function readStoredMerkleRoot(repo) {
  const state = await readBrainState();
  const cascade =
    state.cascade && typeof state.cascade === 'object'
      ? /** @type {Record<string, { merkleRoot?: string }>} */ (state.cascade)
      : {};
  return cascade[repo]?.merkleRoot ?? null;
}

/**
 * Persist Merkle root after a successful index pass.
 * @param {string} repo
 * @param {string} merkleRoot
 */
async function persistMerkleRoot(repo, merkleRoot) {
  const state = await readBrainState();
  const cascade =
    state.cascade && typeof state.cascade === 'object'
      ? { .../** @type {Record<string, unknown>} */ (state.cascade) }
      : {};
  cascade[repo] = {
    ...(cascade[repo] && typeof cascade[repo] === 'object'
      ? /** @type {Record<string, unknown>} */ (cascade[repo])
      : {}),
    merkleRoot,
    updatedAt: new Date().toISOString(),
  };
  await writeBrainState({ cascade });
}

/**
 * Hash file content on disk (workspace-relative path).
 * @param {string} root
 * @param {string} relFile
 */
async function hashFileOnDisk(root, relFile) {
  const abs = path.join(root, relFile);
  const text = await fs.readFile(abs, 'utf8');
  const stat = await fs.stat(abs);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  return { hash, mtimeMs: stat.mtimeMs };
}

// ── Drift ────────────────────────────────────────────────────────────────────

/**
 * Detect workspace files whose disk content differs from the code index.
 * Uses mtime fast-path, then content hashes, then Merkle comparison.
 * @param {{ codeConfig?: ReturnType<typeof normalizeBrainCodeConfig>, repo?: string, discoverNewFiles?: boolean }} [opts]
 */
export async function detectStaleFiles(opts = {}) {
  const root = getEffectiveWorkspaceRoot();
  const repo = opts.repo ?? (brainWorkspaceKeyFromPath(root) || 'workspace');
  const codeConfig = opts.codeConfig ?? normalizeBrainCodeConfig(null);
  const discoverNewFiles = opts.discoverNewFiles === true;
  const db = getCodeDb(repo);

  const indexed = db
    .prepare('SELECT file, sha256, mtime_ms FROM file_hashes WHERE repo = ? ORDER BY file')
    .all(repo);
  const indexedByFile = new Map(
    indexed.map((row) => [String(row.file), { hash: String(row.sha256), mtimeMs: Number(row.mtime_ms) }]),
  );

  /** @type {Array<{ file: string, hash: string }>} */
  const diskEntries = [];
  /** @type {string[]} */
  const changedFiles = [];
  /** @type {Array<{ file: string, mtimeMs: number }>} */
  const mtimeOnly = [];

  await runBoundedPool(
    indexed,
    STALE_STAT_CONCURRENCY,
    async (row) => {
      const relFile = String(row.file);
      const abs = path.join(root, relFile);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) {
          changedFiles.push(relFile);
          return;
        }
        const stored = indexedByFile.get(relFile);
        if (stored && stored.mtimeMs === stat.mtimeMs) {
          diskEntries.push({ file: relFile, hash: stored.hash });
          return;
        }
        const { hash, mtimeMs } = await hashFileOnDisk(root, relFile);
        diskEntries.push({ file: relFile, hash });
        if (!stored || stored.hash !== hash) {
          changedFiles.push(relFile);
          return;
        }
        // Same bytes, newer mtime — a checkout, a worktree add, a touch. Re-indexing here
        // would re-parse the entire tree through the LSP for no change at all, which is
        // what used to stall a board's first tool call for minutes. Just re-stamp mtime.
        mtimeOnly.push({ file: relFile, mtimeMs });
      } catch {
        changedFiles.push(relFile);
      }
    },
  );

  if (mtimeOnly.length) {
    refreshFileMtimes(db, repo, mtimeOnly);
  }

  if (discoverNewFiles) {
    const indexable = await listIndexableFiles(root, codeConfig.includeGlobs, codeConfig.excludeGlobs);
    for (const relFile of indexable) {
      if (indexedByFile.has(relFile)) continue;
      try {
        const { hash } = await hashFileOnDisk(root, relFile);
        diskEntries.push({ file: relFile, hash });
        changedFiles.push(relFile);
      } catch {
        /* skip unreadable paths */
      }
    }
  }

  const diskRoot = merkleRootFromEntries(diskEntries);
  const storedRoot = await readStoredMerkleRoot(repo);
  const dbRoot = merkleRootFromEntries(
    indexed.map((row) => ({ file: String(row.file), hash: String(row.sha256) })),
  );

  return {
    repo,
    changedFiles: [...new Set(changedFiles)],
    mtimeOnlyFiles: mtimeOnly.length,
    merkleRoot: diskRoot,
    storedMerkleRoot: storedRoot,
    dbMerkleRoot: dbRoot,
    stale: storedRoot
      ? diskRoot !== storedRoot
      : changedFiles.length > 0 || (discoverNewFiles && diskEntries.length > indexed.length),
  };
}

/**
 * Mark ingest-derived wiki pages stale when their raw source hash drifts.
 * @returns {Promise<Array<{ path: string, title: string }>>}
 */
export async function detectRawSourceDrift() {
  const catalog = await loadCatalog();
  const sourcesDir = getBrainSourcesDir();
  const drifted = [];

  for (const page of catalog.pages) {
    if (page.source !== 'ingest') continue;
    const inputHash = String(page.input_hash ?? '').trim();
    if (!inputHash) continue;

    let sourceHash = inputHash;
    try {
      const names = await fs.readdir(sourcesDir);
      const match = names.find((name) => name.startsWith(`${inputHash}-`));
      if (!match) {
        drifted.push({ path: page.path, title: page.title });
        if (page.status !== 'stale') {
          await updatePage(page.path, { status: 'stale', skipAnchorSync: true });
        }
        continue;
      }
      const raw = await fs.readFile(path.join(sourcesDir, match), 'utf8');
      sourceHash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    } catch {
      drifted.push({ path: page.path, title: page.title });
      if (page.status !== 'stale') {
        await updatePage(page.path, { status: 'stale', skipAnchorSync: true });
      }
      continue;
    }

    if (sourceHash !== inputHash) {
      drifted.push({ path: page.path, title: page.title });
      if (page.status !== 'stale') {
        await updatePage(page.path, { status: 'stale', skipAnchorSync: true });
      }
    }
  }

  return drifted;
}

/**
 * Reindex changed files, re-rank, and propagate anchor drift (deterministic path).
 * @param {{ files?: string[] | null, focusFiles?: string[], force?: boolean, codeConfig?: ReturnType<typeof normalizeBrainCodeConfig>, trigger?: CascadeTrigger }} opts
 */
export async function propagateCodeChanges(opts = {}) {
  const root = getEffectiveWorkspaceRoot();
  const repo = brainWorkspaceKeyFromPath(root) || 'workspace';
  const codeConfig = opts.codeConfig ?? normalizeBrainCodeConfig(null);
  const files = opts.files?.map((f) => normalizeIndexableRelPath(root, f)).filter(Boolean);

  const reindexResult = await runBrainCodeReindex({
    files: files?.length ? files : undefined,
    focusFiles: opts.focusFiles ?? files ?? [],
    force: opts.force === true,
    codeConfig,
  });

  const anchorDrift = await detectAndApplyAnchorDrift();
  const rawSourceDrift = await detectRawSourceDrift();

  const db = getCodeDb(repo);
  const rows = db
    .prepare('SELECT file, sha256 FROM file_hashes WHERE repo = ?')
    .all(repo)
    .map((row) => ({ file: String(row.file), hash: String(row.sha256) }));
  const merkleRoot = merkleRootFromEntries(rows);
  await persistMerkleRoot(repo, merkleRoot);

  return {
    trigger: opts.trigger ?? 'manual',
    repo,
    merkleRoot,
    anchorDrift,
    rawSourceDrift,
    ...reindexResult,
  };
}

/**
 * Drain queued wiki pages on a background timer (LLM regen never blocks requests).
 */
export function scheduleWikiResynthesis() {
  const repo = currentBrainRepoKey();
  if (wikiResynthesisTimerByRepo.has(repo)) return;
  const workspaceRoot = getEffectiveWorkspaceRoot();
  const timer = setTimeout(() => {
    wikiResynthesisTimerByRepo.delete(repo);
    // The timer fires outside any request, so re-enter this repo's scope.
    void runWithToolContext(() => processWikiResynthesisQueue(), { workspaceRoot });
  }, 250);
  wikiResynthesisTimerByRepo.set(repo, timer);
}

/** Batch lint pass for queued wiki pages — marks issues, does not call the LLM inline. */
export async function processWikiResynthesisQueue() {
  const state = await readBrainState();
  const queue = Array.isArray(state.resynthesisQueue)
    ? state.resynthesisQueue.map(String).filter(Boolean)
    : [];
  if (!queue.length) return { processed: 0 };

  const { lintBrainWiki } = await import('../lint.js');
  await lintBrainWiki({ includeLlm: false });

  await writeBrainState({
    resynthesisQueue: [],
    lastResynthesisPassAt: new Date().toISOString(),
  });

  return { processed: queue.length, queued: 0 };
}

/**
 * Largest slice `ensureIndexFreshForQuery` will reindex while a caller waits.
 *
 * Above this the refresh is handed to the detached job. Sized so the inline path stays in
 * the seconds range on a cold LSP; a board switching branches routinely exceeds it.
 */
export const LAZY_INLINE_REFRESH_MAX_FILES = 50;

/**
 * Cheap staleness check before code queries; refreshes only the affected slice.
 *
 * Never blocks on a full reindex — see {@link LAZY_INLINE_REFRESH_MAX_FILES}.
 */
export async function ensureIndexFreshForQuery() {
  const code = await loadBrainCodeConfig();
  if (!code.enabled) return null;

  const root = getEffectiveWorkspaceRoot();
  const repo = brainWorkspaceKeyFromPath(root) || 'workspace';

  const inFlight = lazyRefreshInFlightByRepo.get(repo);
  if (inFlight) {
    return inFlight;
  }

  const db = getCodeDb(repo);
  const indexedCount =
    db.prepare('SELECT COUNT(*) AS n FROM file_hashes WHERE repo = ?').get(repo)?.n ?? 0;
  const discoverNewFiles = indexedCount === 0;

  const refresh = (async () => {
    const stale = await detectStaleFiles({ codeConfig: code, discoverNewFiles });
    if (!stale.changedFiles.length) {
      if (stale.stale && stale.merkleRoot) {
        await persistMerkleRoot(stale.repo, stale.merkleRoot);
      }
      return { refreshed: false, ...stale };
    }
    // A caller is blocked on this — a code tool mid tool-call, or an HTTP request. Only a
    // slice small enough to finish in seconds may run inline; anything larger is a full
    // reindex (minutes of LSP work) and belongs in the detached job, with the query
    // answering from the slightly stale index it already has.
    if (stale.changedFiles.length > LAZY_INLINE_REFRESH_MAX_FILES) {
      // Not `force` — these files are already known-stale by hash, so the job should do
      // the hash-checked work, not blindly re-parse.
      const job = startReindexJob({ trigger: 'manual', files: stale.changedFiles });
      return { refreshed: false, deferred: true, ...stale, job };
    }
    const result = await propagateCodeChanges({
      files: stale.changedFiles,
      focusFiles: stale.changedFiles,
      codeConfig: code,
      trigger: 'lazy-query',
    });
    scheduleWikiResynthesis();
    return { refreshed: true, ...result };
  })();

  lazyRefreshInFlightByRepo.set(repo, refresh);
  try {
    return await refresh;
  } finally {
    lazyRefreshInFlightByRepo.delete(repo);
  }
}

/**
 * Whether an automatic trigger is enabled for the current cadence setting.
 * @param {CascadeTrigger} trigger
 * @param {ReturnType<typeof normalizeBrainCodeConfig>} codeConfig
 */
export function isCascadeTriggerEnabled(trigger, codeConfig) {
  if (trigger === 'manual' || trigger === 'lazy-query') return true;
  if (trigger === 'workspace-switch') return codeConfig.reindexCadence === 'on-switch';
  if (trigger === 'git-hook') return codeConfig.reindexCadence === 'git-hook';
  return false;
}

// ── Cascade ──────────────────────────────────────────────────────────────────

/**
 * Main cascade entry — all reindex triggers route through here.
 * @param {{ trigger?: CascadeTrigger, files?: string[], codeConfig?: ReturnType<typeof normalizeBrainCodeConfig>, force?: boolean }} [opts]
 */
export async function runCascade(opts = {}) {
  const trigger = opts.trigger ?? 'manual';
  const codeConfig = opts.codeConfig ?? (await loadBrainCodeConfig());

  if (!codeConfig.enabled) {
    return { skipped: true, reason: 'disabled', trigger };
  }

  if (!opts.force && !isCascadeTriggerEnabled(trigger, codeConfig)) {
    return { skipped: true, reason: 'cadence', trigger, reindexCadence: codeConfig.reindexCadence };
  }

  const root = getEffectiveWorkspaceRoot();
  const repo = brainWorkspaceKeyFromPath(root) || 'workspace';
  const inFlight = cascadeInFlightByRepo.get(repo);
  if (inFlight) {
    return inFlight;
  }

  const run = (async () => {
    let files = opts.files?.map((f) => String(f).trim()).filter(Boolean);
    if (!files?.length && trigger !== 'manual') {
      const stale = await detectStaleFiles({ codeConfig, discoverNewFiles: true });
      if (!stale.stale) {
        return { skipped: true, reason: 'fresh', trigger, merkleRoot: stale.merkleRoot };
      }
      files = stale.changedFiles;
    }

    const result = await propagateCodeChanges({
      files: files?.length ? files : null,
      focusFiles: files ?? [],
      force: opts.force === true,
      codeConfig,
      trigger,
    });

    scheduleWikiResynthesis();
    return { ok: true, skipped: false, ...result };
  })();

  cascadeInFlightByRepo.set(repo, run);
  try {
    return await run;
  } finally {
    cascadeInFlightByRepo.delete(repo);
  }
}

/** Fields of a cascade result worth replaying to the UI after the job ends. */
function pickRunSummary(result) {
  const src = result && typeof result === 'object' ? result : {};
  const keys = [
    'indexedFiles',
    'filesProcessed',
    'failedFiles',
    'symbolsIndexed',
    'symbolCount',
    'rankedSymbols',
    'edgesIndexed',
    'errors',
    'errorSummary',
    'usageAugmentError',
    'scaffold',
    'skipped',
    'reason',
  ];
  const out = {};
  for (const key of keys) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/**
 * Start a reindex in the background and return immediately.
 *
 * A full index runs for minutes; holding the HTTP response open for it meant the client
 * timed out and reported failure while the work was still going. Callers poll
 * /api/brain/code/status for progress and the final `lastRun` outcome instead.
 * Always clear the indexing flag in finally — a crashed worker never sends a closing frame.
 * @param {Parameters<typeof runCascade>[0]} [opts]
 */
export function startReindexJob(opts = {}) {
  const root = getEffectiveWorkspaceRoot();
  const repo = brainWorkspaceKeyFromPath(root) || 'workspace';
  const existing = reindexJobByRepo.get(repo);
  if (existing) {
    const run = getIndexRun(repo);
    return {
      started: false,
      alreadyRunning: true,
      repo,
      run,
      ...(run?.startedAt ? { startedAt: String(run.startedAt) } : {}),
    };
  }

  const startedAt = new Date().toISOString();
  reportIndexProgress(repo, {
    indexing: true,
    filesDone: 0,
    filesTotal: 0,
    phase: 'starting',
  });
  recordIndexRun(repo, { startedAt, finishedAt: null, running: true, ok: null });

  const job = runCascade(opts)
    .then((result) => {
      recordIndexRun(repo, {
        startedAt,
        finishedAt: new Date().toISOString(),
        running: false,
        ok: true,
        ...pickRunSummary(result),
      });
    })
    .catch((err) => {
      recordIndexRun(repo, {
        startedAt,
        finishedAt: new Date().toISOString(),
        running: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      reindexJobByRepo.delete(repo);
      const progress = getIndexProgress(repo);
      if (progress.indexing) {
        reportIndexProgress(repo, { ...progress, indexing: false, phase: 'idle' });
      }
    });

  reindexJobByRepo.set(repo, job);
  return { started: true, repo, startedAt };
}

/** Test helper — await the detached job for a repo, if one is running. */
export async function awaitReindexJobForTests(repo) {
  const job = reindexJobByRepo.get(String(repo ?? '').trim() || 'workspace');
  if (job) await job;
}

/**
 * Workspace switch hook — warm cached SQLite, then hash-check when cadence is on-switch.
 * @param {string} [previousRoot]
 */
export async function onWorkspaceSwitched(previousRoot) {
  void previousRoot;
  const { warmCodeIndexOnWorkspaceSwitch } = await import('./workspace-cache.js');
  warmCodeIndexOnWorkspaceSwitch();

  const code = await loadBrainCodeConfig();
  if (!isCascadeTriggerEnabled('workspace-switch', code)) {
    return { skipped: true, reason: 'cadence', warmed: true };
  }
  return runCascade({ trigger: 'workspace-switch', codeConfig: code, force: true });
}

/**
 * List changed paths from the latest git commit (for post-commit hook).
 * @param {string} [workspaceRoot]
 */
export async function getChangedFilesFromGit(workspaceRoot) {
  const root = workspaceRoot ?? getEffectiveWorkspaceRoot();
  const { stdout } = await execFileAsync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
    { cwd: root, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

// ── Git hook ─────────────────────────────────────────────────────────────────

/** Absolute path to the post-commit hook script shipped with Minnow. */
export function getGitHookScriptPath() {
  return GIT_HOOK_SCRIPT;
}

/**
 * Install a user-managed post-commit hook in the workspace .git/hooks directory.
 * @param {string} [workspaceRoot]
 */
export async function installGitHook(workspaceRoot) {
  const root = workspaceRoot ?? getEffectiveWorkspaceRoot();
  const gitDir = path.join(root, '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  const hookPath = path.join(hooksDir, 'post-commit');
  const scriptPath = getGitHookScriptPath();

  try {
    await fs.access(gitDir);
  } catch {
    const err = new Error('Workspace is not a git repository');
    err.statusCode = 400;
    throw err;
  }

  await fs.mkdir(hooksDir, { recursive: true });

  let existing = '';
  try {
    existing = await fs.readFile(hookPath, 'utf8');
  } catch {
    existing = '';
  }

  const block = [
    HOOK_MARKER,
    `node "${scriptPath.replace(/\\/g, '/')}"`,
    `${HOOK_MARKER}-end`,
    '',
  ].join('\n');

  if (existing.includes(HOOK_MARKER)) {
    return { installed: true, hookPath, alreadyPresent: true };
  }

  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : `#!/bin/sh\n\n${block}`;
  await fs.writeFile(hookPath, next, { encoding: 'utf8', mode: 0o755 });
  return { installed: true, hookPath, alreadyPresent: false };
}

/**
 * Remove the Minnow hook block from post-commit (user-installed cleanup).
 * @param {string} [workspaceRoot]
 */
export async function uninstallGitHook(workspaceRoot) {
  const root = workspaceRoot ?? getEffectiveWorkspaceRoot();
  const hookPath = path.join(root, '.git', 'hooks', 'post-commit');
  let existing = '';
  try {
    existing = await fs.readFile(hookPath, 'utf8');
  } catch {
    return { removed: false, reason: 'missing' };
  }

  if (!existing.includes(HOOK_MARKER)) {
    return { removed: false, reason: 'not-installed' };
  }

  const pattern = new RegExp(
    `\\n?${HOOK_MARKER}[\\s\\S]*?${HOOK_MARKER}-end\\n?`,
    'g',
  );
  const next = existing.replace(pattern, '\n').trimEnd();
  if (next) {
    await fs.writeFile(hookPath, `${next}\n`, 'utf8');
  } else {
    await fs.unlink(hookPath);
  }
  return { removed: true, hookPath };
}

/**
 * Report whether the Minnow post-commit block is present.
 * @param {string} [workspaceRoot]
 */
export async function getGitHookStatus(workspaceRoot) {
  const root = workspaceRoot ?? getEffectiveWorkspaceRoot();
  const gitDir = path.join(root, '.git');
  const hookPath = path.join(gitDir, 'hooks', 'post-commit');
  const scriptPath = getGitHookScriptPath();

  let isGitRepo = false;
  try {
    await fs.access(gitDir);
    isGitRepo = true;
  } catch {
    return {
      hookPath,
      installed: false,
      isGitRepo: false,
      scriptPath,
    };
  }

  try {
    const content = await fs.readFile(hookPath, 'utf8');
    return {
      hookPath,
      installed: content.includes(HOOK_MARKER),
      isGitRepo: true,
      scriptPath,
    };
  } catch {
    return {
      hookPath,
      installed: false,
      isGitRepo: true,
      scriptPath,
    };
  }
}
