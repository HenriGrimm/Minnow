/**
 * MIN-438 — onboarding step totals must reflect path-dependent steps.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { getApplicableSteps } = await import('../../src/onboarding/steps/registry.ts');
const {
  buildOnboardingContext,
  createDefaultOnboardingState,
} = await import('../../src/onboarding/state-core.ts');
const { mountStepSidebar } = await import('../../src/onboarding/step-sidebar.ts');
const {
  resetAppPreferencesForTests,
} = await import('../../src/os/app-preferences.ts');

/** happy-dom windows keep the event loop alive unless closed. */
let testWindow = null;

function setupDom() {
  testWindow = new Window();
  globalThis.window = testWindow;
  globalThis.document = testWindow.document;
  globalThis.HTMLElement = testWindow.HTMLElement;
  globalThis.matchMedia = testWindow.matchMedia.bind(testWindow);
  globalThis.localStorage = testWindow.localStorage;
  testWindow.localStorage.clear();
  resetAppPreferencesForTests();
}

function ctxWith(overrides = {}) {
  const base = buildOnboardingContext(createDefaultOnboardingState(), {
    serverAvailable: true,
    configServerAvailable: true,
  });
  return { ...base, ...overrides };
}

describe('onboarding step count (MIN-438)', () => {
  afterEach(() => {
    resetAppPreferencesForTests();
    testWindow?.close();
    testWindow = null;
  });

  test('before provider path is chosen, branch steps are excluded (10 with server)', () => {
    const steps = getApplicableSteps(ctxWith());
    assert.equal(steps.length, 10);
    assert.equal(steps.some((step) => step.id === 'apps'), true);
    assert.equal(steps.some((step) => step.id === 'provider-local'), false);
    assert.equal(steps.some((step) => step.id === 'model-pick'), false);
  });

  test('local provider path includes branch + model pick (12 with server, no api-keys)', () => {
    const steps = getApplicableSteps(ctxWith({ providerPath: 'local' }));
    assert.equal(steps.length, 12);
    assert.equal(steps.some((step) => step.id === 'provider-local'), true);
    assert.equal(steps.some((step) => step.id === 'model-pick'), true);
    assert.equal(steps.some((step) => step.id === 'context7'), true);
    assert.equal(steps.some((step) => step.id === 'email'), false);
  });

  test('hidden email app omits setup steps even when server is up', () => {
    setupDom();
    const steps = getApplicableSteps(ctxWith({ providerPath: 'local' }));
    assert.equal(steps.some((step) => step.id === 'email'), false);
  });

  test('sidebar progress label updates when filtered steps grow', () => {
    setupDom();
    const aside = document.createElement('aside');
    const mobile = document.createElement('div');
    document.body.append(aside, mobile);

    const initial = getApplicableSteps(ctxWith());
    const handle = mountStepSidebar(aside, mobile, initial, 'welcome');

    assert.equal(
      aside.querySelector('.mn-onboarding__progress-label')?.textContent,
      'Step 1 of 10',
    );

    const expanded = getApplicableSteps(ctxWith({ providerPath: 'local' }));
    handle.setSteps(expanded);
    handle.setActiveStep('provider-local', 4);

    assert.equal(
      aside.querySelector('.mn-onboarding__progress-label')?.textContent,
      'Step 5 of 12',
    );

    handle.destroy();
  });
});
