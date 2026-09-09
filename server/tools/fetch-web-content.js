/**
 * Server-side fetch_web_content and rag_web_content (BUG-011 / BUG-015).
 * Node fetch avoids browser CORS; HTML strip/truncate shared with browser executor.
 */

import {
  fetchUrlText,
  rankWebContentByQuery,
  truncateUtf8,
  WEB_RAG_EXCERPT_LIMIT,
  WEB_TEXT_DEFAULT_MAX_BYTES,
  WEB_TEXT_MAX_BYTES,
} from '../../src/lib/fetch-web-content.mjs';
import { wrapUntrusted } from '../security/untrusted.js';
import { getOutputCapPolicy } from './output-cap.js';

/**
 * Apply the product web-text byte cap unless this call skipped result caps.
 *
 * @param {string} text
 * @param {number} [maxBytes]
 */
function capFetchedWebText(text, maxBytes = WEB_TEXT_MAX_BYTES) {
  const policy = getOutputCapPolicy();
  if (!policy.applyResultCap) return text;
  return truncateUtf8(text, maxBytes);
}

/**
 * @param {Record<string, unknown>} args
 * @returns {number}
 */
function resolveFetchMaxBytes(args) {
  const raw = Number(args?.max_bytes);
  if (!Number.isFinite(raw)) return WEB_TEXT_DEFAULT_MAX_BYTES;
  return Math.min(WEB_TEXT_MAX_BYTES, Math.max(2048, Math.floor(raw)));
}

/**
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolFetchWebContent(args) {
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!url) {
    return 'Error: "url" is required';
  }

  const fetchResult = await fetchUrlText(url);
  if (fetchResult.startsWith('Error:')) {
    return fetchResult;
  }

  const maxBytes = resolveFetchMaxBytes(args);
  let text = capFetchedWebText(fetchResult, maxBytes);
  if (text !== fetchResult) {
    text += `\n[page continues — use rag_web_content with a query for the relevant parts, raise max_bytes (ceiling ${WEB_TEXT_MAX_BYTES}), or pass full_result: true]`;
  }
  return wrapUntrusted(text, { source: `web:${url}` });
}

/**
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
export async function toolRagWebContent(args) {
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  const query = typeof args?.query === 'string' ? args.query.trim() : '';

  if (!url) {
    return 'Error: "url" is required';
  }
  if (!query) {
    return 'Error: "query" is required';
  }

  const fetchResult = await fetchUrlText(url);
  if (fetchResult.startsWith('Error:')) {
    return fetchResult;
  }

  const capped = capFetchedWebText(fetchResult);
  const snippets = rankWebContentByQuery(capped, query, WEB_RAG_EXCERPT_LIMIT);

  if (snippets.length === 0) {
    return `No relevant sentences found on ${url} for query: ${query}`;
  }

  const header = `Relevant excerpts from ${url} for "${query}":\n\n`;
  const body = header + snippets.map((s, i) => `${i + 1}. ${s}`).join('\n\n');
  return wrapUntrusted(body, { source: `web-rag:${url}` });
}
