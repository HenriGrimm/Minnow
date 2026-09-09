/**
 * @typedef {{ title: string; url: string; snippet: string }} SearchResult
 */

/** Snippet characters kept per result before the tail is dropped. */
export const MAX_SNIPPET_CHARS = 400;

/**
 * Providers (Tavily especially) return page scrapes rather than clean summaries:
 * collapsed table rows, the same fragment repeated, stray markdown pipes. Squash
 * that before it reaches the model — eight results of it is real context spend.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSnippet(raw) {
  const flat = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*\|\s*){2,}/g, ' | ')
    .trim();
  if (!flat) return '';

  // Capturing split so the separator survives: a table's pipes carry meaning.
  const parts = flat.split(/(\s*\|\s*|(?<=[.!?])\s+)/);
  const seen = new Set();
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    const piece = (parts[i] ?? '').trim();
    if (!piece) continue;
    const key = piece.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const separator = out ? (parts[i - 1]?.includes('|') ? ' | ' : ' ') : '';
    out += separator + piece;
  }

  const deduped = out.trim();
  if (deduped.length <= MAX_SNIPPET_CHARS) return deduped;
  return `${deduped.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}…`;
}

/**
 * @param {SearchResult[]} results
 * @returns {SearchResult[]}
 */
export function normalizeSearchResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  const out = [];
  for (const row of results) {
    const title = String(row?.title ?? '(no title)').trim();
    const url = String(row?.url ?? '').trim();
    const snippet = normalizeSnippet(row?.snippet);
    if (!url) {
      continue;
    }
    out.push({ title, url, snippet });
  }
  return out;
}

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'are', 'how', 'what', 'why', 'when', 'where', 'does',
  'did', 'can', 'from', 'that', 'this', 'you', 'your', 'has', 'have', 'was', 'were',
  'not', 'but', 'all', 'any', 'its', 'use', 'using', 'get', 'set', 'best', 'vs',
]);

/**
 * @param {string} query
 * @returns {string[]}
 */
export function tokenizeQuery(query) {
  const cleaned = String(query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.\-]+/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .map((token) => token.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((token) => token.length >= 3 && !QUERY_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/**
 * @param {string} query
 * @param {SearchResult[]} results
 * @returns {number}
 */
export function resultSetCoverage(query, results) {
  const tokens = tokenizeQuery(query);
  const rows = normalizeSearchResults(results);
  if (!tokens.length || !rows.length) {
    return 1;
  }

  let hits = 0;
  for (const row of rows) {
    const haystack = `${row.title} ${row.url} ${row.snippet}`.toLowerCase();
    if (tokens.some((token) => haystack.includes(token))) {
      hits += 1;
    }
  }
  return hits / rows.length;
}

export const HEALTHY_COVERAGE_THRESHOLD = 0.6;

const MIN_RESULTS_TO_JUDGE = 3;

function rowMatchesQuery(row, tokens) {
  const haystack = `${row.title} ${row.url} ${row.snippet}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

/**
 * @param {string} query
 * @param {SearchResult[]} results
 * @returns {boolean}
 */
export function looksUnrelated(query, results) {
  const rows = normalizeSearchResults(results);
  const tokens = tokenizeQuery(query);
  if (rows.length < MIN_RESULTS_TO_JUDGE || !tokens.length) {
    return false;
  }
  return !rows.some((row) => rowMatchesQuery(row, tokens));
}

/**
 * @param {string} providerLabel
 * @param {string} query
 * @param {SearchResult[]} results
 * @returns {{ results: SearchResult[]; error?: string }}
 */
export function applyRelevanceGuard(providerLabel, query, results) {
  const rows = normalizeSearchResults(results);
  const tokens = tokenizeQuery(query);
  if (rows.length < MIN_RESULTS_TO_JUDGE || !tokens.length) {
    return { results: rows };
  }
  if (resultSetCoverage(query, rows) >= HEALTHY_COVERAGE_THRESHOLD) {
    return { results: rows };
  }

  const kept = rows.filter((row) => rowMatchesQuery(row, tokens));
  if (!kept.length) {
    return {
      results: [],
      error:
        `Error: ${providerLabel} returned ${rows.length} results unrelated to "${query}" ` +
        '(likely an anti-scraping decoy page); discarded.',
    };
  }
  return { results: kept };
}

/**
 * @param {string} providerLabel
 * @param {string} query
 * @param {SearchResult[]} results
 * @returns {string}
 */
export function formatSearchResults(providerLabel, query, results) {
  const rows = normalizeSearchResults(results);
  if (!rows.length) {
    return `No ${providerLabel} results found for: ${query}`;
  }

  const lines = rows.map((row, index) => {
    return `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`;
  });

  return `${providerLabel} search results for "${query}":\n\n${lines.join('\n\n')}`;
}
