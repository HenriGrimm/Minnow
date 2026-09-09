/**
 * Repo-map symbol filtering, ranking, and display formatting.
 * Keeps the map focused on navigable surface area (not LSP leaf noise).
 */

/** Kinds omitted from repo-map output (still indexed for search / call graph). */
export const REPO_MAP_EXCLUDED_KINDS = new Set(['property', 'field', 'variable', 'string']);

/** Injection profile: max dotted nesting (1 = class.method; no method-body children). */
export const REPO_MAP_INJECTION_MAX_DEPTH = 1;

/** Kinds omitted from injection maps (top-level UI style constants, etc.). */
export const REPO_MAP_INJECTION_EXCLUDED_KINDS = new Set([
  ...REPO_MAP_EXCLUDED_KINDS,
  'constant',
]);

/**
 * True when a file should be omitted from repo-map output (still indexed elsewhere).
 * @param {string} file
 */
export function isRepoMapTestPath(file) {
  const f = String(file ?? '').replace(/\\/g, '/').toLowerCase();
  if (!f) return false;
  if (f.startsWith('test/') || f.startsWith('tests/')) return true;
  if (/\/(test|tests|__tests__|fixtures)\//.test(f)) return true;
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return true;
  return false;
}

/**
 * True when a file is third-party, generated, or minified — never navigable source.
 *
 * Such files export short generic names (`has`, `round`, `resolve`) that collide
 * by name with real symbols, which turns them into PageRank super-nodes and
 * floats them to the top of an otherwise good map. Filtered from every profile.
 * @param {string} file
 */
export function isRepoMapVendorPath(file) {
  const f = String(file ?? '').replace(/\\/g, '/').toLowerCase();
  if (!f) return false;
  if (/(^|\/)(vendor|vendored|third[-_]party|externals|generated|__generated__)\//.test(f)) {
    return true;
  }
  if (/(^|\/)(dist|build|out|coverage)\//.test(f)) return true;
  if (/\.(min|bundle|generated|gen)\.[a-z]+$/.test(f)) return true;
  return false;
}

/**
 * Extra test / harness / one-off paths omitted from injection maps only.
 *
 * The tool map still shows these — an agent that focuses on `scripts/` means it.
 * The injection is orientation for a coding chat, where build scripts are noise.
 * @param {string} file
 */
export function isRepoMapInjectionTestPath(file) {
  if (isRepoMapTestPath(file)) return true;
  const f = String(file ?? '').replace(/\\/g, '/').toLowerCase();
  if (!f) return false;
  if (/vitest\.setup\./.test(f)) return true;
  if (/\.vitest\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return true;
  if (/test-ws/.test(f)) return true;
  if (/\/__mocks__\//.test(f)) return true;
  if (/^(scripts|tools|bin|examples?|samples|benchmarks?)\//.test(f)) return true;
  return false;
}

/**
 * Qualified symbol name from a stable id (`repo:Outer.Inner`).
 * @param {string} id
 */
export function qualifiedNameFromSymbolId(id) {
  const raw = String(id ?? '');
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/**
 * Nesting depth from dotted qualified name (0 = top-level).
 * @param {string} qualified
 */
export function symbolNestingDepth(qualified) {
  const q = String(qualified ?? '').trim();
  if (!q) return 0;
  return q.split('.').length - 1;
}

/**
 * True when a symbol is LSP noise for injection (nested constants, callbacks).
 * @param {{ id: string, signature?: string, kind?: string }} sym
 */
export function isRepoMapInjectionNoiseSymbol(sym) {
  const qualified = qualifiedNameFromSymbolId(sym.id);
  const depth = symbolNestingDepth(qualified);
  if (depth > REPO_MAP_INJECTION_MAX_DEPTH) return true;
  const kind = String(sym.kind ?? 'symbol');
  if (REPO_MAP_INJECTION_EXCLUDED_KINDS.has(kind)) return true;
  if (depth > 0) {
    const hay = `${qualified} ${sym.signature ?? ''}`.toLowerCase();
    if (/\bcallback\b/.test(hay)) return true;
    if (/<function>/.test(hay)) return true;
    if (/\.(map|filter|forEach|then|catch|finally)\(\)/.test(hay)) return true;
  }
  return false;
}

/**
 * Filter and re-rank symbols for repo-map rendering.
 * @param {Array<{
 *   id: string,
 *   file: string,
 *   signature?: string,
 *   kind?: string,
 *   pagerank?: number,
 *   usage_count?: number,
 *   line_start?: number,
 * }>} rows
 */
export function prepareRepoMapSymbols(rows) {
  /** @type {Array<Record<string, unknown>>} */
  const prepared = [];
  for (const sym of rows ?? []) {
    if (isRepoMapTestPath(sym.file)) continue;
    if (isRepoMapVendorPath(sym.file)) continue;
    const kind = String(sym.kind ?? 'symbol');
    if (REPO_MAP_EXCLUDED_KINDS.has(kind)) continue;
    const pagerank = Number(sym.pagerank ?? 0);
    const usage = Number(sym.usage_count ?? 0);
    prepared.push({
      ...sym,
      _repoMapScore: pagerank + usage * 0.0001,
    });
  }
  prepared.sort((a, b) => {
    const scoreDelta = (b._repoMapScore ?? 0) - (a._repoMapScore ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    const prDelta = (b.pagerank ?? 0) - (a.pagerank ?? 0);
    if (prDelta !== 0) return prDelta;
    const fileCmp = String(a.file).localeCompare(String(b.file));
    if (fileCmp !== 0) return fileCmp;
    return (a.line_start ?? 0) - (b.line_start ?? 0);
  });
  return prepared.map(({ _repoMapScore, ...sym }) => sym);
}

/**
 * Filter symbols for per-send code-map injection (higher signal per token).
 * @param {Array<Record<string, unknown>>} rows
 */
export function prepareRepoMapSymbolsForInjection(rows) {
  /** @type {Array<Record<string, unknown>>} */
  const prepared = [];
  for (const sym of rows ?? []) {
    if (isRepoMapInjectionTestPath(sym.file)) continue;
    if (isRepoMapVendorPath(sym.file)) continue;
    if (isRepoMapInjectionNoiseSymbol(sym)) continue;
    const pagerank = Number(sym.pagerank ?? 0);
    const usage = Number(sym.usage_count ?? 0);
    prepared.push({
      ...sym,
      _repoMapScore: pagerank + usage * 0.0001,
    });
  }
  prepared.sort((a, b) => {
    const scoreDelta = (b._repoMapScore ?? 0) - (a._repoMapScore ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    const prDelta = (b.pagerank ?? 0) - (a.pagerank ?? 0);
    if (prDelta !== 0) return prDelta;
    const fileCmp = String(a.file).localeCompare(String(b.file));
    if (fileCmp !== 0) return fileCmp;
    return (a.line_start ?? 0) - (b.line_start ?? 0);
  });
  return prepared.map(({ _repoMapScore, ...sym }) => sym);
}

/**
 * Kind-tagged symbol body (no indent or path prefix).
 * @param {{ id: string, signature?: string, kind?: string }} sym
 */
export function formatRepoMapSymbolBody(sym) {
  const qualified = qualifiedNameFromSymbolId(sym.id);
  const depth = symbolNestingDepth(qualified);
  const kind = String(sym.kind ?? 'symbol');
  const shortName = qualified.split('.').pop() ?? qualified;
  const rawSig = sym.signature?.trim() || `${kind} ${shortName}`;

  let body = rawSig;
  if (depth > 0) {
    const prefix = `${kind} ${shortName}`;
    if (body.startsWith(prefix)) {
      const tail = body.slice(prefix.length).trim();
      body = tail
        ? `${shortName}${tail.startsWith('(') ? '' : ' '}${tail}`
        : shortName;
    } else {
      body = shortName;
    }
    body = `[${kind}] ${body}`;
  } else if (body.startsWith(`${kind} `)) {
    body = `[${kind}] ${body.slice(kind.length + 1)}`;
  } else if (!body.startsWith('[')) {
    body = `[${kind}] ${body}`;
  }
  return body;
}

/**
 * One repo-map bullet with indent + [kind] tag for scanability.
 * @param {{ id: string, signature?: string, kind?: string }} sym
 */
export function formatRepoMapSymbolLine(sym) {
  const qualified = qualifiedNameFromSymbolId(sym.id);
  const depth = symbolNestingDepth(qualified);
  const indent = '  '.repeat(depth);
  return `${indent}- ${formatRepoMapSymbolBody(sym)}`;
}

/**
 * Injection line: path:line anchor + kind body (no repeated file headers).
 * @param {{ id: string, file: string, line_start?: number, signature?: string, kind?: string }} sym
 */
export function formatRepoMapInjectionLine(sym) {
  const qualified = qualifiedNameFromSymbolId(sym.id);
  const depth = symbolNestingDepth(qualified);
  const indent = '  '.repeat(depth);
  const line = Math.max(1, Number(sym.line_start ?? 1));
  const file = String(sym.file ?? '').replace(/\\/g, '/');
  return `${indent}- ${file}:${line} ${formatRepoMapSymbolBody(sym)}`;
}
