import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCapabilityIndex, createLazyToolSession, CORE_TOOL_NAMES, ISSUE_TOOL_NAMES } from '../../server/runner/lazy-tools.js';
import { normalizeToolConfig } from '../../server/config/validators.js';

const tool = (name, description = name) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties: {} },
} });

test('the lean core is immediately callable only when authorized', () => {
  const names = [
    'load_skill', 'read_file', 'list_directory', 'grep', 'find_files',
    'apply_patch', 'save_file', 'replace_text_in_file', 'execute_command',
    'read_command_log', 'stop_command', 'todo_write', 'ask_question',
    'spawn_sub_agent', 'web_search', 'fetch_web_content',
  ];
  const session = createLazyToolSession(names.map(name => tool(name)));
  for (const name of names) assert.equal(session.isLoaded(name), true);
  assert.equal(createLazyToolSession([tool('read_file')]).isLoaded('apply_patch'), false);
  for (const name of CORE_TOOL_NAMES) assert.equal(name.startsWith('git_') || name.startsWith('browser_'), false);
});
const catalog = [tool('read_file'), tool('git_log', 'Inspect repository changes'),
  tool('browser_screenshot', 'Capture browser image'), tool('report_custom')];

test('core and injected tools stay present; discovery adds schemas once and resets per turn', () => {
  const session = createLazyToolSession(catalog, ['report_custom']);
  assert.deepEqual(session.tools.map(t => t.function.name),
    ['read_file', 'report_custom', 'search_tools']);
  const initial = session.tools;
  assert.deepEqual(JSON.parse(session.search({ query: 'git_log', limit: 1 })).loaded, ['git_log']);
  assert.equal(session.tools, initial);
  assert.equal(session.tools.at(-1), catalog[1]);
  session.search({ query: 'git_log' });
  assert.equal(session.tools.length, 4);
  assert.equal(createLazyToolSession(catalog).isLoaded('git_log'), false);
});

test('issue tools are deferred but named in the capability index', () => {
  const issues = ISSUE_TOOL_NAMES.map(name => tool(name));
  const session = createLazyToolSession([...catalog, ...issues]);
  for (const name of ISSUE_TOOL_NAMES) assert.equal(session.isLoaded(name), false);
  const description = session.tools.find(t => t.function.name === 'search_tools').function.description;
  assert.match(description, /issues \(project tracker\): issue_add/);
  assert.match(description, /git: git_log/);
});

test('select: loads exact names and returns their schemas in the result', () => {
  const session = createLazyToolSession([...catalog, tool('issue_add'), tool('issue_search')]);
  const result = JSON.parse(session.search({ query: 'select:issue_add, git_log ,nope' }));
  assert.deepEqual(result.loaded, ['issue_add', 'git_log']);
  assert.deepEqual(result.tools.map(fn => fn.name), ['issue_add', 'git_log']);
  assert.ok(result.tools[0].parameters);
  assert.deepEqual(result.not_found, ['nope']);
  assert.equal(session.isLoaded('issue_add'), true);
  assert.equal(session.isLoaded('issue_search'), false);
});

test('capability index groups MCP tools per server without listing schemas', () => {
  const index = buildCapabilityIndex(['mcp__linear__create_issue', 'mcp__linear__list', 'mcp__my_srv__go', 'git_status']);
  assert.match(index, /- git: git_status/);
  assert.match(index, /- mcp · linear: 2 tools — mcp__linear__\*/);
  assert.match(index, /- mcp · my_srv: 1 tool — mcp__my_srv__\*/);
});

test('search uses capability descriptions and never returns tools outside the permitted catalog', () => {
  const session = createLazyToolSession(catalog);
  assert.deepEqual(JSON.parse(session.search({ query: 'repository changes', limit: 1 })).loaded, ['git_log']);
  assert.deepEqual(JSON.parse(session.search({ query: 'delete_path' })).loaded, []);
  assert.equal(session.isLoaded('delete_path'), false);
});

test('discovering browser_click also loads the snapshot needed to get its UID', () => {
  const session = createLazyToolSession([
    tool('browser_click'), tool('browser_snapshot'), tool('browser_eval'),
  ]);
  assert.equal(session.isLoaded('browser_click'), false);
  assert.deepEqual(JSON.parse(session.search({ query: 'browser_click', limit: 1 })).loaded,
    ['browser_snapshot', 'browser_click']);
  assert.equal(session.isLoaded('browser_snapshot'), true);
  assert.equal(session.isLoaded('browser_click'), true);
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
