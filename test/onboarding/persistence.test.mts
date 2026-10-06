import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';
import { saveOnboardingState, loadOnboardingState, markOnboardingComplete,
  tryClaimOnboardingOverlay, releaseOnboardingOverlayClaim } from '../../src/onboarding/persistence.ts';

const previousFetch = globalThis.fetch;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const entries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => entries.set(key, value),
} });
after(() => {
  globalThis.fetch = previousFetch;
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  setStorageModeForTests(null);
});

test('HTTP/network save failure rejects, preserves canonical mirror, and explicit retry completes', async () => {
  setStorageModeForTests('server');
  const base = createDefaultOnboardingState();
  entries.set('minnow.onboarding.v1', JSON.stringify(base));
  const progress = { ...base, lastStep: 'theme' as const, steps: { theme: { done: true, data: { mode: 'light' } } } };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'disk full' }), { status: 500 });
  await assert.rejects(saveOnboardingState(progress), /disk full/);
  assert.equal(JSON.parse(entries.get('minnow.onboarding.v1')!).lastStep, null);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(markOnboardingComplete(progress), /offline/);
  let canonical = base;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') canonical = JSON.parse(String(init.body)).state;
    return Response.json(init?.method === 'POST' ? { state: canonical } : canonical);
  };
  await saveOnboardingState(progress);
  const complete = await markOnboardingComplete(progress);
  assert.deepEqual(await loadOnboardingState(), complete);
  assert.equal(complete.steps.theme?.data?.mode, 'light');
});

test('local-only setup claim, progress and completion remain functional without fetch', async () => {
  setStorageModeForTests('localStorage');
  entries.clear();
  globalThis.fetch = async () => { throw new Error('Local mode must not fetch'); };
  const claim = await tryClaimOnboardingOverlay(createDefaultOnboardingState());
  assert.equal(claim.claimed, true);
  const complete = await markOnboardingComplete(claim.state);
  await releaseOnboardingOverlayClaim(complete);
  assert.equal((await loadOnboardingState()).completedAt, complete.completedAt);
});
