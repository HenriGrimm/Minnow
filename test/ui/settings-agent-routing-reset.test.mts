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
    saveSubAgentConfigToServer: async (patch: any) => {
      writes.push(patch);
      if (fail) return false;
      binding = patch.types.builder;
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
  namedExports: { saveGoalEvalConfig: async (patch: typeof binding) => {
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
  namedExports: { mountAuxiliaryModelSelectCombobox: () => {}, syncAuxiliaryModelSelectCombobox: () => {} },
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
    assert.equal(button.textContent, 'Use current chat model');
    button.click();
    for (let i = 0; i < 30 && button.disabled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(button.disabled, false, 'reset settles');
    return host;
  }

  test('Models Routing clears a pinned role and refreshes its effective model', async () => {
    kind = 'goal-eval';
    const { renderModelRoutingSection } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    await renderModelRoutingSection(host);
    const select = host.querySelector<HTMLSelectElement>('#modelRouting-builder-model')!;
    for (let i = 0; i < 30 && select.value !== 'pinned-host\u001fpinned-model'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(select.value, 'pinned-host\u001fpinned-model');
    assert.equal(select.options[0].dataset.modelSelectReset, 'true');
    select.value = '';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    for (let i = 0; i < 30 && binding.modelId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(binding, { providerId: '', modelId: '' });
    assert.equal(host.querySelector('.settings-routing-effective__value')?.textContent, 'chat-model · chat-host');
    await renderModelRoutingSection(host);
    assert.equal(host.querySelector<HTMLSelectElement>('#modelRouting-builder-model')?.value, '');
  });

  test('routing tabs support keyboard navigation and preserve the task form', async () => {
    kind = 'goal-eval';
    const { renderModelRoutingSection } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    await renderModelRoutingSection(host);
    const tasks = host.querySelector<HTMLButtonElement>('#routing-tab-tasks')!;
    const fallbacks = host.querySelector<HTMLButtonElement>('#routing-tab-fallbacks')!;
    const select = host.querySelector('#modelRouting-builder-model');
    assert.equal(tasks.getAttribute('aria-selected'), 'true');
    assert.equal(host.querySelector<HTMLElement>('#routing-panel-fallbacks')?.hidden, true);
    assert.equal(host.querySelector('#routing-panel-images')?.childElementCount, 0, 'image settings load only on demand');
    tasks.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(document.activeElement, fallbacks);
    assert.equal(fallbacks.getAttribute('aria-selected'), 'true');
    assert.equal(host.querySelector<HTMLElement>('#routing-panel-tasks')?.hidden, true);
    fallbacks.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(tasks.getAttribute('aria-selected'), 'true');
    assert.equal(host.querySelector('#modelRouting-builder-model'), select, 'switching tabs retains edits and control identity');
    assert.equal(writes.length, 0, 'navigation does not save a binding');
  });

  test('a saved model missing from the live catalog remains selected', async () => {
    kind = 'goal-eval';
    binding = { providerId: 'offline-host', modelId: 'offline-model' };
    const { renderModelRoutingSection } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    await renderModelRoutingSection(host);
    const select = host.querySelector<HTMLSelectElement>('#modelRouting-builder-model')!;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(select.value, 'offline-host\u001foffline-model');
    assert.match(select.selectedOptions[0].textContent!, /saved model/);
    assert.equal(writes.length, 0);
  });

  test('the explicit follow action clears the binding and updates its source label', async () => {
    kind = 'goal-eval';
    const { renderModelRoutingSection } = await import('../../src/ui/settings-model-routing.ts');
    const host = document.createElement('div');
    document.body.appendChild(host);
    await renderModelRoutingSection(host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = host.querySelector<HTMLButtonElement>('.settings-routing-follow')!;
    reset.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(binding, { providerId: '', modelId: '' });
    assert.equal(host.querySelector('.settings-routing-source')?.textContent, 'Follows chat');
    assert.equal(reset.hidden, true);
  });

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

  for (const agentKind of ['work-agent', 'sub-agent']) {
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
        assert.deepEqual(writes[0], { types: { builder: { ...advanced, providerId: '', modelId: '' } } });
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
