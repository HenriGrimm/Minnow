import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLazyToolSession } from '../../server/runner/lazy-tools.js';
import { normalizeToolConfig } from '../../server/config/validators.js';

const tool = (name, description = name) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties: {} },
} });
const catalog = [tool('read_file'), tool('git_diff', 'Inspect repository changes'),
  tool('browser_screenshot', 'Capture browser image'), tool('report_custom')];

test('core and injected tools stay present; discovery adds schemas once and resets per turn', () => {
  const session = createLazyToolSession(catalog, ['report_custom']);
  assert.deepEqual(session.tools.map(t => t.function.name), ['read_file', 'report_custom', 'search_tools']);
  const initial = session.tools;
  assert.deepEqual(JSON.parse(session.search({ query: 'git_diff', limit: 1 })).loaded, ['git_diff']);
  assert.equal(session.tools, initial);
  assert.equal(session.tools.at(-1), catalog[1]);
  session.search({ query: 'git_diff' });
  assert.equal(session.tools.length, 4);
  assert.equal(createLazyToolSession(catalog).isLoaded('git_diff'), false);
});

test('search uses capability descriptions and never returns tools outside the permitted catalog', () => {
  const session = createLazyToolSession(catalog);
  assert.deepEqual(JSON.parse(session.search({ query: 'repository changes', limit: 1 })).loaded, ['git_diff']);
  assert.deepEqual(JSON.parse(session.search({ query: 'delete_path' })).loaded, []);
  assert.equal(session.isLoaded('delete_path'), false);
});

test('malformed and unbounded searches do not load schemas', () => {
  const session = createLazyToolSession(catalog);
  const before = session.tools.length;
  for (const args of ['{', null, [], {}, { query: ' ' }, { query: 'x'.repeat(501) },
    { query: 'git', limit: 6 }, { query: 'git', limit: 1.5 }]) {
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

