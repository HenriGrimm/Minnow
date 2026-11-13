import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { context7Step, resetContext7StepState } = await import(
  '../../src/onboarding/steps/context7.ts'
);

describe('onboarding context7 step', () => {
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
