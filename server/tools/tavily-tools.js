import { assertPublicUrl } from '../../src/lib/assert-public-url.mjs';
import { truncateUtf8 } from '../../src/lib/fetch-web-content.mjs';
import { wrapUntrusted } from '../security/untrusted.js';
import { getOutputCapPolicy } from './output-cap.js';
import { requestTavily } from './tavily-client.js';
import { validateOptions } from './tavily-options.js';
import { MAP_PROPERTIES, EXTRACT_PROPERTIES } from './tavily-tool-schemas.js';

function capped(text, bytes) {
  if (!getOutputCapPolicy().applyResultCap) return text;
  const result = truncateUtf8(text, bytes);
  return result === text ? text : `${result}\n[Content truncated. Extract fewer URLs or provide a query for relevant excerpts.]`;
}

export async function runTavilyMap(args, apiKey, signal) {
  validateOptions(args, MAP_PROPERTIES);
  const url = await assertPublicUrl(args.url);
  const options = Object.fromEntries(Object.keys(MAP_PROPERTIES).filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  const payload = await requestTavily('map', apiKey, {
    max_depth: 1, max_breadth: 20, limit: 50, allow_external: false, timeout: 60,
    ...options, url: url.href, include_usage: true,
  }, signal);
  if (!Array.isArray(payload.results) || payload.results.some((item) => typeof item !== 'string')) throw new Error('Tavily returned invalid map results');
  const urls = [...new Set(payload.results)].slice(0, args.limit ?? 50);
  const lines = [`Discovered URLs from ${url.href} (${urls.length}). Mapping is bounded and may be incomplete.`, ...urls];
  if (payload.results.length >= (args.limit ?? 50)) lines.push('[Mapping limit reached; narrow the path filters or increase limit.]');
  return wrapUntrusted(capped(lines.join('\n'), 49152), { source: `web-map:${url.href}` });
}

export async function runTavilyExtract(args, apiKey, signal) {
  validateOptions(args, EXTRACT_PROPERTIES);
  if (!Array.isArray(args.urls) || !args.urls.length) throw new Error('urls must contain 1–10 public URLs');
  if (args.chunks_per_source !== undefined && !args.query) throw new Error('chunks_per_source requires query');
  const urls = [...new Set(args.urls)];
  for (const url of urls) await assertPublicUrl(url);
  const options = Object.fromEntries(Object.keys(EXTRACT_PROPERTIES).filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
  const payload = await requestTavily('extract', apiKey, {
    extract_depth: 'basic', format: 'markdown', timeout: 30,
    ...options, urls, include_usage: true,
  }, signal);
  if (!Array.isArray(payload.results) || payload.results.some((row) => typeof row?.url !== 'string' || typeof row?.raw_content !== 'string') ||
      (payload.failed_results !== undefined && !Array.isArray(payload.failed_results))) throw new Error('Tavily returned invalid extract results');
  const parts = payload.results.slice(0, 10).map((row) => `Source: ${row.url}\n${capped(row.raw_content, 24576)}`);
  for (const row of (payload.failed_results ?? []).slice(0, 10)) {
    parts.push(`Failed: ${String(row.url ?? 'unknown')}\n${String(row.error ?? 'Extraction failed')}`);
  }
  if (!parts.length) parts.push('No content extracted.');
  return wrapUntrusted(capped(parts.join('\n\n'), 98304), { source: 'web-extract:tavily' });
}
