import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';

let savedDefault = '';
let failSave = false;
let providers: any[] = [];
let modelRows = [{ id: 'model-a', type: 'llm' }, { id: 'model-b', type: 'llm' }];
let modelRequest: (() => Promise<typeof modelRows>) | null = null;
mock.module('../../src/ui/default-model.ts', { namedExports: {
  persistDefaultModelValue: async (value: string) => { if (failSave) throw new Error('disk full'); savedDefault = value; },
} });
mock.module('../../src/providers/store.ts', { namedExports: {
  listProviders: async () => ({ providers }),
  createProvider: async (provider: any) => ({ ok: true, provider }),
  updateProvider: async (id: string, provider: any) => ({ ok: true, provider: { ...provider, id } }),
  updateProviderSecrets: async () => ({ ok: true }),
} });
mock.module('../../src/providers/fetch-models.ts', { namedExports: {
  fetchModelsForProvider: async () => modelRequest ? modelRequest() : modelRows,
} });
mock.module('../../src/onboarding/steps/managed.ts', { namedExports: { providerManagedStep: {} } });
const { modelPickStep } = await import('../../src/onboarding/steps/model.ts');
const { providerChoiceStep, providerLocalStep, providerCloudStep } = await import('../../src/onboarding/steps/provider.ts');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function setup() {
  const win = new Window();
  installHappyDomGlobals(win);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  let enabled = false;
  const actions = { next() {}, back() {}, skip() {}, patchContext(patch: any) { Object.assign(ctx, patch); },
    setPrimaryEnabled(value: boolean) { enabled = value; }, setPrimaryLabel() {}, stepIndex: 3, totalSteps: 11 };
  return { win, container, ctx, actions, enabled: () => enabled };
}

test('model selection saves the global default and propagates save errors for retry', async () => {
  const { win, container, ctx, actions } = setup();
  providers = [{ id: 'cloud', enabled: true }];
  ctx.providerId = 'cloud';
  const cleanup = modelPickStep.render(container, ctx, actions);
  try {
    await flush();
    container.querySelector<HTMLButtonElement>('[data-model-id="model-b"]')!.click();
    failSave = true;
    await assert.rejects(modelPickStep.commit(ctx), /disk full/);
    assert.equal(ctx.state.steps['model-pick'], undefined);
    failSave = false;
    await modelPickStep.commit(ctx);
    assert.equal(savedDefault, encodeModelSelectKey('cloud', 'model-b'));
    assert.equal(ctx.state.steps['model-pick']?.done, true);
    assert.equal(ctx.modelId, 'model-b');
  } finally { failSave = false; if (typeof cleanup === 'function') cleanup(); win.close(); }
});

test('a stale model request cannot change selection after leaving the step', async () => {
  const state = setup();
  providers = [{ id: 'cloud', enabled: true }];
  state.ctx.providerId = 'cloud';
  let resolve!: (value: typeof modelRows) => void;
  modelRequest = () => new Promise(done => { resolve = done; });
  const cleanup = modelPickStep.render(state.container, state.ctx, state.actions);
  try {
    await flush();
    if (typeof cleanup === 'function') cleanup();
    resolve([{ id: 'late-model', type: 'llm' }]);
    await flush();
    assert.equal(state.ctx.modelId, null);
    assert.equal(state.enabled(), false);
  } finally { modelRequest = null; state.win.close(); }
});

test('switching from a connected local provider to cloud cannot reuse local credentials or readiness', async () => {
  const state = setup();
  const { container, ctx, actions, win } = state;
  providers = [];
  try {
    providerChoiceStep.render(container, ctx, actions);
    container.querySelectorAll<HTMLButtonElement>('.mn-onboarding-choice')[0].click();
    providerLocalStep.render(container, ctx, actions);
    container.querySelector<HTMLButtonElement>('.mn-onboarding-secondary-btn')!.click();
    await flush();
    assert.equal(state.enabled(), true);
    await providerLocalStep.commit(ctx);
    assert.ok(ctx.providerId);
    const url = container.querySelector<HTMLInputElement>('input')!;
    url.value = 'http://localhost:9999';
    url.dispatchEvent(new win.Event('input'));
    assert.equal(state.enabled(), false, 'editing a tested URL requires another test');
    providerChoiceStep.render(container, ctx, actions);
    container.querySelectorAll<HTMLButtonElement>('.mn-onboarding-choice')[2].click();
    providerCloudStep.render(container, ctx, actions);
    await flush();
    assert.equal(state.enabled(), false);
    assert.equal(ctx.providerId, null);
    await providerCloudStep.commit(ctx);
    assert.equal(ctx.state.steps['provider-cloud'], undefined);
  } finally { win.close(); }
});
