import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  agentsFromPackManifest,
  mergePackAgentsIntoMap,
  packWorkAgentId,
} from '../../src/agents/pack-loader.ts';
import type { AgentPackManifest } from '../../src/agents/pack-types.ts';
import { mergeWorkAgentDefinition } from '../../src/agents/work-agent-registry.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = join(
  root,
  'test/fixtures/agent-packs/minimal-pack/manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AgentPackManifest;

describe('pack-loader', () => {
  test('expands manifest to namespaced agent ids', () => {
    const builtinIds = new Set(['builder', 'default']);
    const { agents, errors } = agentsFromPackManifest(
      manifest,
      '/tmp/minimal',
      builtinIds,
    );
    assert.equal(errors.length, 0);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, packWorkAgentId('minimal', 'helper'));
    assert.equal(agents[0].label, 'Minimal helper');
    assert.equal(agents[0].source, 'pack');
    assert.equal(agents[0].packId, 'minimal');
    assert.deepEqual(agents[0].allowedTools, [
      'read_file',
      'find_files',
      'list_directory',
    ]);
  });

  test('rejects collision with built-in id', () => {
    const builtinIds = new Set(['minimal.helper']);
    const badManifest: AgentPackManifest = {
      ...manifest,
      agents: [{ ...manifest.agents[0], key: 'helper' }],
    };
    const { agents, errors } = agentsFromPackManifest(
      badManifest,
      '/tmp/minimal',
      builtinIds,
    );
    assert.equal(agents.length, 0);
    assert.ok(errors.some((e) => e.includes('collides')));
  });

  test('legacy pack and user model configuration is ignored', () => {
    const builtinIds = new Set<string>();
    const { agents } = agentsFromPackManifest(manifest, '/tmp/minimal', builtinIds);
    const base = agents[0];
    const merged = mergeWorkAgentDefinition(base, { modelId: 'user-model' });
    assert.equal(merged.modelId, null);
  });

  test('mergePackAgentsIntoMap appends without replacing builtins', () => {
    const builtins = new Map([
      [
        'default',
        {
          id: 'default',
          label: 'Default',
          description: '',
          kind: 'work-agent' as const,
          version: '1',
          providerId: null,
          modelId: null,
          allowedTools: null,
        },
      ],
    ]);
    const { agents } = agentsFromPackManifest(manifest, '/tmp/minimal', new Set());
    const merged = mergePackAgentsIntoMap(builtins, agents);
    assert.equal(merged.size, 2);
    assert.ok(merged.has('default'));
    assert.ok(merged.has('minimal.helper'));
  });
});
