import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRipgrepPath } from '../../lib/ripgrep-path.js';
import {
  getLspCallHierarchy,
  getLspDocumentSymbolsForScope,
  LSP_SCOPE_INDEX,
  notifyLspDocumentForScope,
} from '../../lsp/manager.js';
import { brainWorkspaceKeyFromPath } from '../paths.js';
import { getEffectiveWorkspaceRoot } from '../../runtime/path-access.js';
import { normalizeBrainCodeConfig } from './config.js';
import {
  deleteSymbolsForFile,
  getCodeDb,
  purgeFileFromIndex,
  upsertEdge,
  upsertFileHash,
  writeFileSymbols,
  writePageRanks,
} from './schema.js';
import {
  buildAdjacency,
  buildPersonalizationVector,
  personalizedPageRank,
} from './rank.js';
import { ensureBrainLspProjectReady } from './project-scaffold.js';
import { reportIndexProgress } from './index-progress.js';

const execFileAsync = promisify(execFile);

const rgExecutable = getRipgrepPath();

const KIND_NAMES = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  22: 'enum-member',
  23: 'struct',
};

// ── Symbols ──────────────────────────────────────────────────────────────────

/**
 * @param {number | string | undefined} kind
 */
export function symbolKindName(kind) {
  if (typeof kind === 'string' && kind) return kind;
  const n = Number(kind);
  return KIND_NAMES[n] ?? 'symbol';
}

/**
 * @param {string} repo
 * @param {string} qualifiedName
 */
export function buildSymbolId(repo, qualifiedName) {
  return `${repo}:${qualifiedName}`;
}

/**
 * @param {string} name
 * @param {string} kind
 * @param {string} [detail]
 */
export function elideSignature(name, kind, detail) {
  const base = detail?.trim() ? `${kind} ${name}${detail.trim().startsWith('(') ? '' : ' '}${detail.trim()}` : `${kind} ${name}`;
  if (base.length <= 120) return base;
  return `${base.slice(0, 117)}…`;
}

/**
 * @param {string[]} lines
 * @param {{ start: { line: number }, end: { line: number } }} range
 */
export function hashSymbolSpan(lines, range) {
  const start = Math.max(0, range?.start?.line ?? 0);
  const end = Math.max(start, range?.end?.line ?? start);
  const slice = lines.slice(start, end + 1).join('\n');
  return createHash('sha256').update(slice, 'utf8').digest('hex');
}

/**
 * @param {Array<Record<string, unknown>>} symbols
 * @param {string} repo
 * @param {string} file
 * @param {string[]} lines
 * @param {string} [prefix]
 */
export function flattenDocumentSymbols(symbols, repo, file, lines, prefix = '') {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const sym of symbols ?? []) {
    if (!sym || typeof sym !== 'object') continue;
    const name = String(sym.name ?? '');
    if (!name) continue;
    const qualified = prefix ? `${prefix}.${name}` : name;
    const kind = symbolKindName(sym.kind);
    const range = sym.range ?? sym.selectionRange;
    const lineStart = (range?.start?.line ?? 0) + 1;
    const lineEnd = (range?.end?.line ?? range?.start?.line ?? 0) + 1;
    const signature = elideSignature(name, kind, sym.detail != null ? String(sym.detail) : '');
    const contentHash = hashSymbolSpan(lines, range ?? { start: { line: 0 }, end: { line: 0 } });
    const id = buildSymbolId(repo, qualified);
    out.push({
      id,
      repo,
      kind,
      name,
      qualified,
      file,
      line_start: lineStart,
      line_end: lineEnd,
      signature,
      doc: sym.detail != null ? String(sym.detail) : '',
      content_hash: contentHash,
      selection: sym.selectionRange ?? range,
    });
    if (Array.isArray(sym.children) && sym.children.length > 0) {
      out.push(...flattenDocumentSymbols(sym.children, repo, file, lines, qualified));
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {string} relOrAbs
 */
export function normalizeIndexableRelPath(root, relOrAbs) {
  const normalizedRoot = path.resolve(root);
  const rootPosix = normalizedRoot.replace(/\\/g, '/');
  let candidate = String(relOrAbs ?? '').trim().replace(/\\/g, '/');
  if (!candidate) return '';

  const marker = `${rootPosix}/`;
  const doubled = `${rootPosix}/${rootPosix}/`;
  if (candidate.includes(doubled)) {
    candidate = candidate.split(doubled).pop() ?? candidate;
  }
  while (candidate.startsWith(marker)) {
    candidate = candidate.slice(marker.length);
  }

  let abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(normalizedRoot, candidate);
  let rel = path.relative(normalizedRoot, abs).replace(/\\/g, '/');

  if (!rel || rel.startsWith('..')) {
    const tail = candidate.includes(marker) ? candidate.split(marker).pop() : candidate;
    if (tail) {
      abs = path.resolve(normalizedRoot, tail);
      rel = path.relative(normalizedRoot, abs).replace(/\\/g, '/');
    }
  }

  if (!rel || rel.startsWith('..')) return '';
  return rel;
}

/**
 * @param {string} root
 * @param {string[]} includeGlobs
 * @param {string[]} excludeGlobs
 */
export async function listIndexableFiles(root, includeGlobs, excludeGlobs) {
  const args = ['--files', '--no-messages'];
  for (const glob of excludeGlobs ?? []) {
    if (glob.trim()) args.push('--glob', `!${glob.replace(/^!/, '')}`);
  }
  for (const glob of includeGlobs ?? []) {
    if (glob.trim()) args.push('--glob', glob);
  }
  args.push(root);
  let stdout = '';
  try {
    const result = await execFileAsync(rgExecutable, args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = result.stdout ?? '';
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (code === 1) {
      return [];
    }
    throw err;
  }
  const rel = stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
  const normalizedRoot = path.resolve(root);
  return rel
    .map((p) => normalizeIndexableRelPath(normalizedRoot, p))
    .filter(Boolean);
}

/**
 * @param {Map<string, { id: string, line_start: number, line_end: number }>} byFileLine
 * @param {string} repo
 * @param {{ name?: string, path?: string, range?: { start?: { line?: number } } }} item
 */
function resolveCallItemToSymbolId(byFileLine, repo, item) {
  const file = String(item.path ?? '').replace(/\\/g, '/');
  const line = (item.range?.start?.line ?? 0) + 1;
  const key = `${file}:${line}`;
  const hit = byFileLine.get(key);
  if (hit) return hit.id;
  const name = String(item.name ?? '');
  if (!name) return null;
  return buildSymbolId(repo, name);
}

// ── Index file ───────────────────────────────────────────────────────────────

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {string} relFile
 * @param {string} absFile
 * @param {Map<string, { id: string, line_start: number, line_end: number }>} globalByFileLine
 */
export async function indexSingleFile(db, repo, relFile, absFile, globalByFileLine) {
  const text = await fs.readFile(absFile, 'utf8');
  const lines = text.split(/\r?\n/);
  const stat = await fs.stat(absFile);
  const fileHash = createHash('sha256').update(text, 'utf8').digest('hex');

  await notifyLspDocumentForScope(LSP_SCOPE_INDEX, relFile, 'open', text);
  const { symbols: tree, error } = await getLspDocumentSymbolsForScope(
    LSP_SCOPE_INDEX,
    relFile,
  );
  if (error) {
    upsertFileHash(db, repo, relFile, fileHash, stat.mtimeMs, error);
    await notifyLspDocumentForScope(LSP_SCOPE_INDEX, relFile, 'close');
    return { file: relFile, symbols: 0, edges: 0, error };
  }

  const flat = flattenDocumentSymbols(tree, repo, relFile, lines);
  const symbolRows = flat.map((row) => ({
    id: row.id,
    repo: row.repo,
    kind: row.kind,
    name: row.name,
    file: row.file,
    line_start: row.line_start,
    line_end: row.line_end,
    signature: row.signature,
    doc: row.doc,
    content_hash: row.content_hash,
    pagerank: 0,
    usage_count: 0,
  }));
  writeFileSymbols(db, repo, relFile, symbolRows);

  const byFileLine = new Map();
  for (const row of flat) {
    byFileLine.set(`${relFile}:${row.line_start}`, {
      id: row.id,
      line_start: row.line_start,
      line_end: row.line_end,
    });
    globalByFileLine.set(`${relFile}:${row.line_start}`, {
      id: row.id,
      line_start: row.line_start,
      line_end: row.line_end,
    });
  }

  let edgeCount = 0;
  for (const row of flat) {
    const kind = row.kind;
    if (!['function', 'method', 'constructor'].includes(kind)) continue;
    const sel = row.selection ?? { start: { line: row.line_start - 1, character: 0 } };
    const line = sel.start?.line ?? row.line_start - 1;
    const character = sel.start?.character ?? 0;
    const hierarchy = await getLspCallHierarchy(relFile, line, character, {
      scope: LSP_SCOPE_INDEX,
      includeIncoming: false,
    });
    if (!hierarchy.item) continue;

    for (const out of hierarchy.outgoingCalls ?? []) {
      const dst = resolveCallItemToSymbolId(globalByFileLine, repo, out.to ?? {});
      if (!dst) continue;
      upsertEdge(db, row.id, dst, 'calls');
      edgeCount += 1;
    }
  }

  upsertFileHash(db, repo, relFile, fileHash, stat.mtimeMs, null);
  await notifyLspDocumentForScope(LSP_SCOPE_INDEX, relFile, 'close');
  return { file: relFile, symbols: flat.length, edges: edgeCount };
}

const USAGE_AUGMENT_MAX_SYMBOLS = 50_000;

const USAGE_SCAN_MAX_MATCHES = 5_000_000;

const MAX_REPORTED_INDEX_ERRORS = 50;

const MAX_ERROR_SUMMARY_GROUPS = 8;

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} fn
 * @param {() => boolean} [shouldContinue]
 */
export async function runBoundedPool(items, concurrency, fn, shouldContinue = () => true) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length && shouldContinue()) {
      const idx = nextIdx++;
      await fn(items[idx]);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} repo
 * @param {ReturnType<typeof getEffectiveWorkspaceRoot>} root
 */
async function augmentUsageCounts(db, repo, root) {
  const symbols = db
    .prepare(
      `SELECT id, name FROM symbols WHERE repo = ?
       ORDER BY usage_count DESC, pagerank DESC
       LIMIT ?`,
    )
    .all(repo, USAGE_AUGMENT_MAX_SYMBOLS);

  /** @type {Map<string, string[]>} */
  const idsByName = new Map();
  for (const sym of symbols) {
    const name = String(sym.name ?? '');
    if (!name || name.length < 3) continue;
    const bucket = idsByName.get(name);
    if (bucket) bucket.push(sym.id);
    else idsByName.set(name, [sym.id]);
  }
  if (idsByName.size === 0) return;

  const args = [
    '--only-matching',
    '--no-filename',
    '--no-line-number',
    '--no-messages',
    '-e',
    '\\b[A-Za-z_][A-Za-z0-9_]{2,}\\b',
    root,
  ];

  /** @type {Map<string, number>} */
  const counts = new Map();

  await new Promise((resolve, reject) => {
    const child = spawn(rgExecutable, args, { cwd: root, windowsHide: true });
    let residual = '';
    let matches = 0;
    let capped = false;
    let settled = false;

    /** @param {string} token */
    const tally = (token) => {
      const name = token.trim();
      if (!name || !idsByName.has(name)) return;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };

    const settle = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (capped) return;
      residual += chunk;
      const lines = residual.split(/\r?\n/);
      residual = lines.pop() ?? '';
      for (const line of lines) tally(line);
      matches += lines.length;
      if (matches >= USAGE_SCAN_MAX_MATCHES) {
        capped = true;
        residual = '';
        child.kill();
      }
    });
    child.on('close', () => {
      if (!capped && residual) tally(residual);
      settle();
    });
    child.on('error', settle);
  });

  const stmts = db.prepare('UPDATE symbols SET usage_count = ? WHERE id = ?');
  const tx = db.transaction((entries) => {
    for (const [name, hitCount] of entries) {
      const ids = idsByName.get(name);
      if (!ids) continue;
      for (const id of ids) {
        stmts.run(hitCount, id);
      }
    }
  });
  tx([...counts.entries()]);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Set<string>} [focusFiles]
 */
export function recomputePageRank(db, focusFiles = new Set()) {
  const edges = db.prepare('SELECT src_symbol, dst_symbol FROM edges').all();
  const { out, nodes } = buildAdjacency(edges);
  if (nodes.size === 0) return 0;
  const symbols = db.prepare('SELECT id, file, usage_count FROM symbols').all();
  const personal = buildPersonalizationVector(nodes, symbols, focusFiles);
  const ranks = personalizedPageRank(out, nodes, personal);
  return writePageRanks(db, ranks);
}

// ── Reindex ──────────────────────────────────────────────────────────────────

/**
 * @param {{ files?: string[], focusFiles?: string[], force?: boolean, codeConfig?: ReturnType<typeof normalizeBrainCodeConfig> }} [opts]
 */
export async function reindexCode(opts = {}) {
  const root = getEffectiveWorkspaceRoot();
  const repo = brainWorkspaceKeyFromPath(root) || 'workspace';
  const codeConfig = opts.codeConfig ?? normalizeBrainCodeConfig(null);
  const db = getCodeDb(repo);

  const scaffold = await ensureBrainLspProjectReady(root, {
    enabled: codeConfig.autoScaffoldIndexConfig !== false,
  });

  let files = opts.files?.map((f) => normalizeIndexableRelPath(root, f)).filter(Boolean) ?? null;
  if (!files) {
    files = await listIndexableFiles(root, codeConfig.includeGlobs, codeConfig.excludeGlobs);
  }

  const globalByFileLine = new Map();
  const results = [];
  const isIncremental = Boolean(opts.files?.length);
  const filesToProcess = [];

  for (const relFile of files) {
    const absFile = path.join(root, relFile);
    try {
      const stat = await fs.stat(absFile);
      if (!stat.isFile()) continue;
      const existing = db
        .prepare('SELECT sha256, index_error FROM file_hashes WHERE repo = ? AND file = ?')
        .get(repo, relFile);
      const text = await fs.readFile(absFile, 'utf8');
      const hash = createHash('sha256').update(text, 'utf8').digest('hex');
      // Content hash decides, on the incremental path too. A caller naming explicit files
      // is saying "these look stale", not "re-parse them regardless" — and a mtime-only
      // change used to arrive here as an explicit file list and re-parse the whole tree.
      // `force` remains the way to rebuild a suspect index.
      if (existing?.sha256 === hash && !existing.index_error && !opts.force) {
        continue;
      }
      filesToProcess.push({ relFile, absFile });
    } catch {
      filesToProcess.push({ relFile, absFile: path.join(root, relFile) });
    }
  }

  reportIndexProgress(repo, {
    indexing: true,
    filesDone: 0,
    filesTotal: filesToProcess.length,
    phase: 'symbols',
  });

  let filesDone = 0;
  for (const { relFile, absFile } of filesToProcess) {
    try {
      const result = await indexSingleFile(db, repo, relFile, absFile, globalByFileLine);
      results.push(result);
    } catch (err) {
      purgeFileFromIndex(db, repo, relFile);
      const message = err instanceof Error ? err.message : String(err);
      results.push({ file: relFile, symbols: 0, edges: 0, error: message });
    }
    filesDone += 1;
    reportIndexProgress(repo, {
      indexing: true,
      filesDone,
      filesTotal: filesToProcess.length,
      phase: 'symbols',
    });
  }

  reportIndexProgress(repo, {
    indexing: true,
    filesDone: filesToProcess.length,
    filesTotal: filesToProcess.length,
    phase: 'rank',
  });

  if (!opts.files) {
    const liveFiles = new Set(files);
    const orphans = db
      .prepare('SELECT file FROM file_hashes WHERE repo = ?')
      .all(repo)
      .map((row) => String(row.file))
      .filter((indexedFile) => !liveFiles.has(indexedFile));
    for (const orphan of orphans) {
      purgeFileFromIndex(db, repo, orphan);
    }
  }

  let usageAugmentError = null;
  if (!isIncremental) {
    try {
      await augmentUsageCounts(db, repo, root);
    } catch (err) {
      usageAugmentError = err instanceof Error ? err.message : String(err);
    }
  }
  const rankedSymbols = recomputePageRank(db, new Set(opts.focusFiles ?? []));

  reportIndexProgress(repo, {
    indexing: false,
    filesDone: filesToProcess.length,
    filesTotal: filesToProcess.length,
    phase: 'idle',
  });

  const symbolCount =
    db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE repo = ?').get(repo)?.n ?? 0;

  return {
    repo,
    ...summarizeIndexResults(results),
    symbolCount,
    rankedSymbols,
    results,
    scaffold,
    ...(usageAugmentError ? { usageAugmentError } : {}),
  };
}

/**
 * @param {string} message
 * @param {string} file
 */
function redactFilePath(message, file) {
  if (!file) return message.trim();
  const variants = new Set([file, file.replace(/\//g, '\\'), file.split('/').pop() ?? '']);
  let out = message;
  for (const variant of variants) {
    if (variant) out = out.split(variant).join('…');
  }
  return out.trim();
}

/**
 * @param {Array<{ file: string, symbols: number, edges: number, error?: string }>} results
 */
export function summarizeIndexResults(results) {
  const failed = results.filter((r) => r.error);
  /** @type {Map<string, { count: number, sample: string }>} */
  const groups = new Map();
  for (const row of failed) {
    const key = redactFilePath(String(row.error), String(row.file ?? ''));
    const hit = groups.get(key);
    if (hit) hit.count += 1;
    else groups.set(key, { count: 1, sample: row.file });
  }

  return {
    indexedFiles: results.length - failed.length,
    filesProcessed: results.length,
    failedFiles: failed.length,
    symbolsIndexed: results.reduce((sum, r) => sum + (r.symbols ?? 0), 0),
    edgesIndexed: results.reduce((sum, r) => sum + (r.edges ?? 0), 0),
    errors: failed
      .slice(0, MAX_REPORTED_INDEX_ERRORS)
      .map((r) => ({ file: r.file, error: String(r.error) })),
    errorSummary: [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, MAX_ERROR_SUMMARY_GROUPS)
      .map(([message, { count, sample }]) => ({ message, count, sample })),
  };
}
