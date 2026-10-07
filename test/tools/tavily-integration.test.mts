import './install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, mock, test } from 'node:test';
import { defaultToolConfig } from '../../src/config/defaults.ts';
import { setToolConfigForTests, setLocalServerAvailable } from '../../src/tools/config.ts';
import { DEFAULT_SEARCH_CONFIG, loadSearchConfig, saveSearchConfig, resetSearchConfigCache } from '../../src/config/search-config.ts';
import { clearAllCaches } from '../../src/tools/result-cache.ts';
import { executeTool, getEnabledToolCatalogEntries } from '../../src/tools/client.ts';
import { executeHeadlessTool, getHeadlessToolDefinitions } from '../../src/headless/execute-tool.ts';

let calls: Array<{ name: string; args: Record<string, unknown> }>;
let search: typeof DEFAULT_SEARCH_CONFIG;

beforeEach(() => {
  resetSearchConfigCache();
  clearAllCaches();
  calls = [];
  search = { ...DEFAULT_SEARCH_CONFIG, provider: 'tavily', keys: { braveApiKey: '', tavilyApiKey: 'test-key' } };
  const config = defaultToolConfig();
  for (const id of ['web_search', 'web_map', 'web_extract']) {
    config.enabled[id] = true;
    config.permissions.default[id] = 'full';
  }
  setToolConfigForTests(config);
  setLocalServerAvailable(true);
  mock.method(globalThis, 'fetch', async (input, options) => {
    const url = String(input);
    if (url.endsWith('/api/config/search')) {
      if (options?.method === 'PUT') {
        search = JSON.parse(options.body as string);
        return Response.json({ data: search });
      }
      return Response.json(search);
    }
    if (url.endsWith('/api/tools')) {
      calls.push(JSON.parse(options?.body as string));
      return Response.json({ result: 'Documentation source content' });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
});
afterEach(() => mock.restoreAll());

test('Chat and headless preserve Tavily search controls and Plan mode supports the tools', async () => {
  const args = { query: 'Authentication API', include_domains: ['example.com'],
    search_depth: 'advanced', max_results: 5, deep_read: false };
  assert.doesNotMatch((await executeTool('web_search', args, { modeId: 'plan' })).content, /^Error:/);
  assert.equal(calls[0].name, 'web_search_tavily');
  assert.deepEqual(calls[0].args, args);
  assert.doesNotMatch((await executeHeadlessTool('web_search', args, {}, { modeId: 'plan' })).content, /^Error:/);
  assert.deepEqual(calls[1].args, args);
  assert.doesNotMatch((await executeTool('web_map', { url: 'https://example.com' }, { modeId: 'plan' })).content, /^Error:/);
  assert.doesNotMatch((await executeTool('web_extract', { urls: ['https://example.com/a'] }, { modeId: 'plan' })).content, /^Error:/);
});

test('Map and Extract availability uses Tavily credentials independently of selected search provider', async () => {
  search.provider = 'duckduckgo';
  await loadSearchConfig();
  assert.ok(getEnabledToolCatalogEntries().some((tool) => tool.id === 'web_map'));
  assert.ok(getHeadlessToolDefinitions('plan').some((tool) => tool.function.name === 'web_extract'));
  search = { ...search, keys: { ...search.keys, tavilyApiKey: '' } };
  await saveSearchConfig(search);
  assert.ok(!getEnabledToolCatalogEntries().some((tool) => tool.id === 'web_map'));
  assert.ok(!getHeadlessToolDefinitions('plan').some((tool) => tool.function.name === 'web_extract'));
});

test('Changing provider invalidates cached searches and unsupported controls are explicit', async () => {
  await executeTool('web_search', { query: 'API' }, {});
  await executeTool('web_search', { query: 'API' }, {});
  assert.equal(calls.length, 1);
  await saveSearchConfig({ ...search, provider: 'duckduckgo' });
  await executeTool('web_search', { query: 'API' }, {});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'web_search_ddg');
  const result = await executeTool('web_search', { query: 'API', include_domains: ['example.com'] }, {});
  assert.match(result.content, /require Tavily/);
  assert.equal(calls.length, 2);
});

test('Off and Ask permissions cannot be bypassed by cached Map results', async () => {
  const args = { url: 'https://example.com' };
  await executeTool('web_map', args, {});
  const config = defaultToolConfig();
  config.enabled.web_map = false;
  config.permissions.default.web_map = 'off';
  setToolConfigForTests(config);
  assert.match((await executeTool('web_map', args, {})).content, /disabled|off/i);
  config.enabled.web_map = true;
  config.permissions.default.web_map = 'ask';
  setToolConfigForTests(config);
  assert.match((await executeHeadlessTool('web_map', args, {}, { modeId: 'plan' })).content, /approval|permission/i);
  assert.equal(calls.length, 1);
});
