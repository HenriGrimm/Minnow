import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headlessToolDefinitions } from '../../server/tools/headless-tool-defs.js';
import { getToolById } from '../../server/tools/builtin-catalog.js';
import { agentBrowserToolDefinition } from '../../server/tools/agent-browser-tool-defs.js';
import { headlessToolIdsForRole } from '../../server/runner/tool-set.js';
import { createLazyToolSession } from '../../server/runner/lazy-tools.js';

for (const role of ['builder', 'tester', 'final', 'sub-agent']) {
  test(`${role} advertises full schemas for every permitted tool`, () => {
    const ids = headlessToolIdsForRole(role);
    const tools = headlessToolDefinitions(ids);
    assert.deepEqual(tools.map(tool => tool.function.name), ids);
    for (const { function: fn } of tools) {
      assert.ok(fn.parameters.properties, `${fn.name} has no parameter definitions`);
      assert.notEqual(fn.description, fn.name);
      for (const required of fn.parameters.required ?? []) {
        assert.ok(fn.parameters.properties[required], `${fn.name}.${required} is missing`);
      }
    }
    const byName = new Map(tools.map(tool => [tool.function.name, tool]));
    for (const [name, required] of [['read_file', 'path'], ['grep', 'pattern'], ['execute_command', 'command']]) {
      assert.ok(byName.get(name).function.parameters.required.includes(required));
    }
    assert.deepEqual(byName.get('browser_navigate'), agentBrowserToolDefinition('browser_navigate'));
  });
}

test('lazy discovery retains required arguments and canonical descriptions', () => {
  const session = createLazyToolSession(headlessToolDefinitions(headlessToolIdsForRole('builder')));
  assert.equal(session.isLoaded('find_files'), false);
  session.search({ query: 'find_files', limit: 1 });
  const tool = session.tools.find(tool => tool.function.name === 'find_files');
  assert.deepEqual(tool, getToolById('find_files').definition);
  assert.ok(tool.function.parameters.required.includes('pattern'));
});

test('server search schemas require query without advertising unused API key overrides', () => {
  for (const tool of headlessToolDefinitions(['web_search_ddg', 'web_search_tavily', 'web_search_searxng'])) {
    assert.deepEqual(tool.function.parameters.required, ['query']);
    assert.ok(tool.function.parameters.properties.deep_read);
    assert.equal(tool.function.parameters.properties.api_key, undefined);
  }
});

test('missing schemas fail explicitly and callers cannot mutate the shared catalog', () => {
  assert.throws(() => headlessToolDefinitions(['unknown_tool']), /Missing tool schema/);
  const [tool] = headlessToolDefinitions(['read_file']);
  tool.function.parameters.required.length = 0;
  assert.deepEqual(headlessToolDefinitions(['read_file'])[0].function.parameters.required, ['path']);
});
