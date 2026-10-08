import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import dns from 'node:dns/promises';
import { requestTavily } from '../../server/tools/tavily-client.js';
import { runTavilyMap, runTavilyExtract } from '../../server/tools/tavily-tools.js';
import { searchTavilyStructured, formatTavilySearchResults } from '../../server/tools/web-search-tavily.js';
import { searchOptions, unsupportedSearchOptions } from '../../server/tools/tavily-options.js';
import { getTavilyUsage } from '../../server/tools/tavily-usage.js';
import { headlessToolDefinitions } from '../../server/tools/headless-tool-defs.js';

afterEach(() => mock.restoreAll());

function publicDns() {
  mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
}

test('Map passes bounded defaults and path controls and deduplicates output', async () => {
  publicDns();
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.tavily.com/map');
    const body = JSON.parse(options.body);
    assert.equal(body.allow_external, false);
    assert.equal(body.limit, 50);
    assert.equal(body.timeout, 60);
    assert.deepEqual(body.select_paths, ['/docs/.*']);
    assert.ok(options.signal);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    return Response.json({ results: ['https://example.com/docs', 'https://example.com/docs'] });
  });
  const result = await runTavilyMap({ url: 'https://example.com', select_paths: ['/docs/.*'] }, 'test-key');
  assert.match(result, /bounded and may be incomplete/);
  assert.equal(result.split('https://example.com/docs').length, 2);
  assert.match(result, /untrusted/i);
});

test('Extract keeps successful content and failed URL details; query controls reach Tavily', async () => {
  publicDns();
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.query, 'authentication');
    assert.equal(body.chunks_per_source, 4);
    assert.equal(body.extract_depth, 'advanced');
    assert.equal(body.format, 'markdown');
    return Response.json({ results: [{ url: 'https://example.com/a', raw_content: '# Auth\nUse a token.' }],
      failed_results: [{ url: 'https://example.com/b', error: 'Not found' }] });
  });
  const result = await runTavilyExtract({ urls: ['https://example.com/a', 'https://example.com/b'],
    query: 'authentication', chunks_per_source: 4, extract_depth: 'advanced' }, 'test-key');
  assert.match(result, /Source: https:\/\/example.com\/a/);
  assert.match(result, /Use a token/);
  assert.match(result, /Failed: https:\/\/example.com\/b/);
});

test('Extract caps long pages and reports truncation without losing later sources', async () => {
  publicDns();
  mock.method(globalThis, 'fetch', async () => Response.json({ results: [
    { url: 'https://example.com/a', raw_content: 'a'.repeat(60000) },
    { url: 'https://example.com/b', raw_content: 'Important second page' },
  ] }));
  const result = await runTavilyExtract({ urls: ['https://example.com/a', 'https://example.com/b'] }, 'test-key');
  assert.match(result, /Content truncated/);
  assert.match(result, /Important second page/);
  assert.ok(result.length < 30000);
});

test('Reject invalid parameters and private URLs before a paid request', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('must not call'); });
  await assert.rejects(runTavilyMap({ url: 'http://127.0.0.1' }, 'key'), /blocked/);
  await assert.rejects(runTavilyMap({ url: 'https://example.com', limit: 201 }, 'key'), /limit/);
  await assert.rejects(runTavilyExtract({ urls: [] }, 'key'), /urls/);
  await assert.rejects(runTavilyExtract({ urls: ['https://example.com'], chunks_per_source: 2 }, 'key'), /requires query/);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.throws(() => searchOptions({ start_date: '2026-02-30' }), /valid/);
  assert.throws(() => searchOptions({ time_range: 'week', end_date: '2026-10-07' }), /not both/);
  assert.throws(() => searchOptions({ start_date: '2026-10-07', end_date: '2025-10-07' }), /before/);
  assert.throws(() => searchOptions({ search_depth: 'ultra-fast', chunks_per_source: 2 }), /unavailable/);
  assert.throws(() => searchOptions({ max_results: 21 }), /max_results/);
});

test('Search forwards rich controls, clamps saved count, and preserves richer excerpts', async () => {
  const snippet = 'Authentication details '.repeat(60);
  mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_results, 20);
    assert.equal(body.search_depth, 'advanced');
    assert.deepEqual(body.include_domains, ['example.com']);
    assert.equal(body.time_range, 'month');
    assert.equal(body.topic, 'news');
    return Response.json({ results: [{ title: 'Authentication', url: 'https://example.com', content: snippet }] });
  });
  const outcome = await searchTavilyStructured('authentication', 'key', 50,
    { search_depth: 'advanced', include_domains: ['example.com'], time_range: 'month', topic: 'news' });
  assert.equal(outcome.error, undefined);
  assert.ok(formatTavilySearchResults('authentication', outcome.results).includes(snippet));
});

test('API errors are actionable, sanitized, and never automatically retried', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ detail: { error: 'secret-key' } }, { status: 432 }));
  await assert.rejects(requestTavily('map', 'secret-key', { url: 'https://example.com' }), /credit limit/);
  assert.equal(fetchMock.mock.callCount(), 1);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('bad json'));
  await assert.rejects(requestTavily('usage', 'key'), /invalid JSON/);
});

test('Cancellation and oversized responses stop reading', async () => {
  const controller = new AbortController();
  controller.abort();
  mock.method(globalThis, 'fetch', async (_url, options) => { options.signal.throwIfAborted(); });
  await assert.rejects(requestTavily('map', 'key', {}, controller.signal), /cancelled/);
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(requestTavily('usage', 'key'), /2 MB/);
});

test('Usage cache is scoped to saved key; unavailable values stay null', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (_url, options) => Response.json({
    key: { usage: options.headers.Authorization.endsWith('usage-a') ? 15 : 30, limit: 100 },
    account: { current_plan: 'Free', plan_usage: 40, plan_limit: 1000, paygo_usage: null },
  }));
  const first = await getTavilyUsage('usage-a');
  assert.equal(first.account.paygo_usage, null);
  assert.equal(first.key.extract_usage, null);
  assert.deepEqual(await getTavilyUsage('usage-a'), first);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal((await getTavilyUsage('usage-b')).key.usage, 30);
  await getTavilyUsage('usage-b', true);
  assert.equal(fetchMock.mock.callCount(), 3);
});

test('Server and headless schemas share controls only on supported backends', () => {
  const [map, extract, tavily, ddg] = headlessToolDefinitions(['web_map', 'web_extract', 'web_search_tavily', 'web_search_ddg']);
  assert.deepEqual(map.function.parameters.required, ['url']);
  assert.deepEqual(extract.function.parameters.required, ['urls']);
  assert.ok(tavily.function.parameters.properties.include_domains);
  assert.equal(ddg.function.parameters.properties.include_domains, undefined);
  assert.match(unsupportedSearchOptions({ include_domains: ['example.com'] }, 'ddg'), /require Tavily/);
  assert.equal(unsupportedSearchOptions({ query: 'hi' }, 'ddg'), '');
});
