import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  getWorkAgent,
  getWorkAgentPromptOverride,
  listWorkAgents,
  mergeWorkAgentDefinition,
  registerWorkAgentFilesFromRaw,
  resetWorkAgentRegistry,
  setUserWorkAgentOverrides,
  setWorkAgentRegistryIndex,
} from '../../src/agents/work-agent-registry.ts';
import { resolveActiveWorkAgent } from '../../src/agents/resolve-work-agent.ts';
import { fixtureRegistryIndex, loadWorkAgentFixtureMap } from './test-helpers.mjs';

describe('work agent registry', () => {
  beforeEach(() => {
    resetWorkAgentRegistry();
    setWorkAgentRegistryIndex(fixtureRegistryIndex());
  });

  test('load registry from fixtures with stable order', async () => {
    const map = await loadWorkAgentFixtureMap();
    registerWorkAgentFilesFromRaw(map);
    const agents = listWorkAgents(true);
    assert.equal(agents.length, 3);
    assert.deepEqual(
      agents.map((a) => a.id),
      ['agent-alpha', 'agent-beta', 'agent-gamma'],
    );
  });

  test('user override disables agent', async () => {
    const map = await loadWorkAgentFixtureMap();
    registerWorkAgentFilesFromRaw(map);
    setUserWorkAgentOverrides({ 'agent-gamma': { disabled: true } });
    const agent = getWorkAgent('agent-gamma');
    assert.ok(agent);
    assert.equal(agent.disabled, true);
    const listed = listWorkAgents(false);
    assert.ok(!listed.some((a) => a.id === 'agent-gamma'));
  });

  test('user promptOverride is exposed', () => {
    setUserWorkAgentOverrides({
      'agent-alpha': { promptOverride: 'OVERRIDE_BODY' },
    });
    assert.equal(getWorkAgentPromptOverride('agent-alpha'), 'OVERRIDE_BODY');
  });

  test('missing agent id returns null', async () => {
    const map = await loadWorkAgentFixtureMap();
    registerWorkAgentFilesFromRaw(map);
    assert.equal(getWorkAgent('missing-agent'), null);
  });

  test('mergeWorkAgentDefinition discards legacy model overrides', () => {
    const base = {
      id: 'agent-beta',
      label: 'Agent Beta',
      description: '',
      kind: 'work-agent',
      version: '1',
      providerId: 'openai',
      modelId: 'gpt-4o',
      allowedTools: null,
    };
    const merged = mergeWorkAgentDefinition(base, { modelId: 'local-model' });
    assert.equal(merged.providerId, null);
    assert.equal(merged.modelId, null);
  });

  test('ordinary chats ignore saved automatic roles and keep explicit pins', async () => {
    const map = await loadWorkAgentFixtureMap();
    registerWorkAgentFilesFromRaw(map);
    const chat = { modeId: 'build', workAgentId: 'agent-alpha', workAgentAuto: true };
    assert.equal(resolveActiveWorkAgent(chat), null);
    assert.equal(resolveActiveWorkAgent({ ...chat, workAgentAuto: false })?.id, 'agent-alpha');
    assert.equal(resolveActiveWorkAgent({ ...chat, boardTaskId: 'task-1' })?.id, 'agent-alpha');
  });
});
