/**
 * Agent-facing Brain code-index tools — repo map, symbol search, call graph, read def.
 *
 * Output format is a token budget, not a style choice: these results land in an
 * agent's context, so every line drops what the agent can already derive (the
 * repo prefix on an id, the file path repeated per caller, a signature that
 * restates the name) and keeps what it cannot (path, line, kind).
 */

import {
  ensureWarmCodeIndex,
  explainSymbol,
  findSymbol,
  loadBrainCodeConfig,
  readSymbol,
  repoMap,
  whoCalls,
} from '../brain/code/query.js';
import { REPO_MAP_TOOL_DEFAULT_TOKEN_BUDGET } from '../brain/code/config.js';

/** Callers listed in full before `who_calls` summarizes the tail. */
const WHO_CALLS_MAX = 60;

async function ensureCodeEnabled() {
  const code = await loadBrainCodeConfig();
  if (!code.enabled) {
    return 'Error: Brain code index is disabled in Settings → Brain → Code.';
  }
  return null;
}

/** Strip the `repo:` prefix from a symbol id — constant across every row. */
function shortSymbolId(id) {
  const raw = String(id ?? '');
  const colon = raw.indexOf(':');
  return colon >= 0 ? raw.slice(colon + 1) : raw;
}

/**
 * Token-budgeted signature map of the indexed repo.
 * @param {Record<string, unknown>} args
 */
export async function toolRepoMap(args) {
  const disabled = await ensureCodeEnabled();
  if (disabled) return disabled;

  const warm = await ensureWarmCodeIndex();
  if (!warm.symbolCount) {
    if (warm.warming) {
      return 'Code index is cold; indexing just started in the background (this takes a few minutes on a large repo). Use `grep` for now and retry repo_map later.';
    }
    return 'Code index is cold. Reindex failed or workspace has no indexable files. Use `grep` as fallback.';
  }

  const code = await loadBrainCodeConfig();
  const requested =
    typeof args?.token_budget === 'number'
      ? args.token_budget
      : typeof args?.tokenBudget === 'number'
        ? args.tokenBudget
        : undefined;

  const map = await repoMap({
    focus: args?.focus != null ? String(args.focus) : undefined,
    tokenBudget:
      requested ?? Math.min(code.repoMapTokenBudget, REPO_MAP_TOOL_DEFAULT_TOKEN_BUDGET),
  });
  return map.text;
}

/**
 * Find a symbol definition by name (SQLite index; LSP when cold).
 * @param {Record<string, unknown>} args
 */
export async function toolFindSymbol(args) {
  const disabled = await ensureCodeEnabled();
  if (disabled) return disabled;

  const query = String(args?.query ?? args?.symbol ?? '').trim();
  if (!query) return 'Error: query is required.';

  const limit = typeof args?.limit === 'number' ? args.limit : 10;
  const { matches, indexCold, lspError, error } = await findSymbol(query, limit);
  if (error) return `Error: ${error}`;
  if (!matches.length) {
    if (indexCold && lspError) {
      return `Code index is cold and LSP is unavailable (${lspError}). Run repo_map to build the index, or use grep.`;
    }
    if (indexCold) {
      return 'Code index is cold. Run repo_map first, then retry, or use grep.';
    }
    // Deliberately does not suggest a file path: find_symbol matches symbol
    // names, so a path query returns every symbol whose text mentions it.
    return `No symbols matched "${query}". Try the exact name, or repo_map with focus:"<file or feature>" to see what a file defines, or grep for a raw string.`;
  }

  const lines = matches.map((m) => {
    const name = shortSymbolId(m.id);
    const sig = String(m.signature ?? '').trim();
    const body = sig && sig !== name ? sig : `${m.kind} ${m.name}`;
    return `${m.file}:${m.line_start} ${body}`;
  });
  return [`${matches.length} match(es) for "${query}":`, ...lines].join('\n');
}

/**
 * List incoming call edges (exact graph, not string search).
 * @param {Record<string, unknown>} args
 */
export async function toolWhoCalls(args) {
  const disabled = await ensureCodeEnabled();
  if (disabled) return disabled;

  const symbol = String(args?.symbol ?? '').trim();
  if (!symbol) return 'Error: symbol is required (id or name).';

  const { symbol: row, callers, error } = await whoCalls(symbol);
  if (!row) {
    return (
      error ??
      `Not found: "${symbol}". Pass a bare symbol name, a qualified name from find_symbol, or a file path.`
    );
  }

  if (!callers.length) {
    return `No indexed callers of ${shortSymbolId(row.id)} (${row.file}:${row.line_start}). Use grep if the index is stale.`;
  }

  // Group by file: on a high-fan-in symbol — the case who_calls exists for —
  // repeating the path on every row is most of the result.
  const byFile = new Map();
  for (const c of callers.slice(0, WHO_CALLS_MAX)) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }

  const lines = [`${callers.length} caller(s) of ${shortSymbolId(row.id)}:`];
  for (const [file, list] of byFile) {
    lines.push(file);
    for (const c of list) {
      lines.push(`  ${c.line} ${shortSymbolId(c.symbolId)}`);
    }
  }
  if (callers.length > WHO_CALLS_MAX) {
    lines.push(
      `… ${callers.length - WHO_CALLS_MAX} more not listed — grep the name to enumerate the rest.`,
    );
  }
  return lines.join('\n');
}

/**
 * Read the current source span for a symbol (fresh from disk).
 * @param {Record<string, unknown>} args
 */
export async function toolReadSymbol(args) {
  const disabled = await ensureCodeEnabled();
  if (disabled) return disabled;

  const symbol = String(args?.symbol ?? '').trim();
  if (!symbol) return 'Error: symbol is required (id or name).';

  const { symbol: row, text, error } = await readSymbol(symbol);
  if (!row) {
    return (
      error ??
      `Not found: "${symbol}". Pass a bare symbol name, a qualified name from find_symbol, or a file path.`
    );
  }

  const header = `${row.file}:${row.line_start}-${row.line_end}  ${row.signature}`;

  // The wiki-anchor bridge used to be its own tool. Nothing anchors symbols in
  // most workspaces, so as a tool it was a schema every agent paid for and a
  // "no pages anchor this" answer every time. Here it costs nothing when the
  // wiki is silent and arrives unasked when it is not.
  let anchors = '';
  try {
    const { pages } = await explainSymbol(row.id);
    if (pages?.length) {
      const titles = pages
        .slice(0, 3)
        .map((p) => `${p.path}${p.status === 'stale' ? ' (stale)' : ''}`);
      anchors = `\nExplained in Brain: ${titles.join(', ')} — brain_read_page for the design intent.`;
    }
  } catch {
    // An anchor lookup must never fail a source read.
  }

  return `${header}${anchors}\n\n${text}`;
}
