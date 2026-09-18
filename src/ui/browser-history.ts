/**
 * Browser history for the preview pane: every http(s)/file URL a preview tab
 * lands on, with its page title, visit count and last visit. Feeds the
 * address-bar suggestions and the History popover.
 *
 * Lives in localStorage (per-user convenience, like other UI prefs) and is
 * capped so it never grows without bound. Workspace paths are not recorded —
 * they are relative to whichever folder is open and the file tree covers them.
 */

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitCount: number;
  lastVisitedAt: number;
}

export const BROWSER_HISTORY_STORAGE_KEY = 'minnow.browserHistory.v1';
export const MAX_BROWSER_HISTORY_ENTRIES = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

type HistoryListener = () => void;

let entries: Map<string, BrowserHistoryEntry> | null = null;
const listeners = new Set<HistoryListener>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function load(): Map<string, BrowserHistoryEntry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = storage()?.getItem(BROWSER_HISTORY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (!row || typeof row.url !== 'string') continue;
        entries.set(row.url, {
          url: row.url,
          title: typeof row.title === 'string' ? row.title : '',
          visitCount: Number.isFinite(row.visitCount) ? Math.max(1, row.visitCount) : 1,
          lastVisitedAt: Number.isFinite(row.lastVisitedAt) ? row.lastVisitedAt : 0,
        });
      }
    }
  } catch {
    // Corrupt or unavailable storage: start empty rather than break the browser.
  }
  return entries;
}

function persist(): void {
  const map = load();
  if (map.size > MAX_BROWSER_HISTORY_ENTRIES) {
    const keep = [...map.values()]
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_BROWSER_HISTORY_ENTRIES);
    map.clear();
    for (const entry of keep) map.set(entry.url, entry);
  }
  try {
    storage()?.setItem(BROWSER_HISTORY_STORAGE_KEY, JSON.stringify([...map.values()]));
  } catch {
    // Quota or private mode: history stays in memory for this session.
  }
  for (const fn of listeners) fn();
}

/**
 * Canonical history key for a navigated URL, or null when it should not be
 * recorded (error pages, Minnow's own API origin, non-web schemes).
 * Strips credentials and the fragment so `#section` jumps are one page.
 */
export function normalizeHistoryUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^(https?|file):\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    typeof window !== 'undefined' &&
    window.location?.origin &&
    parsed.origin === window.location.origin &&
    parsed.pathname.startsWith('/api/')
  ) {
    return null;
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString();
}

/** Record one visit (a tab moved to this URL). */
export function recordBrowserVisit(rawUrl: string, now = Date.now()): void {
  const url = normalizeHistoryUrl(rawUrl);
  if (!url) return;
  const map = load();
  const existing = map.get(url);
  if (existing) {
    existing.visitCount += 1;
    existing.lastVisitedAt = now;
  } else {
    map.set(url, { url, title: '', visitCount: 1, lastVisitedAt: now });
  }
  persist();
}

/** Attach the page title once the guest reports it. */
export function recordBrowserTitle(rawUrl: string, title: string): void {
  const url = normalizeHistoryUrl(rawUrl);
  const trimmed = title.trim();
  if (!url || !trimmed) return;
  const entry = load().get(url);
  if (!entry || entry.title === trimmed) return;
  entry.title = trimmed;
  persist();
}

export function removeBrowserHistoryEntry(url: string): void {
  if (load().delete(url)) persist();
}

export function clearBrowserHistory(): void {
  load().clear();
  persist();
}

/** All entries, most recent first. */
export function listBrowserHistory(): BrowserHistoryEntry[] {
  return [...load().values()].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
}

export function onBrowserHistoryChange(listener: HistoryListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `https://www.example.com/a` → `example.com/a` (what people actually type). */
export function stripUrlDecorations(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

/** Frecency: visits weighted by how recently the page was last seen. */
function frecency(entry: BrowserHistoryEntry, now: number): number {
  const ageDays = Math.max(0, now - entry.lastVisitedAt) / DAY_MS;
  const recency = ageDays < 1 ? 1 : ageDays < 7 ? 0.7 : ageDays < 30 ? 0.4 : 0.15;
  return Math.log2(1 + entry.visitCount) * recency;
}

function matchScore(entry: BrowserHistoryEntry, query: string): number {
  const bare = stripUrlDecorations(entry.url).toLowerCase();
  const full = entry.url.toLowerCase();
  if (bare.startsWith(query) || full.startsWith(query)) {
    // Prefer the shortest completion: `git` → github.com over github.com/foo/bar.
    return 100 - Math.min(40, bare.length - query.length) / 2;
  }
  const title = entry.title.toLowerCase();
  if (title.split(/[\s\-–—|:·/]+/).some((word) => word.startsWith(query))) return 40;
  if (bare.includes(query)) return 25;
  if (title.includes(query)) return 15;
  return 0;
}

/**
 * Suggestions for the address bar. An empty query returns the top pages by
 * frecency; otherwise every whitespace-separated term must match the URL or
 * title, ranked URL-prefix first, then title words, then substrings.
 */
export function suggestBrowserUrls(
  rawQuery: string,
  limit = 8,
  now = Date.now(),
): BrowserHistoryEntry[] {
  const all = [...load().values()];
  const query = rawQuery.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
  if (!query) {
    return all.sort((a, b) => frecency(b, now) - frecency(a, now)).slice(0, limit);
  }
  const terms = query.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: BrowserHistoryEntry; score: number }> = [];
  for (const entry of all) {
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      const s = matchScore(entry, term);
      if (s === 0) {
        matchedAll = false;
        break;
      }
      score += s;
    }
    if (matchedAll) scored.push({ entry, score: score + frecency(entry, now) * 10 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.entry);
}

/** Test helper — drop the in-memory cache so the next read reloads storage. */
export function resetBrowserHistoryForTests(): void {
  entries = null;
  listeners.clear();
}
