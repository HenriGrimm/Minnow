import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core';

let finishMemory!: (value: unknown) => void;
mock.module('../../src/memory/client.ts', { namedExports: {
  warmupMemoryEmbeddings: () => new Promise(resolve => { finishMemory = resolve; }),
} });
mock.module('../../src/servers/client.ts', { namedExports: {
  fetchManagedServers: async () => [], fetchServerInstallStatus: async () => ({}),
  installManagedServer: async () => { throw new Error('SearXNG should be opt-in'); },
  setManagedServerAutoStart: async () => {}, setManagedServerEnabled: async () => {}, startManagedServer: async () => ({}),
} });
const { extrasStep, resetExtrasStepState } = await import('../../src/onboarding/steps/extras');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('extras show task progress, keep logs collapsed, and offer a recoverable retry', async () => {
  resetExtrasStepState();
  const win = new Window();
  installHappyDomGlobals(win);
  const container = document.createElement('div');
  document.body.append(container);
  const ctx = buildOnboardingContext(createDefaultOnboardingState(), { serverAvailable: true, configServerAvailable: true });
  let enabled = false;
  const cleanup = extrasStep.render(container, ctx, { next() {}, back() {}, skip() {}, patchContext() {},
    setPrimaryEnabled(value) { enabled = value; }, setPrimaryLabel() {}, stepIndex: 5, totalSteps: 11 });
  try {
    assert.equal(container.querySelector<HTMLInputElement>('[data-extra-id="searxng"] input')!.checked, false);
    assert.equal(enabled, true);
    const install = container.querySelector<HTMLButtonElement>('.mn-onboarding-secondary-btn')!;
    install.click();
    await flush();
    assert.equal(enabled, false);
    assert.equal(container.querySelector<HTMLDetailsElement>('.mn-onboarding-install-console details')!.open, false);
    assert.equal(container.querySelector<HTMLProgressElement>('[data-extra-id="embeddings"] progress')!.hasAttribute('value'), false);
    assert.match(container.textContent!, /0 of 1 ready/);
    finishMemory({ kind: 'err', error: 'Network unavailable' });
    await flush();
    assert.equal(enabled, true);
    assert.equal(install.hidden, false);
    assert.equal(install.textContent, 'Retry failed installs');
    assert.match(container.textContent!, /1 need attention/);
    assert.equal(container.querySelector('.mn-onboarding-install-console')!.classList.contains('is-busy'), false);
    install.click();
    await flush();
    finishMemory({ kind: 'ok' });
    await flush();
    assert.equal(enabled, true);
    assert.equal(install.hidden, true);
    assert.match(container.textContent!, /1 of 1 ready/);
    assert.equal(container.querySelector<HTMLProgressElement>('.mn-onboarding-install-console progress')!.value, 1);
  } finally { if (cleanup) cleanup(); win.close(); resetExtrasStepState(); }
});
