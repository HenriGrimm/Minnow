/**
 * Planner work agent tool allowlist — Context7 for library verification in Plan mode.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { parseWorkAgentMetaFromMarkdown } from '../../src/agents/work-agent-meta-parse.ts';
import { defaultToolConfig } from '../../src/config/defaults.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const plannerPath = join(
  __dirname,
  '../../src/chat/prompts/work-agents/planner/agent.full.md',
);

const CONTEXT7_TOOL_IDS = [
  'mcp__context7__resolve_library_id',
  'mcp__context7__query_docs',
];

const ISSUE_TOOL_IDS = [
  'issue_add',
  'issue_update',
  'issue_link',
  'issue_get_state',
  'issue_delete',
  'issue_search',
  'issue_comment',
  'issue_assign',
  'issue_unlink',
  'issue_move',
];

describe('planner work agent allowedTools', () => {
  test('includes Context7 MCP tools for library/API verification', async () => {
    const raw = await readFile(plannerPath, 'utf8');
    const meta = parseWorkAgentMetaFromMarkdown(raw, plannerPath);
    assert.ok(meta);
    assert.ok(Array.isArray(meta.allowedTools));

    for (const toolId of CONTEXT7_TOOL_IDS) {
      assert.ok(
        meta.allowedTools.includes(toolId),
        `planner allowedTools should include ${toolId}`,
      );
    }
  });

  test('includes issue_* tools so Plan mode can file and attach plans', async () => {
    const raw = await readFile(plannerPath, 'utf8');
    const meta = parseWorkAgentMetaFromMarkdown(raw, plannerPath);
    assert.ok(meta);
    assert.ok(Array.isArray(meta.allowedTools));

    for (const toolId of ISSUE_TOOL_IDS) {
      assert.ok(
        meta.allowedTools.includes(toolId),
        `planner allowedTools should include ${toolId}`,
      );
    }
  });

  test('includes web research and targeted plan edits', async () => {
    const raw = await readFile(plannerPath, 'utf8');
    const meta = parseWorkAgentMetaFromMarkdown(raw, plannerPath);
    assert.ok(meta?.allowedTools);
    for (const toolId of [
      'web_search', 'fetch_web_content', 'rag_web_content',
      'save_file', 'append_file', 'insert_at_line', 'replace_text_in_file',
    ]) {
      assert.ok(meta.allowedTools.includes(toolId), `planner allowedTools should include ${toolId}`);
    }
  });

  test('fresh tool settings expose plan writes and web research with approval', () => {
    const config = defaultToolConfig();
    for (const toolId of [
      'web_search', 'fetch_web_content', 'rag_web_content',
      'save_file', 'append_file', 'insert_at_line', 'replace_text_in_file', 'make_directory',
    ]) {
      assert.equal(config.enabled[toolId], true, `${toolId} should be enabled`);
      assert.equal(config.permissions.default[toolId], 'ask', `${toolId} should require approval`);
    }
  });
});
