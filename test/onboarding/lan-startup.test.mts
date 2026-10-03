import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';

test('onboarding imports and claims its lease over LAN HTTP without crypto.randomUUID', async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>();
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    },
  });
  setStorageModeForTests('localStorage');
  try {
    // This module is imported during boot before the model catalog is fetched.
    const { tryClaimOnboardingOverlay, releaseOnboardingOverlayClaim, loadOnboardingState } =
      await import('../../src/onboarding/persistence.ts');
    const claim = await tryClaimOnboardingOverlay(createDefaultOnboardingState());
    assert.equal(claim.claimed, true);
    assert.match(claim.state.overlayOwner!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal((await loadOnboardingState()).overlayOwner, claim.state.overlayOwner);
    await releaseOnboardingOverlayClaim(claim.state);
    assert.equal((await loadOnboardingState()).overlayOwner, null);
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, 'crypto');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    setStorageModeForTests(null);
  }
});
