import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_BROWSER_TOOL_IDS, BOARD_WRITE_TOOL_IDS,
  headlessToolIdsForRole, isRendererOnlyTool,
} from '../../server/runner/tool-set.js';
import { agentBrowserToolDefinition } from '../../server/tools/agent-browser-tool-defs.js';

test('board and sub-agent roles can reserve browsers without widening checkout write access', () => {
  for (const role of ['builder', 'tester', 'final', 'merge', 'sub-agent']) {
    const allowed = new Set(headlessToolIdsForRole(role));
    for (const id of AGENT_BROWSER_TOOL_IDS) {
      assert.ok(allowed.has(id), `${role} missing ${id}`);
      assert.equal(isRendererOnlyTool(id), false);
    }
    if (['tester', 'final', 'merge'].includes(role)) {
      for (const id of BOARD_WRITE_TOOL_IDS) assert.equal(allowed.has(id), false);
    }
  }
});

test('server browser schemas require explicit targets and never expose ownership arguments', () => {
  for (const id of AGENT_BROWSER_TOOL_IDS) {
    const schema = agentBrowserToolDefinition(id);
    assert.ok(schema);
    const parameters = schema.function.parameters;
    assert.deepEqual(parameters.properties.surface.enum, ['agent']);
    for (const key of ['owner', 'runtimeOwner', 'chatId', 'runId', 'agentId', 'lease']) {
      assert.equal(Object.hasOwn(parameters.properties, key), false);
    }
    if (!['browser_reserve_tab', 'browser_new_tab', 'browser_list'].includes(id)) {
      assert.ok(parameters.required.includes('tab_id'), `${id} lacks explicit target`);
    }
  }
  const first = agentBrowserToolDefinition('browser_navigate');
  first.function.parameters.required.length = 0;
  assert.deepEqual(agentBrowserToolDefinition('browser_navigate').function.parameters.required, ['tab_id', 'url']);
});
