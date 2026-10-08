import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { defaultToolConfig } from '../../src/config/defaults.ts';
import { normalizeToolConfig } from '../../src/tools/config.ts';
import { allowGroupsToolPolicy, MODE_ALLOWED_GROUPS } from '../../src/chat/modes/tool-groups.ts';
import { getToolById } from '../../src/tools/definitions.ts';
import { resolveSubAgentTools } from '../../src/agents/sub-agent-tools.ts';
import type { SubAgentTypeConfig } from '../../src/agents/types.ts';
import subAgents from '../../src/agents/defaults/sub-agents.json' with { type: 'json' };

test('client defaults and backfill make Load skill callable without replacing saved permissions', () => {
  assert.equal(defaultToolConfig().permissions.default.load_skill, 'full');
  assert.equal(normalizeToolConfig({ enabled: { read_file: true } }).permissions.default.load_skill, 'full');
  assert.equal(normalizeToolConfig({ enabled: { load_skill: false } }).permissions.default.load_skill, 'off');
  for (const permission of ['off', 'ask', 'full']) {
    assert.equal(normalizeToolConfig({ permissions: { default: { load_skill: permission } } }).permissions.default.load_skill, permission);
  }
});

test('composer modes and every shipped sub-agent type allow skill reads through their existing policies', () => {
  for (const mode of ['general', 'build', 'plan', 'debug'] as const) {
    assert.equal(allowGroupsToolPolicy(mode, MODE_ALLOWED_GROUPS[mode]).tools.load_skill, 'allow');
  }
  const definition = getToolById('load_skill')!.definition;
  for (const [id, type] of Object.entries(subAgents.types)) {
    const tools = resolveSubAgentTools(type as unknown as SubAgentTypeConfig, id, [definition]);
    assert.equal(tools[0]?.function.name, 'load_skill', id);
  }
});

test('restricted work-agent prompts and model guidance expose skill loading', async () => {
  for (const id of ['planner', 'reviewer', 'researcher', 'ui-designer']) {
    const prompt = await readFile(new URL(`../../src/chat/prompts/work-agents/${id}/agent.full.md`, import.meta.url), 'utf8');
    assert.match(prompt, /allowedTools:\r?\n  - load_skill/);
  }
  for (const profile of ['full', 'lite']) {
    const prompt = await readFile(new URL(`../../src/chat/prompts/tool-usage/default.${profile}.md`, import.meta.url), 'utf8');
    assert.match(prompt, /load_skill/);
    assert.match(prompt, /mode restrictions, or tool permissions/);
    const general = await readFile(new URL(`../../src/chat/prompts/modes/general.${profile}.md`, import.meta.url), 'utf8');
    assert.match(general, /load_skill/);
    assert.doesNotMatch(general, /Use.*skills only when/);
  }
});
