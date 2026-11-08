/**
 * Tool policy after the single-agent redesign: modes no longer gate tools.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MODE_IDS } from '../../src/chat/modes/types.ts';
import { filterToolsByMode, isToolAllowedForMode } from '../../src/chat/modes/tool-policy.ts';
import { buildToolIdToGroupsMap } from '../../src/chat/modes/tool-groups.ts';
import { BUILT_IN_TOOLS } from '../../src/tools/definitions.ts';
import { createLazyToolSession } from '../../server/runner/lazy-tools.js';

function estimateToolPayloadTokens(defs: { definition: { function: { name: string; description: string; parameters: unknown } } }[]): number {
  const json = JSON.stringify(defs.map((t) => t.definition));
  return Math.round(json.length / 4);
}

describe('single agent: no mode gating', () => {
  test('every mode id sees the whole catalog, including MCP and plugin tools', () => {
    for (const modeId of MODE_IDS) {
      assert.equal(filterToolsByMode(BUILT_IN_TOOLS, modeId).length, BUILT_IN_TOOLS.length);
      assert.ok(isToolAllowedForMode(modeId, 'mcp__context7__resolve_library_id'));
      assert.ok(isToolAllowedForMode(modeId, 'plugin__my-plugin__run'));
      assert.ok(isToolAllowedForMode(modeId, 'execute_command'));
    }
  });

  test('the board plan checker and issue tools stay discoverable from the lazy session', () => {
    const session = createLazyToolSession(BUILT_IN_TOOLS.map((tool) => tool.definition));
    assert.ok(session.isLoaded('check_plan'));
    assert.equal(session.isLoaded('issue_add'), false);
    const search = session.tools.find((tool) => tool.function.name === 'search_tools');
    assert.match(search?.function.description ?? '', /issues \(project tracker\)/);
  });
});

describe('catalog invariants', () => {
  test('removed mail tools are not in the catalog', () => {
    const ids = new Set(BUILT_IN_TOOLS.map((t) => t.id));
    for (const toolId of ['list_mail', 'search_mail', 'get_thread', 'draft_reply', 'summarize_inbox', 'generate_reply_variants', 'email_action']) {
      assert.equal(ids.has(toolId), false, `${toolId} should be gone`);
    }
  });

  test('deleted V1 board tools are not in the catalog (MIN-715)', () => {
    const ids = new Set(BUILT_IN_TOOLS.map((t) => t.id));
    for (const toolId of ['board_init', 'board_add_tasks', 'board_update_task', 'board_set_autonomy', 'board_get_state', 'board_report', 'delegate_tasks']) {
      assert.equal(ids.has(toolId), false, `${toolId} should be gone`);
    }
  });
});

describe('tool payload token reduction', () => {
  test('the full catalog and the default lazy first request stay within their budgets', () => {
    const allDefs = BUILT_IN_TOOLS.map((t) => t.definition);
    const allTokens = estimateToolPayloadTokens(allDefs.map((definition) => ({ definition })));
    const lazyTokens = estimateToolPayloadTokens(
      createLazyToolSession(allDefs).tools.map((definition) => ({ definition })),
    );
    assert.ok(allTokens > 9_000, `baseline should exceed 9k, got ${allTokens}`);
    assert.ok(allTokens <= 20_000, `full catalog expected <=20k tok, got ${allTokens}`);
    // lazyTools is on by default: the lean core plus search_tools (with its
    // capability index) is the payload every turn pays.
    assert.ok(lazyTokens <= 5_000, `default lazy payload expected <=5k tok, got ${lazyTokens}`);
    assert.ok(lazyTokens < allTokens / 2, `lazy should at least halve the payload (all=${allTokens} lazy=${lazyTokens})`);
  });

  test('every built-in tool belongs to at least one group', () => {
    const toolToGroups = buildToolIdToGroupsMap();
    for (const tool of BUILT_IN_TOOLS) {
      assert.ok(
        toolToGroups.has(tool.id),
        `built-in ${tool.id} missing from TOOL_GROUP_IDS`,
      );
    }
  });
});
