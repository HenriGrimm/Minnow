import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';

let keyWrites: unknown[] = [];
let loadKeys: () => Promise<any> = async () => ({ keys: { braveApiKey: 'saved-brave', tavilyApiKey: '' } });
mock.module('../../src/mcp/client.ts', { namedExports: {
  fetchMcpSecrets: async () => ({ hasContext7ApiKey: true }),
  updateMcpSecrets: async (value: unknown) => { keyWrites.push(value); return { ok: true, flags: { hasContext7ApiKey: true } }; },
} });
mock.module('../../src/config/search-config.ts', { namedExports: {
  loadSearchConfig: () => loadKeys(),
  saveSearchConfig: async (value: unknown) => value,
} });
const { context7Step, resetContext7StepState } = await import('../../src/onboarding/steps/context7.ts');
const { apiKeysStep, resetApiKeysStepState } = await import('../../src/onboarding/steps/api-keys.ts');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function setup() {
  const win = new Window();
  installHappyDomGlobals(win);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  let enabled = false;
  const actions = { next() {}, back() {}, skip() {}, patchContext() {},
    setPrimaryEnabled(value: boolean) { enabled = value; }, setPrimaryLabel() {}, stepIndex: 7, totalSteps: 11 };
  return { win, container, ctx, actions, enabled: () => enabled };
}

test('a saved Context7 key can be replaced', async () => {
  const state = setup();
  resetContext7StepState();
  keyWrites = [];
  const cleanup = context7Step.render(state.container, state.ctx, state.actions);
  try {
    await flush();
    const save = state.container.querySelector<HTMLButtonElement>('.mn-onboarding-secondary-btn')!;
    const input = state.container.querySelector<HTMLInputElement>('input')!;
    assert.equal(save.disabled, true);
    input.value = 'replacement-key';
    input.dispatchEvent(new state.win.Event('input'));
    assert.equal(save.disabled, false);
    assert.equal(state.enabled(), false);
    save.click();
    await flush();
    assert.deepEqual(keyWrites, [{ context7ApiKey: 'replacement-key' }]);
    assert.equal(state.enabled(), true);
    assert.equal(input.value, '');
  } finally { if (typeof cleanup === 'function') cleanup(); state.win.close(); }
});

test('search setup validates the selected provider rather than an unrelated saved key', async () => {
  const state = setup();
  resetApiKeysStepState();
  try {
    apiKeysStep.render(state.container, state.ctx, state.actions);
    await flush();
    assert.equal(state.enabled(), false, 'a Brave key does not configure Tavily');
    state.container.querySelectorAll<HTMLButtonElement>('.mn-onboarding-wallpaper-chip')[1].click();
    assert.equal(state.enabled(), true);
    assert.equal(state.container.querySelector<HTMLInputElement>('input')!.value, 'saved-brave');
  } finally { state.win.close(); }
});

test('loading search keys does not overwrite a key already being entered', async () => {
  const state = setup();
  resetApiKeysStepState();
  let resolve!: (config: unknown) => void;
  loadKeys = () => new Promise(done => { resolve = done; });
  const cleanup = apiKeysStep.render(state.container, state.ctx, state.actions);
  try {
    const input = state.container.querySelector<HTMLInputElement>('input')!;
    input.value = 'new-tavily';
    input.dispatchEvent(new state.win.Event('input'));
    resolve({ keys: { braveApiKey: '', tavilyApiKey: 'old-tavily' } });
    await flush();
    assert.equal(input.value, 'new-tavily');
    assert.equal(state.enabled(), true);
  } finally { if (typeof cleanup === 'function') cleanup(); state.win.close(); }
});
