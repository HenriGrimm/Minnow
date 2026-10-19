import assert from 'node:assert/strict';
import { after, beforeEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { computeEffectiveWorkAgentBinding } from '../../src/settings/model-routing-effective.ts';
import { resolveSubAgentModelBinding } from '../../src/agents/resolve-sub-agent-binding.ts';
import { resetFallbackChainsConfigCache } from '../../src/config/fallback-chains-meta.ts';

let kind = 'work-agent';
let binding: { providerId: string | null; modelId: string | null };
let writes: unknown[];
let fail = false;
let status: string;
const parent = { providerId: 'chat-host', modelId: 'chat-model' };
const advanced = { sampler: { temperature: 0.3 }, thinkingMode: 'off', maxConcurrent: 2 };

mock.module('../../src/models/model-choices.ts', { namedExports: { loadModelChoices: async () => [] } });
mock.module('../../src/agents/work-agent-prompt-api.ts', {
  namedExports: {
    patchWorkAgentOverride: async (_id: string, patch: typeof binding) => {
      writes.push(patch);
      if (fail) return null;
      binding = patch;
      return { id: 'builder', ...patch };
    },
  },
});
mock.module('../../src/agents/sub-agent-config.ts', {
  namedExports: {
    loadSubAgentConfig: async () => ({ types: { builder: { ...binding, ...advanced } } }),
    setRuntimeSubAgentOverrides: () => {},
    patchSubAgentUserOverrides: async (patch: any) => {
      writes.push(patch);
      if (fail) return false;
      binding = { ...binding, ...patch.types.builder };
      return true;
    },
  },
});
mock.module('../../src/settings/model-routing-catalog.ts', {
  namedExports: {
    loadModelRoutingCatalog: async () => ({ activeChat: { id: 'chat', ...parent }, rows: [{
      id: 'builder', label: 'Builder', persistKind: kind,
      group: kind === 'goal-eval' ? 'background' : 'work-agents',
      providerId: binding.providerId ?? '', modelId: binding.modelId ?? '',
      usesChatDefault: !binding.modelId,
      effectiveProviderId: binding.providerId || parent.providerId,
      effectiveModelId: binding.modelId || parent.modelId,
    }] }),
  },
});
mock.module('../../src/state/sessions.ts', {
  namedExports: { getActiveChat: () => parent, scheduleSaveSessions: () => {}, touchChat: () => {} },
});
mock.module('../../src/providers/store.ts', {
  namedExports: { listProviders: async () => ({ providers: [{ id: 'chat-host' }] }) },
});
mock.module('../../src/api/models.ts', {
  namedExports: { populateMultiProviderModelSelect: async (select: HTMLSelectElement) => {
    const option = document.createElement('option');
    option.value = 'pinned-host\u001fpinned-model';
    option.text = 'Pinned model';
    select.appendChild(option);
  } },
});
mock.module('../../src/config/goal-eval-meta.ts', {
  namedExports: { resetGoalEvalConfigCache: () => {}, saveGoalEvalConfig: async (patch: typeof binding) => {
    writes.push(patch);
    binding = patch;
  } },
});
mock.module('../../src/ui/settings-model-binding.ts', {
  namedExports: {
    appendProviderModelFields: (host: HTMLElement, ids: any) => {
      const providerSelect = document.createElement('select');
      const modelSelect = document.createElement('select');
      providerSelect.id = ids.provider;
      modelSelect.id = ids.model;
      host.append(providerSelect, modelSelect);
      return { providerSelect, modelSelect };
    },
    fillProviderSelect: async (select: HTMLSelectElement, value: string) => {
      select.innerHTML = '<option value=""></option><option value="pinned-host">Pinned host</option>';
      select.value = value;
    },
    fillModelSelect: async (select: HTMLSelectElement, _provider: string, value: string) => {
      select.innerHTML = '<option value=""></option><option value="pinned-model">Pinned model</option>';
      select.value = value;
    },
  },
});
mock.module('../../src/ui/model-select-picker.ts', {
  namedExports: { unmountAuxiliaryModelSelectCombobox: () => {}, mountAuxiliaryModelSelectCombobox: () => {}, syncAuxiliaryModelSelectCombobox: () => {} },
});
mock.module('../../src/ui/status.ts', {
  namedExports: { setStatus: (_level: string, message: string) => { status = message; } },
});

describe('agent routing reset', () => {
  const originalFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = originalFetch;
    setStorageModeForTests(null);
  });

  beforeEach(() => {
    const window = new Window();
    globalThis.window = window as any;
    globalThis.document = window.document as any;
    globalThis.localStorage = window.localStorage;
    binding = { providerId: 'pinned-host', modelId: 'pinned-model' };
    writes = [];
    fail = false;
    status = '';
    resetFallbackChainsConfigCache();
    setStorageModeForTests('server');
    globalThis.fetch = async () => new Response(JSON.stringify({ fallbackChains: {
      enabled: false, cooldownSeconds: 60, maxChainLength: 3, roles: {},
    } }), { status: 200 });
  });

  async function mountAndReset() {
    const { mountStandaloneRoutingEditor } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    assert.equal(await mountStandaloneRoutingEditor(host, 'builder'), true);
    const button = host.querySelector<HTMLButtonElement>('.settings-routing-reset')!;
    assert.equal(button.textContent, 'Use sub-agent routing');
    button.click();
    for (let i = 0; i < 30 && button.disabled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(button.disabled, false, 'reset settles');
    return host;
  }

  test('fallback order controls persist the displayed order and honor the chain limit', async () => {
    kind = 'goal-eval';
    const apiWrites: any[] = [];
    globalThis.fetch = async (_url, options) => {
      if (options?.method === 'PUT') apiWrites.push(JSON.parse(options.body as string));
      return new Response(JSON.stringify({ fallbackChains: {
        enabled: true, cooldownSeconds: 60, maxChainLength: 2,
        roles: { _global: [
          { providerId: 'host-a', modelId: 'model-a' },
          { providerId: 'host-b', modelId: 'model-b' },
        ] },
      } }), { status: 200 });
    };
    const { renderModelRoutingSection } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    await renderModelRoutingSection(host);
    host.querySelector<HTMLButtonElement>('#routing-tab-fallbacks')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const global = host.querySelector<HTMLElement>('.settings-fallback-global-chain')!;
    assert.equal(global.querySelector<HTMLButtonElement>('[aria-label="Move up fallback 1"]')?.disabled, true);
    assert.equal(global.querySelector<HTMLButtonElement>(':scope > button')?.disabled, true, 'cannot add beyond the limit');
    global.querySelector<HTMLButtonElement>('[aria-label="Move down fallback 1"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(apiWrites.at(-1).fallbackChains.roles._global, [
      { providerId: 'host-b', modelId: 'model-b' },
      { providerId: 'host-a', modelId: 'model-a' },
    ]);
    host.querySelector<HTMLButtonElement>('#routing-tab-tasks')!.click();
  });

  for (const agentKind of ['sub-agent']) {
    test(`${agentKind} clears both overrides and displays inherited routing`, async () => {
      kind = agentKind;
      const host = await mountAndReset();
      assert.equal(writes.length, 1, 'only binding configuration is saved');
      if (kind === 'work-agent') {
        assert.deepEqual(writes[0], { providerId: null, modelId: null });
        const agent = { id: 'builder', ...binding } as any;
        assert.equal(computeEffectiveWorkAgentBinding(agent, parent, parent).modelId, 'chat-model');
        assert.equal(computeEffectiveWorkAgentBinding(agent, { providerId: '', modelId: '' }, parent).providerId, 'chat-host');
      } else {
        assert.deepEqual(writes[0], { types: { builder: { providerId: '', modelId: '' } } });
        assert.deepEqual(resolveSubAgentModelBinding(binding as any, parent as any), parent);
        assert.deepEqual(resolveSubAgentModelBinding(binding as any, undefined, parent), parent);
      }
      assert.equal(host.querySelector('.settings-routing-effective__value')?.textContent, 'chat-model · chat-host');
      assert.equal(host.querySelector<HTMLSelectElement>('[id$="-provider"]')?.value, '');
      assert.equal(host.querySelector<HTMLSelectElement>('[id$="-model"]')?.value, '');
      assert.equal(document.activeElement, host.querySelector('.settings-routing-reset'));
    });

    test(`${agentKind} retains the pinned binding when saving fails`, async () => {
      kind = agentKind;
      fail = true;
      const host = await mountAndReset();
      assert.equal(binding.modelId, 'pinned-model');
      assert.equal(host.querySelector<HTMLSelectElement>('[id$="-provider"]')?.value, 'pinned-host');
      assert.equal(host.querySelector<HTMLSelectElement>('[id$="-model"]')?.value, 'pinned-model');
      assert.match(status, /Could not reset/);
    });
  }
});
