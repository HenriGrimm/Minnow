/**
 * Onboarding Choose your apps step + phase registration.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { ONBOARDING_PHASES } = await import('../../src/onboarding/phases.ts');
const { appsStep, resetAppsStepState } = await import('../../src/onboarding/steps/apps.ts');
const {
  buildOnboardingContext,
  createDefaultOnboardingState,
} = await import('../../src/onboarding/state-core.ts');
const {
  listCoreReleasedApps,
  listOptionalReleasedApps,
} = await import('../../src/os/app-registry.ts');
const {
  isAppEnabled,
  resetAppPreferencesForTests,
} = await import('../../src/os/app-preferences.ts');

let testWindow = null;

function setupDom() {
  testWindow = new Window();
  globalThis.window = testWindow;
  globalThis.document = testWindow.document;
  globalThis.HTMLElement = testWindow.HTMLElement;
  globalThis.localStorage = testWindow.localStorage;
  testWindow.localStorage.clear();
  resetAppPreferencesForTests();
  resetAppsStepState();
}

function makeActions() {
  return {
    next: () => {},
    back: () => {},
    skip: () => {},
    patchContext: () => {},
    setPrimaryEnabled: () => {},
    setPrimaryLabel: () => {},
    stepIndex: 2,
    totalSteps: 12,
  };
}

describe('onboarding apps step', () => {
  beforeEach(() => {
    setupDom();
  });

  afterEach(() => {
    resetAppPreferencesForTests();
    resetAppsStepState();
    testWindow?.close();
    testWindow = null;
  });

  test('Apps phase sits between Appearance and Models', () => {
    const look = ONBOARDING_PHASES.findIndex((phase) => phase.id === 'look');
    const apps = ONBOARDING_PHASES.findIndex((phase) => phase.id === 'apps');
    const models = ONBOARDING_PHASES.findIndex((phase) => phase.id === 'models');
    assert.ok(look >= 0);
    assert.ok(apps > look);
    assert.ok(models > apps);
    assert.deepEqual(ONBOARDING_PHASES[apps].stepIds, ['apps']);
  });

  test('render shows core note and Coming soon when no optional apps', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ctx = buildOnboardingContext(createDefaultOnboardingState(), {
      serverAvailable: true,
      configServerAvailable: true,
    });

    appsStep.render(container, ctx, makeActions());

    assert.equal(listOptionalReleasedApps().length, 0);
    assert.equal(container.querySelectorAll('.mn-app-picker-card').length, 0);
    assert.ok(container.querySelector('.mn-app-picker-core'));
    assert.match(container.querySelector('.mn-app-picker-core')?.textContent ?? '', /Issues/);
    // Research is hidden for release, so it is not listed.
    assert.doesNotMatch(container.querySelector('.mn-app-picker-core')?.textContent ?? '', /Research/);
    assert.match(container.querySelector('.mn-app-picker-core')?.textContent ?? '', /Scheduler/);
    assert.ok(container.querySelector('.mn-app-picker-coming-soon'));
    assert.match(
      container.querySelector('.mn-app-picker-coming-soon__title')?.textContent ?? '',
      /Coming soon/i,
    );
    assert.equal(container.querySelector('.mn-app-picker-toolbar'), null);
  });

  test('commit records core apps and empty optional selection', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ctx = buildOnboardingContext(createDefaultOnboardingState(), {
      serverAvailable: true,
      configServerAvailable: true,
    });

    appsStep.render(container, ctx, makeActions());
    appsStep.commit(ctx);

    assert.equal(ctx.state.steps.apps?.done, true);
    assert.deepEqual(ctx.state.steps.apps?.data?.enabledAppIds, []);
    assert.deepEqual(
      ctx.state.steps.apps?.data?.coreAppIds,
      listCoreReleasedApps().map((app) => app.id),
    );
    assert.equal(isAppEnabled('issues'), true);
    assert.equal(isAppEnabled('research'), false);
    assert.equal(isAppEnabled('scheduler'), true);
  });
});
