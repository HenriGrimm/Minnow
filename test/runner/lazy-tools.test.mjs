import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLazyToolSession, ISSUE_TOOL_NAMES } from '../../server/runner/lazy-tools.js';
import { normalizeToolConfig } from '../../server/config/validators.js';

const tool = (name, description = name) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties: {} },
} });

test('coding essentials are immediately callable only when authorized', () => {
  const names = [
    'apply_patch', 'git_diff', 'git_status', 'get_lsp_diagnostics',
    'repo_map', 'find_symbol', 'read_symbol', 'who_calls',
    'stop_command', 'save_memory', 'browser_new_tab', 'browser_navigate',
    'browser_screenshot', 'browser_eval', 'browser_close_tab',
  ];
  const session = createLazyToolSession(names.map(name => tool(name)));
  for (const name of names) assert.equal(session.isLoaded(name), true);
  assert.equal(createLazyToolSession([tool('git_diff')]).isLoaded('apply_patch'), false);
});
const catalog = [tool('read_file'), tool('git_log', 'Inspect repository changes'),
  tool('browser_screenshot', 'Capture browser image'), tool('report_custom')];

test('core and injected tools stay present; discovery adds schemas once and resets per turn', () => {
  const session = createLazyToolSession(catalog, ['report_custom']);
  assert.deepEqual(session.tools.map(t => t.function.name),
    ['read_file', 'browser_screenshot', 'report_custom', 'search_tools']);
  const initial = session.tools;
  assert.deepEqual(JSON.parse(session.search({ query: 'git_log', limit: 1 })).loaded, ['git_log']);
  assert.equal(session.tools, initial);
  assert.equal(session.tools.at(-1), catalog[1]);
  session.search({ query: 'git_log' });
  assert.equal(session.tools.length, 5);
  assert.equal(createLazyToolSession(catalog).isLoaded('git_log'), false);
});

test('permitted issue tools are loaded without a search, and stay absent when not permitted', () => {
  const issues = ISSUE_TOOL_NAMES.map(name => tool(name));
  const session = createLazyToolSession([...catalog, ...issues]);
  for (const name of ISSUE_TOOL_NAMES) assert.equal(session.isLoaded(name), true);
  // Core is an intersection, never an addition: a mode without the issues group
  // must not gain them.
  assert.equal(createLazyToolSession(catalog).isLoaded('issue_add'), false);
});

test('search uses capability descriptions and never returns tools outside the permitted catalog', () => {
  const session = createLazyToolSession(catalog);
  assert.deepEqual(JSON.parse(session.search({ query: 'repository changes', limit: 1 })).loaded, ['git_log']);
  assert.deepEqual(JSON.parse(session.search({ query: 'delete_path' })).loaded, []);
  assert.equal(session.isLoaded('delete_path'), false);
});

test('list_only returns all permitted names without loading schemas or applying the search limit', () => {
  const permitted = [...catalog, tool('mcp__docs__read'), tool('plugin_search'), tool('git_log'), catalog[0]];
  const session = createLazyToolSession(permitted);
  const before = session.tools.slice();
  const expected = [...new Set(permitted.map(t => t.function.name))].sort();
  for (const args of [{ list_only: true }, { list_only: true, query: 'git', limit: 1 }]) {
    const result = JSON.parse(session.search(JSON.stringify(args)));
    assert.deepEqual(result.names, expected);
    assert.equal(JSON.stringify(result).includes('parameters'), false);
    assert.deepEqual(session.tools, before);
    assert.equal(session.isLoaded('git_log'), false);
    assert.equal(result.names.includes('delete_path'), false);
  }
  session.search({ query: 'git_log', list_only: false, limit: 1 });
  const afterSearch = session.tools.slice();
  assert.deepEqual(JSON.parse(session.search({ list_only: true })).names, expected);
  assert.deepEqual(session.tools, afterSearch);
});

test('malformed and unbounded searches do not load schemas', () => {
  const session = createLazyToolSession(catalog);
  const before = session.tools.length;
  for (const args of ['{', null, [], {}, { query: ' ' }, { query: 'x'.repeat(501) },
    { query: 'git', limit: 6 }, { query: 'git', limit: 1.5 },
    { list_only: 'true' }, { list_only: false }, { list_only: true, query: 12 }]) {
    assert.match(session.search(args), /^Error:/);
  }
  assert.equal(session.tools.length, before);
});

test('small core-only catalogs need no discovery schema', () => {
  assert.deepEqual(createLazyToolSession([catalog[0]]).tools, [catalog[0]]);
  assert.deepEqual(createLazyToolSession([]).tools, []);
});

test('stored setting defaults on and preserves explicit off', () => {
  assert.equal(normalizeToolConfig(undefined).lazyTools, true);
  assert.equal(normalizeToolConfig({}).lazyTools, true);
  assert.equal(normalizeToolConfig({ lazyTools: false }).lazyTools, false);
  assert.equal(normalizeToolConfig({ lazyTools: 'false' }).lazyTools, true);
});
