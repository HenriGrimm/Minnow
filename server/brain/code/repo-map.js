/**
 * Token-budgeted repo map rendering from ranked symbols.
 */

import { estimateTokens } from './rank.js';
import { formatRepoMapInjectionLine, formatRepoMapSymbolLine } from './repo-map-symbols.js';

/** Most focus terms honoured in one map (keeps the title and the scan cheap). */
const MAX_FOCUS_TERMS = 8;

/**
 * Normalize `focus` (string or list) to lowercase terms.
 * @param {string | string[] | undefined} focus
 * @returns {string[]}
 */
export function normalizeFocusTerms(focus) {
  const raw = Array.isArray(focus) ? focus : focus == null ? [] : [focus];
  const terms = [];
  const seen = new Set();
  for (const item of raw) {
    const t = String(item ?? '').trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    terms.push(t);
    if (terms.length >= MAX_FOCUS_TERMS) break;
  }
  return terms;
}

/**
 * True when a symbol matches any focus term (id, path, or signature).
 * @param {{ id: string, file: string, signature?: string }} sym
 * @param {string[]} terms
 */
function matchesFocus(sym, terms) {
  const hay = `${sym.id} ${sym.file} ${sym.signature ?? ''}`.toLowerCase();
  for (const term of terms) {
    if (hay.includes(term)) return true;
  }
  return false;
}

/**
 * Render signature-only lines until the token budget is exhausted.
 * Symbols must be pre-sorted by rank (pagerank DESC) — output follows that order
 * so high-value symbols are not displaced by alphabetical file sorting.
 *
 * `focus` behaves differently per profile, on purpose:
 * - `default` (the `repo_map` tool) **filters** — an agent that asks for one file
 *   wants that file, not a global map with it somewhere inside.
 * - `injection` **boosts** — matches render first, then the remaining budget is
 *   filled with the global ranked surface. A weak hint can then never leave the
 *   chat with an empty map, which is what a hard filter did on a bad guess.
 *
 * @param {Array<{
 *   id: string,
 *   file: string,
 *   signature: string,
 *   pagerank?: number,
 *   kind?: string,
 *   line_start?: number,
 * }>} symbols — pre-sorted by rank descending
 * @param {number} tokenBudget
 * @param {{ focus?: string | string[], profile?: 'default' | 'injection' }} [opts]
 */
export function renderRepoMap(symbols, tokenBudget, opts = {}) {
  const budget = Math.max(50, Math.floor(tokenBudget));
  const profile = opts.profile === 'injection' ? 'injection' : 'default';
  const focusTerms = normalizeFocusTerms(opts.focus);
  const lines = [];
  /** @type {Array<{ type: string, text: string, symbolId?: string, file?: string }>} */
  const entries = [];
  let used = 0;

  const title = focusTerms.length ? `# Repo map (focus: ${focusTerms.join(', ')})` : '# Repo map';
  lines.push(title);
  entries.push({ type: 'title', text: title });
  used += estimateTokens(title);

  let currentFile = null;
  let matched = 0;
  let truncated = false;

  /**
   * Emit one symbol; returns false when the budget is spent.
   * @param {Record<string, any>} sym
   */
  const emit = (sym) => {
    if (profile !== 'injection' && sym.file !== currentFile) {
      const header = `\n## ${sym.file}`;
      const headerTokens = estimateTokens(header);
      if (used + headerTokens > budget) return false;
      currentFile = sym.file;
      lines.push(header);
      entries.push({ type: 'file', file: currentFile, text: `## ${currentFile}` });
      used += headerTokens;
    }

    const line =
      profile === 'injection' ? formatRepoMapInjectionLine(sym) : formatRepoMapSymbolLine(sym);
    const lineTokens = estimateTokens(line);
    if (used + lineTokens > budget) return false;
    lines.push(line);
    entries.push({ type: 'symbol', symbolId: sym.id, file: sym.file, text: line });
    used += lineTokens;
    return true;
  };

  const finishTruncated = () => {
    const truncatedLine = '- … (truncated to token budget)';
    lines.push(truncatedLine);
    entries.push({ type: 'truncated', text: truncatedLine });
    return { text: lines.join('\n'), truncated: true, tokenEstimate: used, entries };
  };

  if (profile === 'injection' && focusTerms.length) {
    // Pass 1: focus matches, in rank order. Pass 2: everything else, same order.
    const rest = [];
    for (const sym of symbols) {
      if (!matchesFocus(sym, focusTerms)) {
        rest.push(sym);
        continue;
      }
      matched += 1;
      if (!emit(sym)) return finishTruncated();
    }
    for (const sym of rest) {
      if (!emit(sym)) {
        truncated = true;
        break;
      }
    }
    if (truncated) return finishTruncated();
  } else {
    for (const sym of symbols) {
      if (focusTerms.length && !matchesFocus(sym, focusTerms)) continue;
      matched += 1;
      if (!emit(sym)) return finishTruncated();
    }
  }

  if (matched === 0 && focusTerms.length && profile !== 'injection') {
    const message = '(no symbols matched focus — try grep or a broader term)';
    lines.push(`\n${message}`);
    entries.push({ type: 'message', text: message });
    return { text: lines.join('\n'), truncated: false, tokenEstimate: used, entries };
  }

  if (lines.length === 1) {
    const message = '(no indexed symbols — run reindex or use grep)';
    lines.push(`\n${message}`);
    entries.push({ type: 'message', text: message });
  }

  return { text: lines.join('\n'), truncated: false, tokenEstimate: used, entries };
}

/**
 * Score how many expected navigation targets appear in the rendered map text.
 * Used by MIN-B11 repo-map benchmarks (higher is better within the same budget).
 * @param {string} mapText
 * @param {string[]} expectedNeedles — symbol names or signatures agents need
 */
export function scoreRepoMapHits(mapText, expectedNeedles) {
  const hay = String(mapText ?? '').toLowerCase();
  let hits = 0;
  for (const needle of expectedNeedles) {
    if (hay.includes(String(needle).toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * Earliest line index (0-based) where a needle appears, or -1 when absent.
 * @param {string} mapText
 * @param {string} needle
 */
export function firstLineIndexForNeedle(mapText, needle) {
  const lines = String(mapText ?? '').split(/\r?\n/);
  const target = String(needle).toLowerCase();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].toLowerCase().includes(target)) return i;
  }
  return -1;
}
