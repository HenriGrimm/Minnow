import assert from 'node:assert/strict';
import { after, afterEach, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';

const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-tavily-contract-'));
process.env.MINNOW_HOME = scratchHome;
const { writeResource } = await import('../../server/config/store.js');
const { executeServerTool } = await import('../../server/runtime/tools-middleware.js');
const { handleConfigRequest } = await import('../../server/config/middleware.js');

afterEach(() => mock.restoreAll());
after(async () => { await fs.rm(scratchHome, { recursive: true, force: true }); });

test('Real server handlers resolve the saved key and share the tool contract', async () => {
  await writeResource('search', { provider: 'duckduckgo', keys: { tavilyApiKey: 'server-test-key' }, resultCount: 12 });
  mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  const bodies: Record<string, unknown>[] = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer server-test-key');
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (String(url).endsWith('/map')) return Response.json({ results: ['https://example.com/docs'] });
    if (String(url).endsWith('/extract')) return Response.json({ results: [{ url: 'https://example.com/docs', raw_content: '# Documentation' }] });
    return Response.json({ results: [{ title: 'Authentication', url: 'https://example.com/docs', content: 'Authentication API' }] });
  });
  assert.match((await executeServerTool('web_map', { url: 'https://example.com' })).result, /example.com\/docs/);
  assert.match((await executeServerTool('web_extract', { urls: ['https://example.com/docs'] })).result, /Documentation/);
  assert.match((await executeServerTool('web_search_tavily', { query: 'Authentication', search_depth: 'advanced' })).result, /Authentication API/);
  assert.equal(bodies[2].max_results, 12);
  assert.equal(bodies[2].search_depth, 'advanced');
  assert.match((await executeServerTool('web_search_ddg', { query: 'API', time_range: 'week' })).result, /require Tavily/);
  assert.equal(bodies.length, 3);
});

test('Settings usage route returns account data with no credential fields', async () => {
  await writeResource('search', { provider: 'duckduckgo', keys: { tavilyApiKey: 'usage-route-key' } });
  mock.method(globalThis, 'fetch', async () => Response.json({ key: { usage: 20, limit: 100 },
    account: { current_plan: 'Free', plan_usage: 50, plan_limit: 1000 } }));
  let payload = '';
  const headers: Record<string, string> = {};
  const response = { statusCode: 0, setHeader(name: string, value: string) { headers[name] = value; }, end(value: string) { payload = value; } };
  assert.equal(await handleConfigRequest({ method: 'GET', url: '/api/config/search/tavily-usage?refresh=1' }, response,
    '/api/config/search/tavily-usage'), true);
  assert.equal(response.statusCode, 200);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(JSON.parse(payload).key.usage, 20);
  assert.equal(JSON.parse(payload).account.plan_usage, 50);
  assert.doesNotMatch(payload, /usage-route-key/);
  await writeResource('search', { provider: 'duckduckgo', keys: { tavilyApiKey: '' } });
  await handleConfigRequest({ method: 'GET', url: '/api/config/search/tavily-usage' }, response, '/api/config/search/tavily-usage');
  assert.equal(response.statusCode, 502);
  assert.match(JSON.parse(payload).error, /Add a Tavily/);
});
