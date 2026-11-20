/**
 * Sub-agents inherit read-only memory tools from the parent; saving and
 * forgetting stay with the parent, which decides what is worth remembering.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveSubAgentTools } from '../../src/agents/sub-agent-tools.ts';
import { appendSubAgentMemorySection } from '../../src/agents/sub-agent-prompt.ts';
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

const parentWithMemory = [
  toolDef('read_file'),
  toolDef('memory_search'),
  toolDef('memory_read'),
  toolDef('memory_save'),
  toolDef('memory_forget'),
  toolDef('list_sub_agents'),
];

const cfg = (overrides: Partial<SubAgentTypeConfig> = {}): SubAgentTypeConfig => ({
  enabled: true,
  providerId: 'lm-studio-local',
  modelId: '',
  maxConcurrent: 1,
  workAgentId: null,
  allowedTools: null,
  deniedTools: ['spawn_sub_agent', 'list_sub_agents'],
  systemPromptPath: null,
  ...overrides,
});

describe('resolveSubAgentTools memory inheritance', () => {
  test('passes memory reads through and drops memory writes', () => {
    const names = resolveSubAgentTools(cfg(), 'generalPurpose', parentWithMemory).map((t) => t.function.name);
    assert.ok(names.includes('memory_search'));
    assert.ok(names.includes('memory_read'));
    assert.ok(!names.includes('memory_save'));
    assert.ok(!names.includes('memory_forget'));
    assert.ok(!names.includes('list_sub_agents'));
  });

  test('an allow list cannot grant memory writes to a sub-agent', () => {
    const names = resolveSubAgentTools(cfg({ allowedTools: ['memory_save', 'memory_search'] }), 'orchestrator', parentWithMemory)
      .map((t) => t.function.name);
    assert.deepEqual(names, ['memory_search']);
  });
});

describe('appendSubAgentMemorySection', () => {
  test('adds read-only guidance once when memory_search is available, and injects nothing', async () => {
    const out = await appendSubAgentMemorySection('Base prompt', 'Investigate the gitbox sync', ['memory_search', 'memory_read']);
    assert.match(out, /memory_search/);
    assert.match(out, /can't save or forget memories/);
    assert.doesNotMatch(out, /Retrieved memory|Investigate the gitbox sync/);
    assert.equal(await appendSubAgentMemorySection(out, 'x', ['memory_search']), out);
  });

  test('adds nothing without memory tools', async () => {
    assert.equal(await appendSubAgentMemorySection('Base prompt', 'task', ['read_file']), 'Base prompt');
  });
});
