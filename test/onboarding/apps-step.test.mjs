import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ONBOARDING_PHASES } from '../../src/onboarding/phases.ts';
import { ONBOARDING_STEPS, resolveStepIndex } from '../../src/onboarding/steps/registry.ts';

test('setup goes directly from Appearance to provider choice and has no Apps phase', () => {
  const ids = ONBOARDING_STEPS.map(step => step.id);
  assert.equal(ids.includes('apps'), false);
  assert.equal(ids[ids.indexOf('theme') + 1], 'provider-choice');
  assert.equal(ONBOARDING_PHASES.some(phase => phase.id === 'apps'), false);
});

test('a saved Apps step resumes at provider choice', () => {
  assert.equal(ONBOARDING_STEPS[resolveStepIndex(ONBOARDING_STEPS, 'apps')].id, 'provider-choice');
});
