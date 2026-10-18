/**
 * Model routing catalog effective binding (Feature 02).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { WorkAgentDefinition } from '../../src/agents/work-agent-types.ts';
import {
  computeEffectiveTitleBinding,
  computeEffectiveWorkAgentBinding,
  resolveSubAgentModelBinding,
  resolveUiDesignerModel,
} from '../../src/settings/model-routing-effective.ts';

const CHAT = { providerId: 'chat-provider', modelId: 'chat-model' };
const DEFAULTS = { providerId: 'global-provider', modelId: 'global-model' };

describe('computeEffectiveWorkAgentBinding', () => {
  test('empty agent model uses chat model', () => {
    const agent: WorkAgentDefinition = {
      id: 'builder',
      label: 'Builder',
      description: '',
      kind: 'work-agent',
      version: '1',
      providerId: null,
      modelId: null,
      allowedTools: null,
    };
    const out = computeEffectiveWorkAgentBinding(agent, CHAT, DEFAULTS);
    assert.equal(out.modelId, 'chat-model');
    assert.equal(out.providerId, 'chat-provider');
    assert.equal(out.usesChatDefault, true);
  });

  test('legacy agent override cannot replace chat', () => {
    const agent: WorkAgentDefinition = {
      id: 'builder',
      label: 'Builder',
      description: '',
      kind: 'work-agent',
      version: '1',
      providerId: 'agent-prov',
      modelId: 'agent-model',
      allowedTools: null,
    };
    const out = computeEffectiveWorkAgentBinding(agent, CHAT, DEFAULTS);
    assert.equal(out.modelId, 'chat-model');
    assert.equal(out.providerId, 'chat-provider');
    assert.equal(out.usesChatDefault, true);
  });
});

describe('resolveSubAgentModelBinding', () => {
  test('empty type model falls back to parent chat', () => {
    const out = resolveSubAgentModelBinding(
      { providerId: 'type-prov', modelId: '' },
      {
        id: 'c1',
        name: 'Test',
        workspacePath: '',
        history: [],
        modelId: 'parent-model',
        providerId: 'parent-prov',
      },
    );
    assert.equal(out.modelId, 'parent-model');
    assert.equal(out.providerId, 'parent-prov');
  });

  test('empty type provider falls back to parent chat', () => {
    const out = resolveSubAgentModelBinding(
      { providerId: '', modelId: '' },
      {
        id: 'c1',
        name: 'Test',
        workspacePath: '',
        history: [],
        modelId: 'parent-model',
        providerId: 'parent-prov',
      },
    );
    assert.equal(out.modelId, 'parent-model');
    assert.equal(out.providerId, 'parent-prov');
  });

  test('empty type provider and model use global defaults when parent missing', () => {
    const out = resolveSubAgentModelBinding(
      { providerId: '', modelId: '' },
      undefined,
      { providerId: 'global-prov', modelId: 'global-model' },
    );
    assert.equal(out.providerId, 'global-prov');
    assert.equal(out.modelId, 'global-model');
  });
});

describe('resolveUiDesignerModel + titles', () => {
  test('dedicated uiDesigner config', () => {
    const out = resolveUiDesignerModel({
      uiDesigner: { providerId: 'p1', modelId: 'm1', fallbackToChatModel: true },
      chatProviderId: CHAT.providerId,
      chatModelId: CHAT.modelId,
    });
    assert.ok(!('error' in out));
    assert.equal(out.providerId, 'p1');
    assert.equal(out.modelId, 'm1');
  });

  test('titles config model overrides chat', () => {
    const out = computeEffectiveTitleBinding(
      { providerId: 'title-prov', modelId: 'title-model' },
      CHAT,
    );
    assert.equal(out.modelId, 'title-model');
    assert.equal(out.providerId, 'title-prov');
    assert.equal(out.usesChatDefault, false);
  });

  test('empty titles model uses chat', () => {
    const out = computeEffectiveTitleBinding({ providerId: '', modelId: '' }, CHAT);
    assert.equal(out.modelId, 'chat-model');
    assert.equal(out.usesChatDefault, true);
  });
});
