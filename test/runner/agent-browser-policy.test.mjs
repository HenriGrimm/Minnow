import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_BROWSER_TOOL_IDS, BOARD_WRITE_TOOL_IDS,
  dispatchToolIdsForRole, headlessToolIdsForRole, isRendererOnlyTool,
} from '../../server/runner/tool-set.js';
import { agentBrowserToolDefinition } from '../../server/tools/agent-browser-tool-defs.js';

test('board roles cannot reserve browsers; sub-agents retain browser tools', () => {
  for (const role of ['builder', 'tester', 'final', 'merge']) {
    const allowed = new Set(headlessToolIdsForRole(role));
    const dispatchable = new Set(dispatchToolIdsForRole(role));
    for (const id of AGENT_BROWSER_TOOL_IDS) {
      assert.equal(allowed.has(id), false, `${role} must not have ${id}`);
      assert.equal(dispatchable.has(id), false, `${role} must not dispatch ${id}`);
      assert.equal(isRendererOnlyTool(id), false);
    }
    if (['tester', 'final', 'merge'].includes(role)) {
      for (const id of BOARD_WRITE_TOOL_IDS) assert.equal(allowed.has(id), false);
    }
  }
  const subAgentTools = new Set(headlessToolIdsForRole('sub-agent'));
  for (const id of AGENT_BROWSER_TOOL_IDS) assert.ok(subAgentTools.has(id));
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
