import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getApplicableSteps, resolveStepIndex } from '../../src/onboarding/steps/registry.ts';
import { buildOnboardingContext, createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';

function context(lastStep = null, steps = {}) {
  return buildOnboardingContext(
    { ...createDefaultOnboardingState(), lastStep, steps },
    { serverAvailable: true, configServerAvailable: true },
  );
}

test('setup shows provider choice, then only the chosen connection and any model selection', () => {
  assert.deepEqual(getApplicableSteps(context()).map(step => step.id), ['provider-choice']);
  for (const path of ['local', 'cloud', 'cli', 'managed']) {
    const ctx = context('provider-choice', { 'provider-choice': { done: true, data: { path } } });
    const expected = ['provider-choice', `provider-${path}`];
    if (path !== 'managed') expected.push('model-pick');
    assert.deepEqual(getApplicableSteps(ctx).map(step => step.id), expected);
  }
});

test('legacy welcome, appearance and app steps resume at provider choice', () => {
  for (const lastStep of ['welcome', 'theme', 'apps']) {
    const ctx = context(lastStep);
    const steps = getApplicableSteps(ctx);
    assert.equal(steps[resolveStepIndex(steps, ctx)].id, 'provider-choice');
  }
});

test('a saved provider resumes at model selection, including from a legacy optional step', () => {
  const saved = {
    'provider-choice': { done: true, data: { path: 'local' } },
    'provider-local': { done: true, data: { providerId: 'fixture' } },
  };
  for (const lastStep of ['provider-local', 'permissions', 'extras']) {
    const ctx = context(lastStep, saved);
    const steps = getApplicableSteps(ctx);
    assert.equal(steps[resolveStepIndex(steps, ctx)].id, 'model-pick');
  }
});
