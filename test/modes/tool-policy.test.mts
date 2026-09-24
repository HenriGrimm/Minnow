/**
 * Mode tool policy filter tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MODE_IDS, type ModeId } from '../../src/chat/modes/types.ts';
import { filterToolsByMode, isToolAllowedForMode } from '../../src/chat/modes/tool-policy.ts';
import {
  MODE_ALLOWED_GROUPS,
  TOOL_GROUP_IDS,
  TOOL_GROUP_ID_LIST,
  buildToolIdToGroupsMap,
  expandToolGroups,
} from '../../src/chat/modes/tool-groups.ts';
import { BUILT_IN_TOOLS } from '../../src/tools/definitions.ts';

function findTool(id: string) {
  const tool = BUILT_IN_TOOLS.find((t) => t.id === id);
  assert.ok(tool, `missing tool ${id}`);
  return tool;
}

function filteredIds(modeId: ModeId): Set<string> {
  return new Set(filterToolsByMode(BUILT_IN_TOOLS, modeId).map((t) => t.id));
}

/** Persisted `desktop` / `email` remap to general's matrix; other ids have their own row. */
function groupsForMode(modeId: ModeId) {
  return MODE_ALLOWED_GROUPS[modeId === 'desktop' || modeId === 'email' ? 'general' : modeId];
}

function estimateToolPayloadTokens(defs: { definition: { function: { name: string; description: string; parameters: unknown } } }[]): number {
  const json = JSON.stringify(defs.map((t) => t.definition));
  return Math.round(json.length / 4);
}

/** Whether every tool in `groupId` is allowed for `modeId`. */
function groupFullyAllowed(modeId: ModeId, groupId: keyof typeof TOOL_GROUP_IDS): boolean {
  return TOOL_GROUP_IDS[groupId].every((id) => isToolAllowedForMode(modeId, id));
}

/** Whether every tool in `groupId` is denied for `modeId`. */
function groupFullyDenied(modeId: ModeId, groupId: keyof typeof TOOL_GROUP_IDS): boolean {
  return TOOL_GROUP_IDS[groupId].every((id) => !isToolAllowedForMode(modeId, id));
}

describe('external dynamic tools (MCP / plugins)', () => {
  test('mcp__ and plugin__ tools bypass per-mode deny-by-default matrix', () => {
    const mcpTool = 'mcp__context7__resolve_library_id';
    const pluginTool = 'plugin__my-plugin__run';
    for (const modeId of MODE_IDS) {
      assert.ok(
        isToolAllowedForMode(modeId, mcpTool),
        `${mcpTool} should be allowed in ${modeId}`,
      );
      assert.ok(
        isToolAllowedForMode(modeId, pluginTool),
        `${pluginTool} should be allowed in ${modeId}`,
      );
    }
  });
});

describe('filterToolsByMode', () => {
  test('plan includes execute_command per final matrix (MIN-332)', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'plan');
    assert.ok(filtered.some((t) => t.id === 'execute_command'));
  });

  test('super-plan excludes execute_command but allows spawn_sub_agent', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'super-plan');
    assert.ok(!filtered.some((t) => t.id === 'execute_command'));
    assert.ok(filtered.some((t) => t.id === 'spawn_sub_agent'));
    assert.ok(filtered.some((t) => t.id === 'get_sub_agent_status'));
  });

  test('plan includes save_file and make_directory for plan document writes', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'plan');
    assert.ok(filtered.some((t) => t.id === 'save_file'));
    assert.ok(filtered.some((t) => t.id === 'make_directory'));
  });

  test('plan includes the edit tools so plans can be revised in place', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'plan');
    for (const id of ['append_file', 'insert_at_line', 'replace_text_in_file']) {
      assert.ok(filtered.some((t) => t.id === id), `plan should allow ${id}`);
    }
  });

  test('plan excludes mutating file-write tools', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'plan');
    for (const id of ['delete_path', 'move_file', 'copy_file']) {
      assert.ok(!filtered.some((t) => t.id === id), `plan should deny ${id}`);
    }
  });

  test('build includes execute_command when in catalog list', () => {
    const filtered = filterToolsByMode([findTool('execute_command')], 'build');
    assert.equal(filtered.length, 1);
  });

  test('general includes execute_command and save_file like build', () => {
    const filtered = filterToolsByMode(BUILT_IN_TOOLS, 'general');
    assert.ok(filtered.some((t) => t.id === 'execute_command'));
    assert.ok(filtered.some((t) => t.id === 'save_file'));
    assert.ok(filtered.some((t) => t.id === 'spawn_sub_agent'));
  });

  test('desktop mode id resolves to general tool policy', () => {
    const desktopFiltered = filterToolsByMode(BUILT_IN_TOOLS, 'desktop');
    const generalFiltered = filterToolsByMode(BUILT_IN_TOOLS, 'general');
    assert.deepEqual(
      new Set(desktopFiltered.map((t) => t.id)),
      new Set(generalFiltered.map((t) => t.id)),
    );
  });

  test('email mode id resolves to general tool policy', () => {
    const emailFiltered = filterToolsByMode(BUILT_IN_TOOLS, 'email');
    const generalFiltered = filterToolsByMode(BUILT_IN_TOOLS, 'general');
    assert.deepEqual(
      new Set(emailFiltered.map((t) => t.id)),
      new Set(generalFiltered.map((t) => t.id)),
    );
  });
});

describe('per-mode matrix groups', () => {
  for (const modeId of MODE_IDS) {
    test(`${modeId} matches MODE_ALLOWED_GROUPS matrix`, () => {
      const allowedGroups = new Set(groupsForMode(modeId));
      for (const groupId of TOOL_GROUP_ID_LIST) {
        const shouldAllow = allowedGroups.has(groupId);
        if (groupId === 'files-write' && (modeId === 'plan' || modeId === 'super-plan')) {
          // Plan / Super Plan: partial files-write — plan-doc writes and edits,
          // scoped to documentation/plans/**.md by plan-write-guard.
          assert.ok(isToolAllowedForMode(modeId, 'save_file'));
          assert.ok(isToolAllowedForMode(modeId, 'make_directory'));
          assert.ok(isToolAllowedForMode(modeId, 'append_file'));
          assert.ok(isToolAllowedForMode(modeId, 'replace_text_in_file'));
          assert.ok(!isToolAllowedForMode(modeId, 'delete_path'));
          continue;
        }
        if (groupId === 'sub-agents' && modeId === 'orchestrate') {
          assert.ok(!isToolAllowedForMode(modeId, 'spawn_sub_agent'));
          assert.ok(!isToolAllowedForMode(modeId, 'cancel_sub_agent'));
          assert.ok(isToolAllowedForMode(modeId, 'list_sub_agents'));
          assert.ok(isToolAllowedForMode(modeId, 'get_sub_agent_status'));
          continue;
        }
        if (shouldAllow) {
          assert.ok(
            groupFullyAllowed(modeId, groupId),
            `${modeId} should allow full group ${groupId}`,
          );
        } else {
          assert.ok(
            groupFullyDenied(modeId, groupId),
            `${modeId} should deny full group ${groupId}`,
          );
        }
      }
    });
  }
});

describe('cross-mode policy invariants', () => {
  const BRAIN_TOOLS = [
    ...TOOL_GROUP_IDS['brain-core'],
    ...TOOL_GROUP_IDS['brain-admin'],
  ];
  const APPEARANCE_TOOLS = TOOL_GROUP_IDS.appearance;

  test('issue tools allowed in general, build, plan, super-plan, and debug', () => {
    const ISSUE_MODES = new Set<ModeId>([
      'general',
      'build',
      'plan',
      'super-plan',
      'debug',
      'desktop',
      'email',
    ]);
    for (const modeId of MODE_IDS) {
      for (const toolId of TOOL_GROUP_IDS.issues) {
        const allowed = isToolAllowedForMode(modeId, toolId);
        const expected = ISSUE_MODES.has(modeId);
        assert.equal(
          allowed,
          expected,
          `${toolId} in ${modeId}: expected ${expected}`,
        );
      }
    }
  });

  test('brain tools allowed in every mode', () => {
    for (const modeId of MODE_IDS) {
      for (const toolId of BRAIN_TOOLS) {
        assert.ok(
          isToolAllowedForMode(modeId, toolId),
          `${toolId} should be allowed in ${modeId}`,
        );
      }
    }
  });

  test('removed mail tools are not in the catalog', () => {
    const ids = new Set(BUILT_IN_TOOLS.map((t) => t.id));
    for (const toolId of [
      'list_mail',
      'search_mail',
      'get_thread',
      'draft_reply',
      'summarize_inbox',
      'generate_reply_variants',
      'email_action',
    ]) {
      assert.equal(ids.has(toolId), false, `${toolId} should be gone`);
    }
  });

  test('appearance tools denied in every mode (desktop id aliases general)', () => {
    for (const modeId of MODE_IDS) {
      for (const toolId of APPEARANCE_TOOLS) {
        const allowed = isToolAllowedForMode(modeId, toolId);
        assert.equal(allowed, false, `${toolId} in ${modeId}: expected false`);
      }
    }
  });

  test('deleted V1 board tools are not in the catalog (MIN-715)', () => {
    const ids = new Set(BUILT_IN_TOOLS.map((t) => t.id));
    for (const toolId of [
      'board_init',
      'board_add_tasks',
      'board_update_task',
      'board_set_autonomy',
      'board_get_state',
      'board_report',
      'delegate_tasks',
    ]) {
      assert.equal(ids.has(toolId), false, `${toolId} should be gone`);
    }
  });
});

describe('tool payload token reduction', () => {
  test('build mode tool JSON payload stays below ~10,000 tokens', () => {
    const allDefs = BUILT_IN_TOOLS.map((t) => t.definition);
    const allTokens = estimateToolPayloadTokens(
      allDefs.map((definition) => ({ definition })),
    );
    const buildDefs = filterToolsByMode(BUILT_IN_TOOLS, 'build').map((t) => t.definition);
    const buildTokens = estimateToolPayloadTokens(
      buildDefs.map((definition) => ({ definition })),
    );

    assert.ok(allTokens > 9_000, `baseline should exceed 9k, got ${allTokens}`);
    // Ceiling covers issue v2 tools in the issues group (~900 tok) plus shell-run clarifiers
    // and recent tool-definition growth (observed ~11577 after Email/Calendar removal,
    // ~12.8k on 2026-09-17 after the agent-browser, issue and impeccable tools landed).
    // lazyTools (default on) keeps most of these schemas off the wire until first use.
    assert.ok(
      buildTokens >= 7_000 && buildTokens <= 13_500,
      `build payload expected ~7k-13.5k tok, got ${buildTokens} (all=${allTokens})`,
    );
    // Gated Email/Calendar tools used to inflate the unfiltered catalog; remaining
    // savings is appearance + a few other denied groups (~1.3k tok).
    assert.ok(buildTokens < allTokens - 1_000, `build should save at least 1k tokens (all=${allTokens} build=${buildTokens})`);
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

  test('group expansion covers all allowed tools for each mode', () => {
    for (const modeId of MODE_IDS) {
      const fromGroups = new Set(expandToolGroups(groupsForMode(modeId)));
      const fromPolicy = filteredIds(modeId);
      for (const id of fromPolicy) {
        assert.ok(
          fromGroups.has(id) || modeId === 'plan' || modeId === 'super-plan',
          `${modeId}: ${id} not in groups`,
        );
      }
    }
  });
});
