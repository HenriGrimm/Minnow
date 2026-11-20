/**
 * Precise memory search over the current project and user scopes. Unlike the
 * legacy wiki retrieval there is no recency fallback: a query that matches
 * nothing returns nothing.
 */

import { loadBrainConfig } from '../store.js';
import { memorySimilarities } from './similarity.js';
import { loadMemoryEntries, memoryHit } from './store.js';

export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;
export const SEARCH_MIN_COSINE = 0.45;

// Words too broad to establish relevance on their own.
const STOPWORDS = new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'so', 'to', 'up', 'we',
  'about', 'add', 'after', 'all', 'and', 'any', 'app', 'are', 'before', 'both', 'build', 'but',
  'can', 'code', 'create', 'did', 'does', 'doing', 'done', 'each', 'fix', 'for', 'from', 'get',
  'had', 'has', 'have', 'help', 'here', 'how', 'into', 'its', 'just', 'lets', 'like', 'make',
  'more', 'new', 'not', 'now', 'one', 'only', 'our', 'out', 'project', 'should', 'some', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'use', 'used', 'using',
  'was', 'way', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with',
  'work', 'would', 'you', 'your', 'update', 'thing', 'things', 'memory', 'memories',
]);

/** Specific words, including short topics such as CI or UX, minus broad words. */
export function specificTerms(query) {
  return [...new Set(wordsOf(query).filter(word => word.length >= 2 && !STOPWORDS.has(word)))];
}

function wordsOf(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function termMatches(words, term) {
  return words.some(word => word === term || (term.length >= 4 && word.startsWith(term)));
}

/** Keyword score: 2 per specific term in the title, 1 per term in the body/evidence. */
export function keywordScore(entry, terms) {
  if (!terms.length) return 0;
  const title = wordsOf(entry.meta.title);
  const body = wordsOf(`${entry.body}\n${entry.meta.evidence ?? ''}`);
  let score = 0;
  for (const term of terms) {
    if (termMatches(title, term)) score += 2;
    else if (termMatches(body, term)) score += 1;
  }
  return score;
}

/**
 * Rank memories for a query. Pure over pre-loaded entries.
 * @param {Array<{ meta: object, body: string }>} entries
 * @param {{ query: string, limit?: number, kind?: string, similarities?: Map<string, number> | null }} opts
 */
export function rankMemories(entries, opts) {
  const terms = specificTerms(opts.query);
  const limit = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(Number(opts.limit) || SEARCH_DEFAULT_LIMIT)));
  const superseded = new Set(entries.flatMap(entry => entry.meta.supersedes ?? []));
  const ranked = [];
  for (const entry of entries) {
    if (superseded.has(entry.meta.id)) continue;
    if (opts.kind && entry.meta.kind !== opts.kind) continue;
    const keyword = keywordScore(entry, terms);
    const cosine = opts.similarities?.get(entry.meta.id) ?? 0;
    const semantic = cosine >= SEARCH_MIN_COSINE ? cosine : 0;
    if (keyword <= 0 && semantic <= 0) continue;
    const maxKeyword = Math.max(1, terms.length * 2);
    ranked.push({ entry, score: keyword / maxKeyword + semantic });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const scopeOrder = (a.entry.meta.scope === 'project' ? 0 : 1) - (b.entry.meta.scope === 'project' ? 0 : 1);
    if (scopeOrder) return scopeOrder;
    return String(b.entry.meta.updatedAt).localeCompare(String(a.entry.meta.updatedAt));
  });
  return ranked.slice(0, limit).map(({ entry }) => memoryHit(entry));
}

/**
 * Search the current project's memory plus the user's cross-project preferences.
 * @param {{ query: string, limit?: number, kind?: string, project: { key: string } | null, signal?: AbortSignal }} opts
 * @param {object} [deps] — embedding overrides for tests
 */
export async function searchMemories(opts, deps = {}) {
  const query = String(opts.query ?? '').trim();
  if (!query) return [];
  const entries = await loadMemoryEntries(opts.project);
  if (entries.length === 0) return [];
  const config = deps.config ?? (await loadBrainConfig());
  const similarities = await memorySimilarities(query, entries, config, { ...deps, signal: opts.signal });
  return rankMemories(entries, { query, limit: opts.limit, kind: opts.kind, similarities });
}
