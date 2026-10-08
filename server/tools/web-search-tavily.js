/**
 * Tavily Search API — server-side web_search_tavily handler.
 */

import {
  applyRelevanceGuard,
  normalizeSearchResults,
} from './search-result.js';
import { requestTavily } from './tavily-client.js';
import { searchOptions } from './tavily-options.js';

const TAVILY_MAX_RESULTS = 8;

/**
 * Map Tavily API rows to structured search results.
 * @param {Array<{ title?: string; url?: string; content?: string }>} rows
 * @returns {import('./search-result.js').SearchResult[]}
 */
export function mapTavilyResults(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  const normalized = normalizeSearchResults(
    rows.map((row) => ({
      title: row.title,
      url: row.url,
      snippet: row.content,
    })),
  );
  return normalized.map((row) => ({ ...row,
    snippet: String(rows.find((source) => source.url === row.url)?.content ?? row.snippet).slice(0, 4500),
  }));
}

/**
 * Format Tavily JSON results for the model (matches Brave/DDG text shape).
 * @param {string} query
 * @param {import('./search-result.js').SearchResult[]} results
 * @returns {string}
 */
export function formatTavilySearchResults(query, results) {
  if (!results.length) return `No Tavily results found for: ${query}`;
  return `Tavily search results for "${query}":\n\n${results.map((row, index) =>
    `${index + 1}. ${row.title}\n   ${row.url}\n   ${row.snippet}`).join('\n\n')}`;
}

/**
 * Run Tavily search and return structured rows.
 * @param {string} query
 * @param {string} apiKey
 * @param {number} [maxResults]
 * @returns {Promise<{ results: import('./search-result.js').SearchResult[]; error?: string }>}
 */
export async function searchTavilyStructured(query, apiKey, maxResults = TAVILY_MAX_RESULTS, args = {}, signal) {
  let payload;
  try {
    if (typeof query !== 'string' || !query.trim() || query.length > 4096) throw new Error('query must be a non-empty string of at most 4096 characters');
    payload = await requestTavily('search', apiKey, { query, ...searchOptions(args, maxResults), include_usage: true }, signal);
    if (!Array.isArray(payload.results)) throw new Error('Tavily returned invalid search results');
  } catch (error) {
    return {
      results: [],
      error: `Error: ${error instanceof Error ? error.message : 'Tavily search failed'}`,
    };
  }

  const results = mapTavilyResults(payload?.results);
  if (!results.length) {
    return { results: [], error: `No Tavily results found for: ${query}` };
  }

  const guarded = applyRelevanceGuard('Tavily', query, results);
  return { ...guarded, results: results.filter((row) => guarded.results.some((kept) => kept.url === row.url)) };
}

/**
 * Run Tavily search with the given API key.
 * @param {string} query
 * @param {string} apiKey
 * @returns {Promise<string>}
 */
export async function runTavilySearch(query, apiKey) {
  const { results, error } = await searchTavilyStructured(query, apiKey);
  if (error) {
    return error;
  }
  return formatTavilySearchResults(query, results);
}
