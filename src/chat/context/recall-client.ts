import { isLocalServerAvailable } from '../../tools/config';
import { runRecallHistory } from '../../../server/runner/compaction/index.js';
import type { RunTurnOptions } from '../../../server/runner/run-turn';

/** Ceiling on the ranking request; recall falls back to the local ranker past it. */
const RANKING_TIMEOUT_MS = 1500;

function queryOf(args: unknown): string {
  let parsed = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return '';
    }
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const record = parsed as Record<string, unknown>;
  if (typeof record.rows === 'string' && record.rows.trim()) return '';
  return typeof record.query === 'string' ? record.query.trim() : '';
}

/**
 * History indices ranked by the server's SQLite FTS index (porter-stemmed), best
 * first. Null when the server is unavailable, slow, or the store has no index.
 */
export async function fetchRecallRanking(chatId: string, query: string): Promise<number[] | null> {
  if (!chatId || !query || !isLocalServerAvailable()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RANKING_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({ q: query });
    const res = await fetch(`/api/config/sessions/recall/${encodeURIComponent(chatId)}?${params}`, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ranked?: unknown };
    return Array.isArray(body.ranked) ? body.ranked.filter((n): n is number => Number.isFinite(n)) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `recall_history` for main chat. Rows come from the runner (the live history,
 * including rows not yet saved); a query also takes the FTS ranking, fused with
 * the local BM25, so stemmed matches surface without losing tool-call arguments.
 */
export function createChatRecallHistory(chatId: string): NonNullable<RunTurnOptions['recallHistory']> {
  return async ({ args, entries }) => {
    const query = queryOf(args);
    const ranking = query ? await fetchRecallRanking(chatId, query) : null;
    return runRecallHistory(entries, args, { ranking });
  };
}
