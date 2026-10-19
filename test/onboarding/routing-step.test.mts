import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { OnboardingContext } from '../../src/onboarding/types.ts';
let disposed = 0, committed = 0;
mock.module('../../src/ui/routing-form.ts', { namedExports: {
  mountRoutingForm: (_host: HTMLElement, options: { onReady: () => void }) => {
    options.onReady();
    return { ready: Promise.resolve(), commit: async () => { committed++; }, dispose: () => { disposed++; } };
  },
} });
const { routingStep } = await import('../../src/onboarding/steps/routing.ts');

test('routing onboarding is optional and applies to every configured provider branch', () => {
  assert.equal(routingStep.canSkip, true);
  for (const providerPath of ['managed', 'local', 'cloud', 'cli']) assert.equal(routingStep.isApplicable({ providerPath, providerId: 'provider', modelId: 'model' } as OnboardingContext), true);
  assert.equal(routingStep.isApplicable({ providerId: 'provider', modelId: null } as OnboardingContext), false);
});

test('routing onboarding stages choices until Continue and disposes its independent mount', async () => {
  let enabled = false;
  const host = document.createElement('div'); document.body.append(host);
  const cleanup = routingStep.render(host, {} as OnboardingContext, { stepIndex: 1, totalSteps: 2, setPrimaryEnabled: (value: boolean) => { enabled = value; } } as any);
  for (let i = 0; i < 30 && !enabled; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(enabled, true); assert.equal(committed, 0);
  await routingStep.commit({} as OnboardingContext); assert.equal(committed, 1);
  if (typeof cleanup === 'function') cleanup(); assert.equal(disposed, 1);
  host.remove();
});
