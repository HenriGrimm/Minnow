import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core';

let savedDirs: string[] = [];
let failSave = false;
let loaded: unknown;
let hardwareRequest: () => Promise<any> = () => new Promise(() => {});
let savedDefault = '';
const model = { id: 'gguf:existing', name: 'Existing model', path: 'D:/Models/existing.gguf',
  format: 'GGUF', quant: 'Q4_K_M', sizeBytes: 1024 ** 3, incomplete: false };
mock.module('../../src/models/api-client.ts', { namedExports: {
  fetchModelsConfig: async () => ({ modelDirs: ['D:/Models'] }),
  saveModelsConfig: async (patch: any) => { if (failSave) throw new Error('disk full'); savedDirs = patch.modelDirs; return patch; },
  fetchCachedModels: async () => [],
} });
mock.module('../../src/models/library.ts', { namedExports: { buildLibrary: async () => [model] } });
mock.module('../../src/ui/workspace-folder-picker.ts', { namedExports: {
  openWorkspaceFolderPicker: async () => ({ cancelled: false, path: 'E:/My models' }),
} });
mock.module('../../src/models/hardware-client.ts', { namedExports: { fetchHardware: () => hardwareRequest() } });
mock.module('../../src/onboarding/managed-setup.ts', { namedExports: {
  listModelsForHardware: async () => [], pickRecommendedModel: async () => null,
  runManagedModelSetup: async () => { throw new Error('No download should start'); },
  runExistingModelSetup: async (selected: unknown, onProgress: any) => {
    loaded = selected;
    onProgress({ phase: 'done', percent: 100, message: 'Ready' });
    return { ok: true, providerId: 'llama-cpp-local', modelId: 'Existing model' };
  },
} });
mock.module('../../src/ui/default-model.ts', { namedExports: {
  persistDefaultModelValue: async (value: string) => { savedDefault = value; },
} });
const { providerManagedStep, resetManagedStepState } = await import('../../src/onboarding/steps/managed');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function setup() {
  resetManagedStepState();
  const win = new Window();
  installHappyDomGlobals(win);
  const container = document.createElement('div');
  document.body.append(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  ctx.providerPath = 'managed';
  let enabled = false;
  let label = '';
  const actions = { next() {}, back() {}, skip() {}, patchContext(patch: any) { Object.assign(ctx, patch); },
    setPrimaryEnabled(value: boolean) { enabled = value; }, setPrimaryLabel(value: string) { label = value; }, stepIndex: 3, totalSteps: 11 };
  const cleanup = providerManagedStep.render(container, ctx, actions);
  return { win, container, ctx, enabled: () => enabled, label: () => label, cleanup };
}

test('managed setup can be skipped immediately while hardware scanning is pending', () => {
  const state = setup();
  try {
    assert.equal(state.enabled(), true);
    assert.equal(state.label(), 'Skip for now');
    assert.ok(state.container.querySelector('.mn-onboarding-storage'));
  } finally { if (state.cleanup) state.cleanup(); state.win.close(); }
});

test('choosing existing storage saves an additive folder and loads weights without a download', async () => {
  const state = setup();
  try {
    state.container.querySelector<HTMLButtonElement>('.mn-onboarding-storage button')!.click();
    await flush();
    assert.deepEqual(savedDirs, ['D:/Models', 'E:/My models']);
    state.container.querySelector<HTMLButtonElement>('.mn-onboarding-storage .mn-onboarding-model-row')!.click();
    await flush();
    assert.equal(loaded, model);
    assert.equal(state.ctx.providerId, 'llama-cpp-local');
    assert.equal(state.label(), 'Continue');
    await providerManagedStep.commit(state.ctx);
    assert.ok(savedDefault.includes('Existing model'));
    assert.equal(state.ctx.state.steps['provider-managed']?.done, true);
  } finally { if (state.cleanup) state.cleanup(); state.win.close(); }
});

test('storage errors remain inline and hardware results after cleanup cannot change navigation', async () => {
  let resolve!: (value: unknown) => void;
  hardwareRequest = () => new Promise(done => { resolve = done; });
  const state = setup();
  try {
    failSave = true;
    state.container.querySelector<HTMLButtonElement>('.mn-onboarding-storage button')!.click();
    await flush();
    assert.match(state.container.querySelector('.mn-onboarding-storage [role="status"]')!.textContent!, /disk full/);
    assert.equal(state.enabled(), true);
    if (state.cleanup) state.cleanup();
    resolve({ cpuName: 'CPU', totalRamGb: 16 });
    await flush();
    assert.equal(state.label(), 'Skip for now');
  } finally { failSave = false; hardwareRequest = () => new Promise(() => {}); state.win.close(); }
});
