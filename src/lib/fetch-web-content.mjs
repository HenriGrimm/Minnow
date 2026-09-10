/**
 * Shared HTTP fetch + HTML strip + truncation for fetch_web_content / rag_web_content.
 * Used by the browser executor and the Node tool server (BUG-011).
 */

/** Hard ceiling on plain-text bytes kept from a fetched page (also the full_result cap). */
export const WEB_TEXT_MAX_BYTES = 128 * 1024;

/**
 * Default bytes returned by fetch_web_content (~12k tokens).
 * The RAG path still ranks over the full WEB_TEXT_MAX_BYTES extract.
 */
export const WEB_TEXT_DEFAULT_MAX_BYTES = 48 * 1024;

/** Default number of ranked excerpts returned by rag_web_content. */
export const WEB_RAG_EXCERPT_LIMIT = 16;
export const WEB_RAG_EXCERPT_MAX_CHARS = 1200;
export const WEB_RAG_MAX_CHARS = 12000;

/** User-Agent for server-side page fetch (align with web_search_ddg). */
export const DEFAULT_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Validates an http(s) URL string.
 * @param {string} urlString
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function validateHttpUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: `Error: invalid URL "${urlString}"` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Error: only http and https URLs are supported' };
  }

  return { ok: true, url: parsed };
}

/** Elements whose subtree never carries page content. */
const DROPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'head',
  'iframe',
  'template',
  'button',
  'select',
  'textarea',
  'canvas',
  'audio',
  'video',
  'object',
  'nav',
  'aside',
  'footer',
]);

/**
 * Never dropped by class/id heuristics. Site frameworks put utility classes on
 * the root elements (`<html class="vector-toc-available">`), and dropping one of
 * these takes the whole document with it.
 */
const NEVER_DROPPED_TAGS = new Set(['html', 'body', 'main', 'article']);

/** HTML void elements — they never open a subtree. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * class/id tokens that mark chrome rather than content (matched whole-token).
 * Includes the MediaWiki/Vector classes every wiki mirror shares — language
 * pickers, edit links, and reference lists are the bulk of a fetched wiki page.
 */
const NOISE_TOKEN =
  /^(navbox|vertical-navbox|navbar|navigation|menu|sidebar|reflist|references|catlinks|noprint|toc|breadcrumbs?|skip-link|site-header|site-footer|global-nav|cookie[\w-]*|consent[\w-]*|newsletter[\w-]*|advert(isement)?|ads|adsbygoogle|share[\w-]*|social[\w-]*|mw-portlet[\w-]*|mw-editsection[\w-]*|mw-jump-link|mw-indicators|mw-navigation|mw-footer[\w-]*|vector-menu[\w-]*|vector-dropdown|vector-toc|vector-page-toolbar|interlanguage-link[\w-]*|printfooter|siteSub|contentSub|authority-control)$/i;

/**
 * @param {string} attrs raw attribute text from an opening tag
 * @returns {boolean}
 */
function attrsLookLikeChrome(attrs) {
  const values = [];
  const classMatch = /\bclass\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (classMatch) values.push(classMatch[2] ?? classMatch[3] ?? classMatch[4] ?? '');
  const idMatch = /\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  if (idMatch) values.push(idMatch[2] ?? idMatch[3] ?? idMatch[4] ?? '');
  if (/\brole\s*=\s*["']?(navigation|banner|complementary|search)\b/i.test(attrs)) return true;

  for (const value of values) {
    for (const token of value.split(/\s+/)) {
      if (token && NOISE_TOKEN.test(token)) return true;
    }
  }
  return false;
}

/**
 * Remove raw-text elements before interpreting any embedded tag-like strings.
 *
 * @param {string} html
 * @returns {string}
 */
function dropRawTextElements(html) {
  // HTML inside scripts is data, not nested markup. In particular Next.js
  // hydration strings can contain opening tags that confuse the subtree stack.
  return String(html ?? '').replace(
    /<(script|style|textarea)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    ' ',
  );
}

/** Remove chrome subtrees, including nested markup, while retaining page content. */
export function dropNoiseSubtrees(html) {
  const source = dropRawTextElements(html);
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let out = '';
  let cursor = 0;
  /** @type {{ tag: string, depth: number, resumeAt: number } | null} */
  let dropping = null;
  let match;

  while ((match = tagPattern.exec(source)) !== null) {
    const [raw, closing, rawTag, attrs] = match;
    const tag = rawTag.toLowerCase();
    const selfClosing = attrs.trimEnd().endsWith('/') || VOID_TAGS.has(tag);

    if (dropping) {
      if (tag !== dropping.tag || selfClosing) continue;
      if (closing) {
        dropping.depth -= 1;
        if (dropping.depth === 0) {
          dropping = null;
          cursor = tagPattern.lastIndex;
        }
      } else {
        dropping.depth += 1;
      }
      continue;
    }

    if (closing || selfClosing) continue;
    if (!DROPPED_TAGS.has(tag)) {
      if (NEVER_DROPPED_TAGS.has(tag) || !attrsLookLikeChrome(attrs)) continue;
    }

    out += source.slice(cursor, match.index);
    out += ' ';
    dropping = { tag, depth: 1, resumeAt: tagPattern.lastIndex };
    cursor = tagPattern.lastIndex;
  }

  // An unclosed drop tag would otherwise swallow the rest of the document.
  out += source.slice(dropping ? dropping.resumeAt : cursor);
  return out;
}

/** Below this the extracted main region is treated as a false positive. */
const MAIN_REGION_MIN_CHARS = 500;

/**
 * Prefer <main> or <article> when the page marks its content region.
 *
 * @param {string} html
 * @returns {string}
 */
export function selectMainRegion(html) {
  const source = String(html ?? '');
  for (const tag of ['main', 'article']) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(source);
    if (!open) continue;
    const close = source.toLowerCase().lastIndexOf(`</${tag}>`);
    if (close <= open.index) continue;
    const region = source.slice(open.index + open[0].length, close);
    if (region.length >= MAIN_REGION_MIN_CHARS && region.length >= source.length * 0.15) {
      return region;
    }
  }
  return source;
}

/**
 * @param {string} html
 * @returns {string}
 */
function decodeEntities(html) {
  return html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/**
 * @param {string} html
 * @returns {string}
 */
function htmlRegionToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(
        /<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre|ul|ol|table|dd|dt|figcaption|caption)\s*>/gi,
        '\n',
      )
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Below this the chrome heuristics are assumed to have eaten the content. */
const MIN_USEFUL_TEXT_CHARS = 200;

/**
 * Strips chrome and tags and returns plain text with paragraph breaks preserved.
 *
 * Block boundaries become newlines so downstream paragraph ranking (rag_web_content,
 * deep_read) has paragraphs to rank. Falls back to a whole-document strip when the
 * content heuristics leave too little behind.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtmlToPlainText(html) {
  const source = String(html ?? '');
  const cleaned = htmlRegionToText(selectMainRegion(dropNoiseSubtrees(source)));
  if (cleaned.length >= MIN_USEFUL_TEXT_CHARS) return cleaned;

  const naive = htmlRegionToText(
    dropRawTextElements(source)
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '),
  );
  return naive.length > cleaned.length ? naive : cleaned;
}

/**
 * Truncates UTF-8 text to maxBytes without splitting multibyte code points.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8(text, maxBytes) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }

  const decoder = new TextDecoder();
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }

  const truncated = decoder.decode(bytes.slice(0, end));
  return `${truncated}\n\n[truncated to ${maxBytes} bytes]`;
}

/**
 * Tokenize a query into lowercase terms (length >= 2).
 * @param {string} query
 * @returns {string[]}
 */
function queryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length > 1);
}

/**
 * Score one text unit by query term overlap.
 * @param {string} unit
 * @param {string[]} terms
 * @returns {number}
 */
function scoreUnitByTerms(unit, terms) {
  const lower = unit.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Scores sentences by query term overlap and returns the top matches.
 * @param {string} text
 * @param {string} query
 * @param {number} limit
 * @returns {string[]}
 */
export function rankSentencesByQuery(text, query, limit) {
  const terms = queryTerms(query);

  if (terms.length === 0) {
    return [];
  }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const scored = sentences
    .map((sentence) => ({
      sentence,
      score: scoreUnitByTerms(sentence, terms),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((row) => row.sentence);
}

/**
 * Scores paragraphs (blank-line separated) by query term overlap.
 * @param {string} text
 * @param {string} query
 * @param {number} limit
 * @returns {string[]}
 */
export function rankParagraphsByQuery(text, query, limit) {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 40);

  const scored = paragraphs
    .map((paragraph) => ({
      unit: paragraph,
      score: scoreUnitByTerms(paragraph, terms),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((row) => row.unit);
}

/**
 * Rank sentences and paragraphs together for denser web RAG excerpts.
 * @param {string} text
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function rankWebContentByQuery(text, query, limit = WEB_RAG_EXCERPT_LIMIT) {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }

  // Bound units before ranking, so a minified page cannot become one enormous
  // matching sentence. Split on whitespace when possible, retaining later hits.
  const units = [];
  for (const paragraph of text.split(/\n+/)) {
    let rest = paragraph.trim();
    while (rest.length > WEB_RAG_EXCERPT_MAX_CHARS) {
      let end = rest.lastIndexOf(' ', WEB_RAG_EXCERPT_MAX_CHARS);
      if (end < WEB_RAG_EXCERPT_MAX_CHARS / 2) end = WEB_RAG_EXCERPT_MAX_CHARS;
      units.push(rest.slice(0, end));
      rest = rest.slice(end).trimStart();
    }
    if (rest) units.push(rest);
  }
  const boundedText = units.join('\n\n');
  const candidates = [];
  const seen = new Set();

  for (const sentence of rankSentencesByQuery(boundedText, query, limit)) {
    if (sentence.length > WEB_RAG_EXCERPT_MAX_CHARS) continue;
    const key = sentence.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ unit: sentence, score: scoreUnitByTerms(sentence, terms) });
  }

  for (const paragraph of rankParagraphsByQuery(boundedText, query, limit)) {
    const key = paragraph.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ unit: paragraph, score: scoreUnitByTerms(paragraph, terms) });
  }

  const selected = [];
  let chars = 0;
  for (const { unit } of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.length >= Math.min(limit, WEB_RAG_EXCERPT_LIMIT)) break;
    if (selected.some((prior) => prior.includes(unit) || unit.includes(prior))) continue;
    if (chars + unit.length > WEB_RAG_MAX_CHARS) continue;
    selected.push(unit);
    chars += unit.length;
  }
  return selected;
}

/** Default excerpt length for query-relevant memory/wiki injection. */
export const MEMORY_EXCERPT_MAX_CHARS = 500;

/**
 * Pick the best query-matching excerpt from a wiki page body.
 * @param {string} body
 * @param {string} [query]
 * @param {number} [maxLen]
 * @returns {string}
 */
export function selectQueryRelevantExcerpt(body, query = '', maxLen = MEMORY_EXCERPT_MAX_CHARS) {
  const text = String(body ?? '').trim();
  if (!text) return '';

  const terms = queryTerms(query);
  let best = '';

  if (terms.length > 0) {
    const sections = text
      .split(/(?=^##\s)/m)
      .map((s) => s.trim())
      .filter(Boolean);

    const units =
      sections.length > 1
        ? sections
        : text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

    let bestScore = 0;
    for (const unit of units) {
      const score = scoreUnitByTerms(unit, terms);
      if (score > bestScore) {
        bestScore = score;
        best = unit;
      }
    }
  }

  if (!best) {
    best =
      text
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) ?? '';
  }

  const oneLine = best.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

/**
 * Builds a user-visible network error for fetch failures.
 * @param {string} url
 * @param {unknown} err
 * @param {{ suggestNpmStart?: boolean }} [options]
 * @returns {string}
 */
export function formatFetchNetworkError(url, err, options = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const corsHint =
    /failed to fetch|fetch failed|networkerror/i.test(message)
      ? ' The site may block cross-origin requests (CORS).'
      : '';
  const startHint = options.suggestNpmStart
    ? ' Open Minnow for in-app page fetch (avoids browser CORS limits).'
    : '';
  return `Error: fetch failed for ${url} (${message}).${corsHint}${startHint}`;
}

/**
 * Fetches http(s) URL and returns stripped plain text or an error string.
 * @param {string} urlString
 * @param {{ userAgent?: string, suggestNpmStart?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function fetchUrlText(urlString, options = {}) {
  const validated = validateHttpUrl(urlString);
  if (!validated.ok) {
    return validated.error;
  }

  const { url } = validated;
  const userAgent = options.userAgent ?? DEFAULT_FETCH_USER_AGENT;

  let response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });
  } catch (err) {
    return formatFetchNetworkError(url.toString(), err, {
      suggestNpmStart: options.suggestNpmStart,
    });
  }

  if (!response.ok) {
    return `Error: HTTP ${response.status} ${response.statusText} for ${url.toString()}`;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();

  if (contentType.includes('text/html') || body.trimStart().startsWith('<')) {
    return stripHtmlToPlainText(body);
  }

  return body;
}
