/**
 * Sub-agents inherit Brain wiki tools from the parent enabled set.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSubAgentTools } from '../../src/agents/sub-agent-tools.ts';
import type { SubAgentTypeConfig } from '../../src/agents/types.ts';

function toolDef(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  };
}

const parentWithBrain = [
  toolDef('read_file'),
  toolDef('brain_search'),
  toolDef('brain_read_page'),
  toolDef('brain_write_page'),
  toolDef('save_memory'),
  toolDef('list_sub_agents'),
];

describe('resolveSubAgentTools brain inheritance', () => {
  test('passes brain tools through when not denied', () => {
    const cfg: SubAgentTypeConfig = {
      enabled: true,
      providerId: 'lm-studio-local',
      modelId: '',
      maxConcurrent: 1,
      workAgentId: null,
      allowedTools: null,
      deniedTools: ['spawn_sub_agent', 'list_sub_agents'],
      systemPromptPath: null,
    };
    const tools = resolveSubAgentTools(cfg, 'generalPurpose', parentWithBrain);
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('brain_search'));
    assert.ok(names.includes('brain_read_page'));
    assert.ok(names.includes('brain_write_page'));
    assert.ok(names.includes('save_memory'));
    assert.ok(!names.includes('list_sub_agents'));
  });
});
