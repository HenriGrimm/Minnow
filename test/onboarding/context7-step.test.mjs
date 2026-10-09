import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { context7Step, resetContext7StepState } = await import(
  '../../src/onboarding/steps/context7.ts'
);
const { ONBOARDING_STEPS } = await import('../../src/onboarding/steps/registry.ts');
const { ONBOARDING_PHASES } = await import('../../src/onboarding/phases.ts');

describe('onboarding context7 step', () => {
  test('Context7 is registered after web search', () => {
    const ids = ONBOARDING_STEPS.map((step) => step.id);
    const apiKeysIndex = ids.indexOf('api-keys');
    const context7Index = ids.indexOf('context7');
    assert.ok(apiKeysIndex >= 0);
    assert.ok(context7Index > apiKeysIndex);
    assert.equal(ids[context7Index], 'context7');
  });

  test('web search has its own phase before Workspace, which includes Context7', () => {
    const workspace = ONBOARDING_PHASES.find((phase) => phase.id === 'workspace');
    assert.ok(workspace);
    assert.ok(workspace.stepIds.includes('context7'));
    const searchIndex = ONBOARDING_PHASES.findIndex(phase => phase.id === 'search');
    assert.ok(searchIndex >= 0);
    assert.ok(searchIndex < ONBOARDING_PHASES.indexOf(workspace));
    assert.deepEqual(ONBOARDING_PHASES[searchIndex].stepIds, ['api-keys']);
  });

  test('isApplicable requires local tool server', () => {
    assert.equal(context7Step.isApplicable({ serverAvailable: true }), true);
    assert.equal(context7Step.isApplicable({ serverAvailable: false }), false);
  });

  test('can be skipped and exposes reset helper', () => {
    assert.equal(context7Step.canSkip, true);
    resetContext7StepState();
    assert.equal(context7Step.id, 'context7');
  });
});
