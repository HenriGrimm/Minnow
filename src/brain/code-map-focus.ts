/**
 * Extract task hints that focus the injected code map on what the message is about.
 */

export interface CodeMapFocusHints {
  /**
   * Substring terms the map ranks first. Empty means "no signal, send the
   * global map" — never an empty map, because injection boosts rather than
   * filters (see `renderRepoMap`).
   */
  focus: string[];
}

const PATH_PREFIX_RE =
  /(?:^|[\s`'"(<@])((?:src|server|lib|documentation|docs|test|tests)\/[A-Za-z0-9_./-]+)/g;

/** PascalCase and lowerCamelCase — most JS/TS identifiers are the latter. */
const CAMEL_RE = /\b[A-Za-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g;
const SNAKE_RE = /\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+\b/g;

/** Terms so common in this product's prose that they match half the index. */
const FOCUS_SKIP = new Set([
  'this',
  'that',
  'with',
  'from',
  'your',
  'please',
  'thanks',
  'hello',
  'minnow',
  'typescript',
  'javascript',
  'github',
]);

/** Cap on terms sent — enough for a multi-file task, short of a whole message. */
const MAX_TERMS = 8;

/**
 * Normalize a workspace-relative path so it matches indexed `file` columns.
 * @param {string} raw
 */
function normalizeFocusFile(raw: string): string | null {
  const t = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!t) return null;
  if (t.startsWith('@')) return normalizeFocusFile(t.slice(1));
  if (/^(https?:|file:)/i.test(t)) return null;
  return t.replace(/^\/+/, '');
}

/**
 * Collect identifier-like tokens from user text (not the full message).
 * @param {string} text
 */
function collectFocusTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const m of text.matchAll(CAMEL_RE)) {
    const id = m[0];
    if (id.length >= 5 && !FOCUS_SKIP.has(id.toLowerCase())) terms.add(id);
  }
  for (const m of text.matchAll(SNAKE_RE)) {
    const id = m[0];
    if (id.length >= 6 && !FOCUS_SKIP.has(id)) terms.add(id);
  }
  return [...terms];
}

/**
 * Build focus hints from the outgoing user message and attachment paths.
 *
 * Paths come first: they are the highest-precision signal, and a path term also
 * matches every symbol in that file. Identifiers follow. A weak or wrong term
 * costs nothing now — the injection uses these to order a fixed budget, so the
 * worst case is the map an unfocused send would have produced anyway.
 */
export function extractCodeMapFocusHints(
  userMessagePreview: string,
  attachmentWorkspacePaths?: string[],
): CodeMapFocusHints {
  const files = new Set<string>();
  for (const raw of attachmentWorkspacePaths ?? []) {
    const norm = normalizeFocusFile(raw);
    if (norm) files.add(norm);
  }

  const text = String(userMessagePreview ?? '');
  for (const m of text.matchAll(PATH_PREFIX_RE)) {
    const norm = normalizeFocusFile(m[1]);
    if (norm) files.add(norm);
  }

  const focus: string[] = [];
  const seen = new Set<string>();
  for (const term of [...files, ...collectFocusTerms(text)]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    focus.push(term);
    if (focus.length >= MAX_TERMS) break;
  }

  return { focus };
}
