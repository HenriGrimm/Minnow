import type { SettingsSearchEntry } from './settings-search-types';

const MAX_RESULTS = 12;

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function tokenize(query: string): string[] {
  const tokens = normalizeQuery(query).replace(/[?!,]/g, '').split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((token) => !['how', 'do', 'i', 'the', 'a', 'an', 'my', 'please', 'can', 'to'].includes(token));
  return meaningful.length ? meaningful : tokens;
}

/** Queries this short match whole words or word starts only ("lan" ≠ "plan"). */
const SHORT_TOKEN_MAX = 3;

function words(text: string): string[] {
  return text.split(/[^a-z0-9.+#]+/).filter(Boolean);
}

function scoreShortToken(token: string, label: string, keywords: string[]): number {
  if (label === token) return 1000;
  const labelWords = words(label);
  if (labelWords.includes(token)) return 900;
  for (const kw of keywords) {
    if (kw === token) return 880;
  }
  for (const kw of keywords) {
    if (words(kw).includes(token)) return 650;
  }
  // Two letters are too few to guess a word from ("gh" ≠ "ghost").
  if (token.length < SHORT_TOKEN_MAX) return 0;
  if (labelWords.some((w) => w.startsWith(token))) return 400;
  for (const kw of keywords) {
    if (words(kw).some((w) => w.startsWith(token))) return 300;
  }
  return 0;
}

function scoreToken(token: string, entry: SettingsSearchEntry): number {
  const label = entry.label.toLowerCase();
  const id = entry.id.toLowerCase();
  const keywords = (entry.keywords ?? []).map((k) => k.toLowerCase());
  if (token.length <= SHORT_TOKEN_MAX) return scoreShortToken(token, label, keywords);
  const haystack = [label, id, ...keywords];

  if (label === token) return 1000;
  if (label.startsWith(token)) return 850;
  if (label.includes(token)) return 700;

  for (const kw of keywords) {
    if (kw === token) return 650;
    if (kw.startsWith(token)) return 550;
    if (kw.includes(token)) return 450;
  }

  if (id.includes(token)) return 350;

  for (const text of haystack) {
    if (text.includes(token)) return 250;
  }

  return 0;
}

/** Phrase bonus: a multi-word query that matches a keyword or label verbatim. */
function phraseScore(query: string, entry: SettingsSearchEntry): number {
  if (!query.includes(' ')) return 0;
  const label = entry.label.toLowerCase();
  if (label === query) return 600;
  if (label.includes(query)) return 400;
  if ((entry.keywords ?? []).some((k) => k.toLowerCase() === query)) return 500;
  return 0;
}

/** Where a result lands; two rows with the same target are one result. */
function targetKey(entry: SettingsSearchEntry): string {
  const where = entry.modelsSection
    ? `models:${entry.modelsSection}`
    : entry.brainSection
      ? `brain:${entry.brainSection}`
      : `settings:${entry.sectionId}`;
  return `${where}|${entry.searchKey ?? ''}`;
}

function labelKey(entry: SettingsSearchEntry): string {
  const where = entry.modelsSection ?? entry.brainSection ?? entry.sectionId;
  return `${where}|${entry.label.trim().toLowerCase()}`;
}

function scoreEntry(query: string, entry: SettingsSearchEntry): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    const part = scoreToken(token, entry);
    if (part === 0) return 0;
    total += part;
  }
  return total + phraseScore(normalizeQuery(query), entry);
}

/** Rank entries: exact label prefix beats substring; all tokens must match somewhere. */
export function rankSettingsSearch(
  query: string,
  entries: SettingsSearchEntry[],
  options?: { maxResults?: number },
): SettingsSearchEntry[] {
  const maxResults = options?.maxResults ?? MAX_RESULTS;
  const trimmed = normalizeQuery(query);
  if (!trimmed) return [];

  const scored = entries
    .map((entry) => ({ entry, score: scoreEntry(trimmed, entry) }))
    .filter((row) => row.score > 0);
  // A short one-word query that names something exactly ("lan", "mcp") shows only
  // those hits; word-start guesses ("language", "landlock") are noise next to them.
  const shortSingle = !trimmed.includes(' ') && trimmed.length <= SHORT_TOKEN_MAX;
  const exactFloor = 650;
  const hasExact = shortSingle && scored.some((row) => row.score >= exactFloor);
  return scored
    .filter((row) => !hasExact || row.score >= exactFloor)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const kindOrder =
        (a.entry.kind === 'section' ? 1 : 0) - (b.entry.kind === 'section' ? 1 : 0);
      if (kindOrder !== 0) return kindOrder;
      return a.entry.label.localeCompare(b.entry.label);
    })
    .map((row) => row.entry)
    .filter((entry, _index, all) => {
      // Keep the best-ranked row per destination and per visible label.
      const first = all.find((other) => targetKey(other) === targetKey(entry) || labelKey(other) === labelKey(entry));
      return first === entry;
    })
    .slice(0, maxResults);
}
