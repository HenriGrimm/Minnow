import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';
import { ONBOARDING_STEPS } from '../../src/onboarding/steps/registry.ts';
import { mountOnboarding, unmountOnboarding, isOnboardingMounted } from '../../src/onboarding/controller.ts';
import { migrateExistingUsersIfNeeded } from '../../src/onboarding/state.ts';

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected onboarding state did not appear');
    await new Promise(resolve => setImmediate(resolve));
  }
}

test('failed save keeps input and wizard mounted, Retry saves it, completion failure stays recoverable', async () => {
  const win = new Window({ url: 'http://localhost:9473' });
  const previousFetch = globalThis.fetch;
  let state = createDefaultOnboardingState();
  let failSave = true;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/api/config/onboarding')) {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'claim') return Response.json({ claimed: true, state });
      if (body.action === 'save') {
        if (failSave) return Response.json({ error: 'disk full' }, { status: 500 });
        state = body.state;
      }
      return Response.json({ state });
    }
    if (url.includes('onboarding.json')) return Response.json(state);
    if (url.includes('/api/providers')) return Response.json({ providers: [], activeProviderId: null });
    return Response.json({ data: [], models: [] });
  };
  installHappyDomGlobals(win, { fetch: fakeFetch });
  setStorageModeForTests('server');
  const welcome = ONBOARDING_STEPS[0];
  const originalRender = welcome.render;
  const originalCommit = welcome.commit;
  welcome.render = (container, _ctx, actions) => {
    container.innerHTML = '<input aria-label="Setup choice" value="retained">';
    actions.setPrimaryEnabled(true);
  };
  welcome.commit = ctx => {
    ctx.state = { ...ctx.state, steps: { welcome: { data: {
      choice: win.document.querySelector('input')?.value,
    } } } };
  };
  try {
    await mountOnboarding({ force: true });
    const input = win.document.querySelector('input')!;
    input.value = 'my choice';
    win.document.querySelector<HTMLButtonElement>('.mn-onboarding-primary-btn')!.click();
    await waitUntil(() => Boolean(win.document.querySelector('[role="alert"]')?.textContent?.includes('disk full')));
    assert.equal(isOnboardingMounted(), true);
    assert.equal(win.document.querySelector('input'), input);
    assert.equal(input.value, 'my choice');
    failSave = false;
    [...win.document.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === 'Retry')!.click();
    await waitUntil(() => state.steps.welcome?.data?.choice === 'my choice' && win.document.querySelector<HTMLElement>('[role="alert"]')?.hidden === true);
    failSave = true;
    await assert.rejects(unmountOnboarding(true), /disk full/);
    assert.equal(isOnboardingMounted(), true);
    failSave = false;
    await unmountOnboarding(true);
    assert.equal(isOnboardingMounted(), false);
    assert.ok(state.completedAt);
  } finally {
    failSave = false;
    await unmountOnboarding(false);
    welcome.render = originalRender;
    welcome.commit = originalCommit;
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});

test('keyboard controls retain native Enter behavior and skipping extras reveals hosted search setup', async () => {
  const win = new Window({ url: 'http://localhost:9473' });
  const previousFetch = globalThis.fetch;
  installHappyDomGlobals(win, { fetch: async () => Response.json({ data: [], providers: [] }) });
  setStorageModeForTests('localStorage');
  try {
    await mountOnboarding({ force: true });
    const root = win.document.querySelector('.mn-onboarding')!;
    const button = win.document.querySelector<HTMLButtonElement>('.mn-onboarding-primary-btn')!;
    const event = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.ok(root.querySelector('.mn-onboarding-step--welcome'));
    button.click();
    await waitUntil(() => Boolean(root.querySelector('.mn-onboarding-step--theme')));
    assert.equal(win.document.activeElement?.tagName, 'H2');
    const select = win.document.createElement('select');
    root.appendChild(select);
    const selectEvent = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    select.dispatchEvent(selectEvent);
    assert.equal(selectEvent.defaultPrevented, false);
    select.remove();
    const skip = root.querySelector<HTMLButtonElement>('.mn-onboarding-skip-btn')!;
    for (const title of ['Choose your apps', 'How will you run models?', 'Install extras', 'Tool permissions', 'Memory and Brain', 'Search API keys']) {
      skip.click();
      await waitUntil(() => root.querySelector('h2')?.textContent === title);
    }
    const mirror = JSON.parse(win.localStorage.getItem('minnow.onboarding.v1')!);
    assert.equal(mirror.steps.extras.data.searxngSkipped, true);
    assert.equal(mirror.steps.extras.done, false);
  } finally {
    await unmountOnboarding(false);
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});

test('partially completed setup is resumed rather than migrated away after adding a provider', async () => {
  const state = { ...createDefaultOnboardingState(), lastStep: 'provider-cloud' as const,
    steps: { 'provider-cloud': { done: true, data: { providerId: 'custom' } } } };
  assert.equal(await migrateExistingUsersIfNeeded(state), state);
});
