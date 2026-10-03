import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  createDefaultOnboardingState,
  hasExistingChatMessageHistory,
  hasUserConfiguredProviderIds,
  isOnboardingComplete,
  recordStepProgress,
  buildOnboardingContext,
} = await import('../../src/onboarding/state-core.ts');

describe('onboarding state-core', () => {
  test('createDefaultOnboardingState returns version 1 incomplete state', () => {
    const state = createDefaultOnboardingState();
    assert.equal(state.version, 1);
    assert.equal(state.completedAt, null);
    assert.deepEqual(state.steps, {});
  });

  test('recordStepProgress merges step data', () => {
    const base = createDefaultOnboardingState();
    const next = recordStepProgress(base, 'theme', {
      done: true,
      data: { mode: 'light' },
    });
    assert.equal(next.lastStep, 'theme');
    assert.equal(next.steps.theme?.done, true);
    assert.equal(next.steps.theme?.data?.mode, 'light');
  });

  test('isOnboardingComplete reflects completedAt', () => {
    const open = createDefaultOnboardingState();
    assert.equal(isOnboardingComplete(open), false);
    const done = { ...open, completedAt: '2026-07-07T00:00:00.000Z' };
    assert.equal(isOnboardingComplete(done), true);
  });

  test('seed providers alone do not count as user configuration', () => {
    assert.equal(
      hasUserConfiguredProviderIds(['lm-studio-local', 'llama-cpp-local']),
      false,
    );
    assert.equal(
      hasUserConfiguredProviderIds(['lm-studio-local', 'vite-fallback']),
      false,
    );
    assert.equal(hasUserConfiguredProviderIds(['lm-studio-local', 'openrouter']), true);
  });

  test('hasExistingChatMessageHistory ignores empty chats and model binding', () => {
    assert.equal(
      hasExistingChatMessageHistory([
        { history: [], modelId: 'gpt-4', providerId: 'openrouter' },
      ]),
      false,
    );
    assert.equal(
      hasExistingChatMessageHistory([{ history: [{ role: 'user', content: 'hi' }] }]),
      true,
    );
  });

  test('buildOnboardingContext reads provider path from step data', () => {
    const base = recordStepProgress(createDefaultOnboardingState(), 'provider-choice', {
      data: { path: 'cloud' },
    });
    const ctx = buildOnboardingContext(base, {
      serverAvailable: true,
      configServerAvailable: true,
    });
    assert.equal(ctx.providerPath, 'cloud');
  });

  test('resuming honors the latest path instead of a previously visited branch', () => {
    const state = createDefaultOnboardingState();
    state.steps = {
      'provider-choice': { data: { path: 'cloud' } },
      'provider-local': { data: { path: 'local', providerId: 'local' } },
      'provider-cloud': { data: { path: 'cloud', providerId: 'cloud' } },
      'model-pick': { data: { providerId: 'local', modelId: 'old-model' } },
    };
    const ctx = buildOnboardingContext(state, { serverAvailable: true, configServerAvailable: true });
    assert.equal(ctx.providerPath, 'cloud');
    assert.equal(ctx.providerId, 'cloud');
    assert.equal(ctx.modelId, null);
    state.steps['provider-choice'] = { skipped: true, data: { path: null } };
    const skipped = buildOnboardingContext(state, { serverAvailable: true, configServerAvailable: true });
    assert.equal(skipped.providerPath, null);
    assert.equal(skipped.providerId, null);
  });

  test('completing a previously skipped step clears its skipped flag', () => {
    const state = recordStepProgress(createDefaultOnboardingState(), 'theme', { skipped: true });
    assert.equal(recordStepProgress(state, 'theme', { done: true }).steps.theme.skipped, false);
  });
});
