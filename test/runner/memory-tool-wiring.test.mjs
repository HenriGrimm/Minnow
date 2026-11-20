/**
 * Project memory tool wiring: catalog, lazy discovery, board roles, headless
 * defaults, permissions and parallel policy. The retired wiki tools are gone.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUILT_IN_TOOLS } from '../../server/tools/builtin-catalog.js';
import { ALL_TOOL_IDS, MEMORY_TOOL_IDS } from '../../server/config/tool-ids.js';
import { createLazyToolSession } from '../../server/runner/lazy-tools.js';
import {
  BOARD_BUILDER_TOOL_IDS,
  BOARD_VERIFIER_TOOL_IDS,
  DEFAULT_HEADLESS_TOOL_IDS,
} from '../../server/runner/tool-set.js';
import { isParallelSafeTool } from '../../server/runner/parallel-tool-policy.js';
import { classifyToolCall, decidePermission } from '../../src/lib/permissions.mjs';

const RETIRED = ['save_memory', 'brain_search', 'brain_read_page', 'brain_list', 'brain_write_page', 'brain_append_log', 'brain_ingest_source'];
const tool = name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } });

describe('memory tool wiring', () => {
  test('the catalog defines the four memory tools and none of the retired wiki tools', () => {
    const ids = BUILT_IN_TOOLS.map(row => row.id);
    for (const id of MEMORY_TOOL_IDS) assert.ok(ids.includes(id), id);
    for (const id of RETIRED) {
      assert.ok(!ids.includes(id), id);
      assert.ok(!ALL_TOOL_IDS.includes(id), id);
    }
    assert.ok(ids.includes('manage_brain'));
    const save = BUILT_IN_TOOLS.find(row => row.id === 'memory_save').definition.function;
    assert.deepEqual(save.parameters.required, ['title', 'body', 'kind']);
    assert.deepEqual(save.parameters.properties.scope.enum, ['project', 'user']);
  });

  test('lazy discovery finds the memory family and select: loads exact names', () => {
    const session = createLazyToolSession(MEMORY_TOOL_IDS.map(tool));
    const description = session.tools.find(t => t.function.name === 'search_tools').function.description;
    assert.match(description, /memory: memory_search, memory_read, memory_save, memory_forget/);
    const loaded = JSON.parse(session.search({ query: `select:${MEMORY_TOOL_IDS.join(',')}` })).loaded;
    assert.deepEqual(loaded, MEMORY_TOOL_IDS);
  });

  test('board attempts and headless runs: reads everywhere, writes never on boards', () => {
    for (const role of [BOARD_VERIFIER_TOOL_IDS, BOARD_BUILDER_TOOL_IDS]) {
      assert.ok(role.includes('memory_search'));
      assert.ok(role.includes('memory_read'));
      assert.ok(!role.includes('memory_save'));
      assert.ok(!role.includes('memory_forget'));
      for (const id of RETIRED) assert.ok(!role.includes(id), id);
    }
    assert.ok(DEFAULT_HEADLESS_TOOL_IDS.includes('memory_save'));
    assert.ok(DEFAULT_HEADLESS_TOOL_IDS.includes('memory_forget'));
    for (const id of RETIRED) assert.ok(!DEFAULT_HEADLESS_TOOL_IDS.includes(id), id);
  });

  test('reads are read-only and parallel-safe; writes are sequential app writes', () => {
    const opts = { workspaceRoots: ['/p'], homeDir: '/h' };
    for (const name of ['memory_search', 'memory_read']) {
      const action = classifyToolCall(name, { query: 'x', id: 'y' }, opts);
      assert.equal(action.mutates, false, name);
      assert.equal(decidePermission('manual', action).decision, 'allow', name);
      assert.equal(decidePermission('auto', action, { clamp: 'read-only' }).decision, 'allow', name);
      assert.equal(isParallelSafeTool(name), true, name);
    }
    for (const name of ['memory_save', 'memory_forget']) {
      const action = classifyToolCall(name, { title: 't' }, opts);
      assert.equal(action.kind, 'app', name);
      assert.equal(action.mutates, true, name);
      assert.equal(decidePermission('auto', action, { clamp: 'plans' }).decision, 'deny', name);
      assert.equal(isParallelSafeTool(name), false, name);
    }
  });
});
