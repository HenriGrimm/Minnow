import {
  fetchUrlText,
  rankWebContentByQuery,
  truncateUtf8,
  WEB_RAG_EXCERPT_LIMIT,
  WEB_TEXT_DEFAULT_MAX_BYTES,
  WEB_TEXT_MAX_BYTES,
} from '../lib/fetch-web-content.mjs';
import { loadToolConfig } from './config';
import {
  capTextOutput,
  resolveOutputCapPolicy,
  runWithOutputCapPolicy,
} from '../../server/tools/output-cap.js';
import {
  toolGetAppearance,
  toolUpdateAppearance,
  toolUploadAppearanceAsset,
} from './appearance-tools';
import { toolLaunchMinnowApp } from './os-launch-tool';
import { toolRecallChatContext } from './recall-chat-context';
import { toolRecallTurnFull } from './recall-turn-full';

/** Browser-fallback fetch cap: same policy as the Node /api/tools path. */
function capFetchedWebText(
  text: string,
  args: Record<string, unknown>,
  maxBytes = WEB_TEXT_MAX_BYTES,
): string {
  const policy = resolveOutputCapPolicy(loadToolConfig().toolOutput, args);
  if (!policy.applyResultCap) return text;
  return truncateUtf8(text, maxBytes);
}

/** Clamp the caller's fetch_web_content byte budget to the product ceiling. */
function resolveFetchMaxBytes(args: Record<string, unknown>): number {
  const raw = Number(args.max_bytes);
  if (!Number.isFinite(raw)) return WEB_TEXT_DEFAULT_MAX_BYTES;
  return Math.min(WEB_TEXT_MAX_BYTES, Math.max(2048, Math.floor(raw)));
}

/** Allowed characters for safe math evaluation (digits, operators, whitespace, commas). */
const SAFE_CALC_CHARS = /^[0-9+\-*/().%\s,]+$/;

/** Allowed Math.* identifiers inside calculate expressions. */
const SAFE_MATH_IDENT = /^Math\.(abs|ceil|floor|round|sqrt|pow|min|max|log|exp|sin|cos|tan|PI|E)$/;

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  try {
    switch (name) {
      case 'get_datetime':
        return toolGetDatetime();
      case 'calculate':
        return toolCalculate(args);
      case 'web_search':
        return await toolWebSearch(args);
      case 'wikipedia_search':
        return await toolWikipediaSearch(args);
      case 'fetch_web_content':
        return await toolFetchWebContent(args);
      case 'rag_web_content':
        return await toolRagWebContent(args);
      case 'read_clipboard':
        return await toolReadClipboard(args);
      case 'write_clipboard':
        return await toolWriteClipboard(args);
      case 'get_system_info':
        return toolGetSystemInfo();
      case 'launch_minnow_app':
        return toolLaunchMinnowApp(args);
      case 'recall_chat_context':
        return await toolRecallChatContext(args);
      case 'recall_turn_full':
        return toolRecallTurnFull(args);
      case 'get_appearance':
        return toolGetAppearance();
      case 'update_appearance':
        return await toolUpdateAppearance(args);
      case 'upload_appearance_asset':
        return await toolUploadAppearanceAsset(args);
      default:
        return `Error: unknown browser tool "${name}"`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/** Current date/time as ISO 8601. */
function toolGetDatetime(): string {
  return new Date().toISOString();
}

function toolCalculate(args: Record<string, unknown>): string {
  const raw = args.expression;
  if (typeof raw !== 'string' || !raw.trim()) {
    return 'Error: "expression" is required';
  }

  const expression = raw.trim();
  if (!isSafeCalculateExpression(expression)) {
    return 'Error: expression contains disallowed characters or tokens';
  }

  try {
    const evaluate = new Function('Math', `"use strict"; return (${expression});`) as (
      math: typeof Math,
    ) => unknown;
    const result = evaluate(Math);

    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return 'Error: expression did not evaluate to a finite number';
    }

    return String(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: failed to evaluate expression (${message})`;
  }
}

/** Splits expression into tokens and validates each against safe char / Math rules. */
function isSafeCalculateExpression(expression: string): boolean {
  const tokens = expression.split(/(Math\.[a-zA-Z]+)/g).filter((t) => t.length > 0);

  for (const token of tokens) {
    if (token.startsWith('Math.')) {
      if (!SAFE_MATH_IDENT.test(token)) {
        return false;
      }
      continue;
    }
    if (!SAFE_CALC_CHARS.test(token)) {
      return false;
    }
  }

  return tokens.length > 0;
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Brave web search when api_key is set; otherwise instructs client to use server DDG.
 */
async function toolWebSearch(args: Record<string, unknown>): Promise<string> {
  const query = stringArg(args, 'query');
  if (!query) {
    return 'Error: "query" is required';
  }

  const apiKey =
    (typeof args.api_key === 'string' && args.api_key.trim()) ||
    (typeof args.braveApiKey === 'string' && args.braveApiKey.trim()) ||
    '';

  if (!apiKey) {
    return (
      'Error: no Brave API key provided. Save a key in tool settings or pass api_key. ' +
      'Without a key, web_search is handled by the local server (web_search_ddg via DuckDuckGo).'
    );
  }

  return searchBrave(query, apiKey);
}

/** Calls Brave Search API and formats top web results. */
async function searchBrave(query: string, apiKey: string): Promise<string> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '8');

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Brave search request failed (${message})`;
  }

  if (!response.ok) {
    return `Error: Brave search HTTP ${response.status} ${response.statusText}`;
  }

  let data: BraveSearchResponse;
  try {
    data = (await response.json()) as BraveSearchResponse;
  } catch {
    return 'Error: Brave search returned invalid JSON';
  }

  const results = data.web?.results ?? [];
  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  const lines = results.slice(0, 8).map((item, index) => {
    const title = item.title?.trim() || '(no title)';
    const link = item.url?.trim() || '';
    const snippet = item.description?.trim() || '';
    return `${index + 1}. ${title}\n   ${link}\n   ${snippet}`;
  });

  return `Brave search results for "${query}":\n\n${lines.join('\n\n')}`;
}

type WikipediaQueryPage = {
  title?: string;
  description?: string;
  extract?: string;
};

/** Loads short descriptions/extracts for article titles (best-effort; empty map on failure). */
async function fetchWikipediaDescriptionsByTitle(titles: string[]): Promise<Map<string, string>> {
  const byTitle = new Map<string, string>();
  if (!titles.length) {
    return byTitle;
  }

  const queryUrl = new URL('https://en.wikipedia.org/w/api.php');
  queryUrl.searchParams.set('action', 'query');
  queryUrl.searchParams.set('titles', titles.join('|'));
  queryUrl.searchParams.set('prop', 'description|extracts');
  queryUrl.searchParams.set('exintro', '1');
  queryUrl.searchParams.set('explaintext', '1');
  queryUrl.searchParams.set('exsentences', '2');
  queryUrl.searchParams.set('format', 'json');
  queryUrl.searchParams.set('origin', '*');

  try {
    const response = await fetch(queryUrl.toString());
    if (!response.ok) {
      return byTitle;
    }
    const data = (await response.json()) as {
      query?: { pages?: Record<string, WikipediaQueryPage> };
    };
    const pages = data.query?.pages;
    if (!pages) {
      return byTitle;
    }
    for (const page of Object.values(pages)) {
      const title = page.title?.trim();
      if (!title) {
        continue;
      }
      const text = page.description?.trim() || page.extract?.trim() || '';
      if (text) {
        byTitle.set(title, text);
      }
    }
  } catch {}

  return byTitle;
}

/** Wikipedia opensearch (CORS-open) plus short extracts when available. */
async function toolWikipediaSearch(args: Record<string, unknown>): Promise<string> {
  const query = stringArg(args, 'query');
  if (!query) {
    return 'Error: "query" is required';
  }

  const apiUrl = new URL('https://en.wikipedia.org/w/api.php');
  apiUrl.searchParams.set('action', 'opensearch');
  apiUrl.searchParams.set('search', query);
  apiUrl.searchParams.set('limit', '5');
  apiUrl.searchParams.set('namespace', '0');
  apiUrl.searchParams.set('format', 'json');
  apiUrl.searchParams.set('origin', '*');

  let response: Response;
  try {
    response = await fetch(apiUrl.toString());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Wikipedia request failed (${message})`;
  }

  if (!response.ok) {
    return `Error: Wikipedia HTTP ${response.status} ${response.statusText}`;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return 'Error: Wikipedia returned invalid JSON';
  }

  if (!Array.isArray(payload) || payload.length < 4) {
    return 'Error: unexpected Wikipedia response shape';
  }

  const titles = payload[1] as string[];
  const opensearchDescriptions = payload[2] as string[];
  const urls = payload[3] as string[];

  if (!titles.length) {
    return `No Wikipedia articles found for: ${query}`;
  }

  const descriptionsByTitle = await fetchWikipediaDescriptionsByTitle(titles);

  const blocks: string[] = [];
  for (let i = 0; i < titles.length; i += 1) {
    const title = titles[i] ?? '';
    const desc =
      descriptionsByTitle.get(title)?.trim() ||
      opensearchDescriptions[i]?.trim() ||
      '(no description)';
    const pageUrl = urls[i] ?? '';
    blocks.push(`${i + 1}. ${title}\n   ${pageUrl}\n   ${desc}`);
  }

  return `Wikipedia results for "${query}":\n\n${blocks.join('\n\n')}`;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** Fetches a URL, strips HTML, caps output at ~8KB. Browser fallback when server is down (CORS). */
async function toolFetchWebContent(args: Record<string, unknown>): Promise<string> {
  const url = stringArg(args, 'url');
  if (!url) {
    return 'Error: "url" is required';
  }

  const fetchResult = await fetchUrlText(url, { suggestNpmStart: true });
  if (fetchResult.startsWith('Error:')) {
    return fetchResult;
  }

  const text = capFetchedWebText(fetchResult, args, resolveFetchMaxBytes(args));
  if (text === fetchResult) return text;
  return `${text}\n[page continues — use rag_web_content with a query for the relevant parts, raise max_bytes (ceiling ${WEB_TEXT_MAX_BYTES}), or pass full_result: true]`;
}

/** Fetches a page and returns sentences most relevant to the query. */
async function toolRagWebContent(args: Record<string, unknown>): Promise<string> {
  const url = stringArg(args, 'url');
  const query = stringArg(args, 'query');

  if (!url) {
    return 'Error: "url" is required';
  }
  if (!query) {
    return 'Error: "query" is required';
  }

  const fetchResult = await fetchUrlText(url, { suggestNpmStart: true });
  if (fetchResult.startsWith('Error:')) {
    return fetchResult;
  }

  const capped = capFetchedWebText(fetchResult, args);
  const snippets = rankWebContentByQuery(capped, query, WEB_RAG_EXCERPT_LIMIT);

  if (snippets.length === 0) {
    return `No relevant sentences found on ${url} for query: ${query}`;
  }

  const header = `Relevant excerpts from ${url} for "${query}":\n\n`;
  return header + snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/** Reads plain text from the clipboard (permission may be required). */
async function toolReadClipboard(args: Record<string, unknown>): Promise<string> {
  if (!navigator.clipboard?.readText) {
    return 'Error: Clipboard API is not available in this browser';
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text.length === 0) return '(clipboard is empty)';
    // Whatever the user last copied lands here verbatim — a copied log or
    // spreadsheet is as unbounded as any file read.
    const policy = resolveOutputCapPolicy(loadToolConfig().toolOutput, args);
    return runWithOutputCapPolicy(
      policy,
      () => capTextOutput(text, { footerHint: 'the clipboard holds more than the result budget' }).text,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: could not read clipboard (${message}). Grant clipboard permission if prompted.`;
  }
}

/** Writes plain text to the clipboard. */
async function toolWriteClipboard(args: Record<string, unknown>): Promise<string> {
  const text = args.text;
  if (typeof text !== 'string') {
    return 'Error: "text" is required';
  }

  if (!navigator.clipboard?.writeText) {
    return 'Error: Clipboard API is not available in this browser';
  }

  try {
    await navigator.clipboard.writeText(text);
    return `Copied ${text.length} character(s) to the clipboard`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: could not write clipboard (${message})`;
  }
}

/** Serializes navigator and screen info as JSON for the model. */
function toolGetSystemInfo(): string {
  const nav = navigator;
  const info: Record<string, unknown> = {
    userAgent: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    languages: nav.languages,
    cookieEnabled: nav.cookieEnabled,
    onLine: nav.onLine,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: 'deviceMemory' in nav ? (nav as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
    window: {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp: new Date().toISOString(),
  };

  return JSON.stringify(info, null, 2);
}

/** Reads a trimmed string argument or returns empty string if missing/invalid. */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

/** Brave Search API web result shape (partial). */
interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}
