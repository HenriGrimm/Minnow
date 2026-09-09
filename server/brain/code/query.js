/**
 * Read-only queries over the Brain code index (SQLite + LSP fallback).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getLspWorkspaceSymbols } from '../../lsp/manager.js';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { brainWorkspaceKeyFromPath } from '../paths.js';
import { loadBrainConfig } from '../store.js';
import { clampRepoMapInjectionTokenBudget, clampRepoMapTokenBudget, normalizeBrainCodeConfig } from './config.js';
import { getCodeDb, getIndexStats } from './schema.js';
import { renderRepoMap } from './repo-map.js';
import { prepareRepoMapSymbols, prepareRepoMapSymbolsForInjection } from './repo-map-symbols.js';
import { ensureIndexFreshForQuery, startReindexJob } from './cascade.js';
import { getIndexProgress, getIndexRun } from './index-progress.js';
import { ensureBrainLspProjectReady } from './project-scaffold.js';

/** Load merged config.brain.code settings. */
export async function loadBrainCodeConfig() {
  const brain = await loadBrainConfig();
  const raw = brain.code && typeof brain.code === 'object' ? brain.code : {};
  return normalizeBrainCodeConfig(raw);
}

/** Active workspace repo key for symbol ids. */
export function activeRepoKey() {
  return brainWorkspaceKeyFromPath(getEffectiveWorkspaceRoot()) || 'workspace';
}

/**
 * Normalize optional repo key from API/tool args (slug only).
 * @param {unknown} repoParam
 */
export function resolveRepoKey(repoParam) {
  const requested = typeof repoParam === 'string' ? repoParam.trim() : '';
  if (!requested) return activeRepoKey();
  if (!/^[a-z0-9._-]+$/i.test(requested)) {
    const err = new Error('Invalid repo key');
    err.statusCode = 400;
    throw err;
  }
  return requested.toLowerCase();
}

/**
 * Warm a cold code index (shared by repo_map tool and /api/brain/code/repo-map).
 * Cascade runs only when the requested repo matches the active workspace key.
 * A cold index takes minutes; start it and return what exists now.
 * @param {string} [repo]
 * @returns {Promise<{ repo: string, symbolCount: number }>}
 */
export async function ensureWarmCodeIndex(repo) {
  const key = resolveRepoKey(repo);
  const db = getCodeDb(key);
  const stats = getIndexStats(db, key);
  if (stats.symbolCount || key !== activeRepoKey()) {
    return { repo: key, symbolCount: stats.symbolCount ?? 0, warming: false };
  }

  const job = startReindexJob({ trigger: 'manual', force: true });
  return {
    repo: key,
    symbolCount: stats.symbolCount ?? 0,
    warming: true,
    startedAt: job.startedAt,
  };
}

/**
 * Index status for the active workspace.
 */
export async function queryCodeStatus() {
  const code = await loadBrainCodeConfig();
  const repo = activeRepoKey();
  const db = getCodeDb(repo);
  const stats = getIndexStats(db, repo);
  const progress = getIndexProgress(repo);
  const lastRun = getIndexRun(repo);
  return {
    enabled: code.enabled,
    repo,
    ...stats,
    ...progress,
    ...(lastRun ? { lastRun } : {}),
    repoMapTokenBudget: code.repoMapTokenBudget,
    repoMapInjectionTokenBudget: code.repoMapInjectionTokenBudget,
    reindexCadence: code.reindexCadence,
  };
}

/**
 * Extract lowercase alphanumeric tokens from a user query (safe for FTS5 MATCH).
 * @param {string} query
 */
function tokenizeSymbolQuery(query) {
  const raw = String(query ?? '').toLowerCase().match(/[a-z0-9_]+/gi) ?? [];
  return [...new Set(raw)];
}

/**
 * Build an FTS5 OR query so multi-word searches match any token (bm25 ranks AND hits higher).
 * @param {string[]} tokens
 */
function buildFtsMatchQuery(tokens) {
  if (!tokens.length) return null;
  return tokens.map((t) => t.replace(/"/g, '""')).join(' OR ');
}

/**
 * FTS5 search over name, file, signature, and doc.
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string | null} ftsQuery
 * @param {number} max
 */
function searchSymbolsFts(db, repo, ftsQuery, max) {
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT s.id, s.repo, s.kind, s.name, s.file, s.line_start, s.line_end, s.signature
         FROM symbols_fts f
         JOIN symbols s ON s.rowid = f.rowid
         WHERE s.repo = ? AND symbols_fts MATCH ?
         ORDER BY bm25(symbols_fts)
         LIMIT ?`,
      )
      .all(repo, ftsQuery, max);
  } catch {
    return [];
  }
}

/**
 * LIKE fallback when FTS misses (path fragments, porter-stem edge cases).
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string[]} tokens
 * @param {number} max
 * @param {Set<string>} excludeIds
 */
function searchSymbolsLike(db, repo, tokens, max, excludeIds) {
  if (!tokens.length || max <= 0) return [];
  const conditions = tokens
    .map(() => '(name LIKE ? OR file LIKE ? OR signature LIKE ?)')
    .join(' OR ');
  const params = [repo];
  for (const token of tokens) {
    const pat = `%${token}%`;
    params.push(pat, pat, pat);
  }
  params.push(max + excludeIds.size);
  const rows = db
    .prepare(
      `SELECT id, repo, kind, name, file, line_start, line_end, signature
       FROM symbols
       WHERE repo = ? AND (${conditions})
       ORDER BY pagerank DESC, usage_count DESC
       LIMIT ?`,
    )
    .all(...params);
  const out = [];
  for (const row of rows) {
    if (excludeIds.has(row.id)) continue;
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

/** Known source extensions for file-path symbol resolution. */
const CODE_FILE_EXT_RE =
  /\.(tsx?|jsx?|mjs|cjs|vue|svelte|py|rs|go|java|kt|cs|cpp|h|hpp|fake|md)$/i;

/** Heuristic: ref looks like a file path rather than a bare symbol name. */
function looksLikeFilePath(ref) {
  if (ref.includes('/') || ref.includes('\\')) return true;
  return CODE_FILE_EXT_RE.test(ref);
}

/** Normalize a file path ref to posix separators. */
function normalizeFileRef(ref) {
  return String(ref).trim().replace(/\\/g, '/');
}

/**
 * FTS5 + cold-index LSP fallback symbol search.
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<{ matches: object[], indexCold: boolean, lspError?: string, error?: string }>}
 */
export async function findSymbol(query, limit = 20) {
  await ensureIndexFreshForQuery();
  const q = String(query ?? '').trim();
  if (!q) return { matches: [], indexCold: false, error: 'query is required' };
  const repo = activeRepoKey();
  const db = getCodeDb(repo);
  const max = Math.min(50, Math.max(1, Math.floor(limit)));
  const { symbolCount } = getIndexStats(db, repo);
  const indexCold = symbolCount === 0;

  const tokens = tokenizeSymbolQuery(q);
  const ftsQuery = buildFtsMatchQuery(tokens);
  const ftsMatches = searchSymbolsFts(db, repo, ftsQuery, max);

  /** @type {Array<Record<string, unknown>>} */
  const matches = ftsMatches.map((row) => ({ ...row, source: 'index' }));
  const seen = new Set(matches.map((m) => m.id));

  if (matches.length < max && tokens.length > 0) {
    const likeMatches = searchSymbolsLike(db, repo, tokens, max - matches.length, seen);
    for (const row of likeMatches) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      matches.push({ ...row, source: 'index' });
      if (matches.length >= max) break;
    }
  }

  if (!indexCold) {
    return { matches, indexCold: false };
  }

  let lspError;
  const code = await loadBrainCodeConfig();
  await ensureBrainLspProjectReady(getEffectiveWorkspaceRoot(), {
    enabled: code.autoScaffoldIndexConfig !== false,
  });
  const { symbols, error } = await getLspWorkspaceSymbols(q);
  if (error) lspError = error;

  for (const sym of symbols ?? []) {
    const id = `${repo}:${sym.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    matches.push({
      id,
      repo,
      kind: String(sym.kind ?? 'symbol'),
      name: sym.name,
      file: sym.path,
      line_start: (sym.range?.start?.line ?? 0) + 1,
      line_end: (sym.range?.end?.line ?? sym.range?.start?.line ?? 0) + 1,
      signature: sym.containerName ? `${sym.name} in ${sym.containerName}` : sym.name,
      source: 'lsp',
    });
    if (matches.length >= max) break;
  }

  return {
    matches,
    indexCold: true,
    ...(lspError ? { lspError } : {}),
  };
}

/**
 * Incoming call edges for a symbol id or bare name.
 * @param {string} symbolRef
 */
export async function whoCalls(symbolRef) {
  await ensureIndexFreshForQuery();
  const repo = activeRepoKey();
  const db = getCodeDb(repo);
  const id = resolveSymbolId(db, repo, symbolRef);
  if (!id) return { symbol: null, callers: [], error: 'symbol not found' };

  const symbol = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id);
  const rows = db
    .prepare(
      `SELECT e.src_symbol, e.kind, s.name, s.file, s.line_start, s.line_end, s.signature
       FROM edges e
       JOIN symbols s ON s.id = e.src_symbol
       WHERE e.dst_symbol = ? AND e.kind = 'calls'
       ORDER BY s.file, s.line_start`,
    )
    .all(id);

  return {
    symbol,
    callers: rows.map((row) => ({
      symbolId: row.src_symbol,
      name: row.name,
      file: row.file,
      line: row.line_start,
      signature: row.signature,
      kind: row.kind,
    })),
  };
}

/**
 * Outgoing call edges for a symbol id or bare name.
 * @param {string} symbolRef
 */
export async function callsOf(symbolRef) {
  await ensureIndexFreshForQuery();
  const repo = activeRepoKey();
  const db = getCodeDb(repo);
  const id = resolveSymbolId(db, repo, symbolRef);
  if (!id) return { symbol: null, callees: [], error: 'symbol not found' };

  const symbol = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id);
  const rows = db
    .prepare(
      `SELECT e.dst_symbol, e.kind, s.name, s.file, s.line_start, s.line_end, s.signature
       FROM edges e
       JOIN symbols s ON s.id = e.dst_symbol
       WHERE e.src_symbol = ? AND e.kind = 'calls'
       ORDER BY s.file, s.line_start`,
    )
    .all(id);

  return {
    symbol,
    callees: rows.map((row) => ({
      symbolId: row.dst_symbol,
      name: row.name,
      file: row.file,
      line: row.line_start,
      signature: row.signature,
      kind: row.kind,
    })),
  };
}

/**
 * Read the current source span for a symbol from disk (not cached body).
 * @param {string} symbolRef
 */
export async function readSymbol(symbolRef) {
  await ensureIndexFreshForQuery();
  const repo = activeRepoKey();
  const db = getCodeDb(repo);
  const id = resolveSymbolId(db, repo, symbolRef);
  if (!id) return { symbol: null, text: '', error: 'symbol not found' };

  const symbol = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id);
  const root = getEffectiveWorkspaceRoot();
  const abs = path.join(root, symbol.file);
  const content = await fs.readFile(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(symbol.line_start - 1, symbol.line_end);
  const numbered = slice
    .map((line, idx) => `${symbol.line_start + idx}: ${line}`)
    .join('\n');

  return {
    symbol,
    text: numbered,
  };
}

/**
 * Token-budgeted signature map, optionally focused on one or more substrings.
 *
 * Read-only by design. An earlier `focusFiles` option ran a personalized
 * `recomputePageRank` here: a full-graph power iteration plus a rewrite of every
 * `symbols.pagerank` row, on the request path, whose biased scores then leaked
 * into every later unfocused query. `focus` filters (or, for injection, boosts)
 * on already-ranked rows instead — same intent, no compute and no side effect.
 *
 * @param {{
 *   repo?: string,
 *   focus?: string | string[],
 *   tokenBudget?: number,
 *   profile?: 'default' | 'injection',
 *   skipStalenessCheck?: boolean,
 * }} [opts]
 */
export async function repoMap(opts = {}) {
  if (!opts.skipStalenessCheck) {
    await ensureIndexFreshForQuery();
  }
  const code = await loadBrainCodeConfig();
  const repo = resolveRepoKey(opts.repo);
  const db = getCodeDb(repo);

  const profile = opts.profile === 'injection' ? 'injection' : 'default';
  const budget =
    profile === 'injection'
      ? clampRepoMapInjectionTokenBudget(
          opts.tokenBudget ?? code.repoMapInjectionTokenBudget,
        )
      : clampRepoMapTokenBudget(opts.tokenBudget ?? code.repoMapTokenBudget);
  const sqlLimit = Math.max(800, Math.min(80_000, Math.ceil(budget * 4)));
  const rows =
    db
      .prepare(
        `SELECT id, file, signature, kind, pagerank, usage_count, line_start
       FROM symbols
       WHERE repo = ?
       ORDER BY pagerank DESC, usage_count DESC, file, line_start
       LIMIT ?`,
      )
      .all(repo, sqlLimit) ?? [];

  /** @type {typeof rows} */
  let symbolRows = rows;
  if (symbolRows.length === 0) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM symbols').get()?.n ?? 0;
    if (total > 0) {
      symbolRows = db
        .prepare(
          `SELECT id, file, signature, kind, pagerank, usage_count, line_start
         FROM symbols
         ORDER BY pagerank DESC, usage_count DESC, file, line_start`,
        )
        .all();
    }
  }

  const symbols =
    profile === 'injection'
      ? prepareRepoMapSymbolsForInjection(symbolRows)
      : prepareRepoMapSymbols(symbolRows);
  return renderRepoMap(symbols, budget, { focus: opts.focus, profile });
}

/**
 * Resolve a symbol reference to a stable id.
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} symbolRef
 */
function resolveSymbolId(db, repo, symbolRef) {
  const ref = String(symbolRef ?? '').trim();
  if (!ref) return null;
  if (ref.includes(':')) {
    const hit = db.prepare('SELECT id FROM symbols WHERE id = ?').get(ref);
    return hit?.id ?? null;
  }
  const qualified = `${repo}:${ref}`;
  const exact = db.prepare('SELECT id FROM symbols WHERE id = ?').get(qualified);
  if (exact) return exact.id;
  const byName = db
    .prepare(
      `SELECT id FROM symbols WHERE repo = ? AND name = ? ORDER BY pagerank DESC, usage_count DESC LIMIT 1`,
    )
    .get(repo, ref);
  if (byName) return byName.id;

  if (!looksLikeFilePath(ref)) return null;

  const normPath = normalizeFileRef(ref);
  const byExactFile = db
    .prepare(
      `SELECT id FROM symbols WHERE repo = ? AND file = ? ORDER BY pagerank DESC, usage_count DESC LIMIT 1`,
    )
    .get(repo, normPath);
  if (byExactFile) return byExactFile.id;

  const byFileSubstring = db
    .prepare(
      `SELECT id FROM symbols WHERE repo = ? AND file LIKE ? ORDER BY pagerank DESC, usage_count DESC LIMIT 1`,
    )
    .get(repo, `%${normPath}%`);
  return byFileSubstring?.id ?? null;
}

export { reindexCode } from './indexer.js';
export { runCascade } from './cascade.js';
export { explainSymbol, resolveAnchorsToCode } from './anchors.js';
