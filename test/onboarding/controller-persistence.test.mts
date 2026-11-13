import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { invalidateProviderCache } from '../../src/providers/store.ts';
import { createDefaultOnboardingState } from '../../src/onboarding/state-core.ts';
import { ONBOARDING_STEPS } from '../../src/onboarding/steps/registry.ts';
import { mountOnboarding, unmountOnboarding, isOnboardingMounted } from '../../src/onboarding/controller.ts';
import { migrateExistingUsersIfNeeded } from '../../src/onboarding/state.ts';
import { invalidateProviderCache } from '../../src/providers/store.ts';

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
  const choice = ONBOARDING_STEPS[0];
  const originalRender = choice.render;
  const originalCommit = choice.commit;
  choice.render = (container, _ctx, actions) => {
    container.innerHTML = '<input aria-label="Setup choice" value="retained"><button>Connect</button>';
    container.querySelector('button')!.onclick = () => {
      actions.patchContext({ providerPath: 'local' });
      actions.next();
    };
  };
  choice.commit = ctx => {
    ctx.state = { ...ctx.state, steps: { 'provider-choice': { data: {
      path: ctx.providerPath, choice: win.document.querySelector('input')?.value,
    } } } };
  };
  try {
    await mountOnboarding({ force: true });
    const input = win.document.querySelector('input')!;
    input.value = 'my choice';
    win.document.querySelector<HTMLButtonElement>('.mn-onboarding-step button')!.click();
    await waitUntil(() => Boolean(win.document.querySelector('[role="alert"]')?.textContent?.includes('disk full')));
    assert.equal(isOnboardingMounted(), true);
    assert.equal(win.document.querySelector('input'), input);
    assert.equal(input.value, 'my choice');
    failSave = false;
    [...win.document.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === 'Retry')!.click();
    await waitUntil(() => state.steps['provider-choice']?.data?.choice === 'my choice'
      && win.document.querySelector('h2')?.textContent === 'Local server');
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
    choice.render = originalRender;
    choice.commit = originalCommit;
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});

test('setup traps focus and Set up later restores focus and prevents repeat prompts', async () => {
  const win = new Window({ url: 'http://localhost:9473' });
  const previousFetch = globalThis.fetch;
  installHappyDomGlobals(win, { fetch: async () => Response.json({ data: [], providers: [] }) });
  setStorageModeForTests('localStorage');
  try {
    document.body.innerHTML = '<main id="osStage"><button>Run setup again</button></main>';
    const stage = document.getElementById('osStage')!;
    const opener = stage.querySelector('button')!;
    opener.focus();
    await mountOnboarding({ force: true });
    const root = win.document.querySelector('.mn-onboarding')!;
    const firstChoice = root.querySelector<HTMLButtonElement>('.mn-onboarding-choice')!;
    const skip = root.querySelector<HTMLButtonElement>('.mn-onboarding-skip-btn')!;
    assert.equal(stage.inert, true);
    assert.equal(skip.textContent, 'Set up later');
    assert.equal(root.querySelector('h2')?.textContent, 'Connect a provider');
    assert.equal(root.querySelector<HTMLButtonElement>('.mn-onboarding-primary-btn')?.hidden, true);
    assert.equal(root.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true');
    assert.equal(win.document.activeElement?.tagName, 'H2');
    const backTab = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    win.document.activeElement!.dispatchEvent(backTab);
    assert.equal(backTab.defaultPrevented, true);
    assert.equal(win.document.activeElement, skip);
    const tab = new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    skip.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(win.document.activeElement, firstChoice);
    const select = win.document.createElement('select');
    root.appendChild(select);
    const selectEvent = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    select.dispatchEvent(selectEvent);
    assert.equal(selectEvent.defaultPrevented, false);
    select.remove();
    skip.click();
    await waitUntil(() => !isOnboardingMounted());
    const mirror = JSON.parse(win.localStorage.getItem('minnow.onboarding.v1')!);
    assert.ok(mirror.completedAt);
    assert.deepEqual(mirror.steps, {});
    assert.equal(stage.inert, false);
    assert.equal(win.document.activeElement, opener);
    await mountOnboarding();
    assert.equal(isOnboardingMounted(), false);
  } finally {
    await unmountOnboarding(false);
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});

test('a legacy setup on permissions can finish from its selected model', async () => {
  const win = new Window({ url: 'http://localhost:9473' });
  const previousFetch = globalThis.fetch;
  const state = {
    ...createDefaultOnboardingState(),
    lastStep: 'permissions',
    steps: {
      'provider-choice': { done: true, data: { path: 'local' } },
      'provider-local': { done: true, data: { providerId: 'fixture' } },
      'model-pick': { done: true, data: { providerId: 'fixture', modelId: 'fixture-model' } },
    },
  };
  let saved = state;
  installHappyDomGlobals(win, { fetch: async (input, init) => {
    const url = String(input);
    if (url.includes('/api/config/onboarding')) {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'claim') return Response.json({ claimed: true, state: saved });
      if (body.action === 'save') saved = body.state;
      return Response.json({ state: saved });
    }
    if (url.includes('onboarding.json')) return Response.json(saved);
    if (url.endsWith('/api/config/default-model')) return Response.json({ revision: 1 });
    if (url.endsWith('/fixture/models')) return Response.json({ data: [{ id: 'fixture-model', type: 'llm' }] });
    if (url.endsWith('/api/providers')) {
      return Response.json({ providers: [{ id: 'fixture', label: 'Fixture', apiKind: 'openai-v1' }] });
    }
    return Response.json({}, { status: 404 });
  } });
  setStorageModeForTests('server');
  invalidateProviderCache();
  try {
    await mountOnboarding();
    const root = document.querySelector('.mn-onboarding')!;
    assert.equal(root.querySelector('h2')?.textContent, 'Pick your chat model');
    const primary = root.querySelector<HTMLButtonElement>('.mn-onboarding-primary-btn')!;
    assert.equal(primary.textContent, 'Done');
    await waitUntil(() => !primary.disabled);
    primary.click();
    await waitUntil(() => !isOnboardingMounted());
    assert.ok(saved.completedAt);
    assert.equal(saved.steps['model-pick'].data.modelId, 'fixture-model');
    assert.equal('permissions' in saved.steps, false);
    assert.equal('api-keys' in saved.steps, false);
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

test('local setup probes draft URLs without registering them and saves the confirmed provider and model', async () => {
  const win = new Window({ url: 'http://localhost:9473' });
  const previousFetch = globalThis.fetch;
  let state = createDefaultOnboardingState();
  const providers: Array<{ id: string; baseUrl: string }> = [];
  invalidateProviderCache();
  installHappyDomGlobals(win, { fetch: async (input, init) => {
    const url = String(input);
    if (url.startsWith('http')) return new Response(null, { status: 404 });
    if (url === '/api/config/onboarding') {
      const { action, state: proposed } = JSON.parse(String(init?.body));
      if (action === 'save') state = proposed;
      return Response.json({ state, claimed: action === 'claim' });
    }
    if (url.includes('onboarding.json')) return Response.json(state);
    if (url === '/api/providers/connection/test') {
      const { baseUrl } = JSON.parse(String(init?.body));
      return baseUrl.endsWith(':8765') ? Response.json({ modelCount: 1 })
        : Response.json({ error: 'Unreachable' }, { status: 400 });
    }
    if (url === '/api/providers' && init?.method === 'POST') {
      const provider = JSON.parse(String(init.body));
      providers.push(provider);
      return Response.json(provider);
    }
    if (url === '/api/providers') return Response.json({ providers, activeProviderId: null });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
    return Response.json({});
  } });
  setStorageModeForTests('server');
  try {
    await mountOnboarding({ force: true });
    const root = document.querySelector('.mn-onboarding')!;
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent?.includes('Local server'))!.click();
    await waitUntil(() => root.querySelector('h2')?.textContent === 'Local server');
    const address = root.querySelector<HTMLInputElement>('input[type="url"]')!;
    const probe = [...root.querySelectorAll<HTMLButtonElement>('button')].find(btn => btn.textContent === 'Test connection')!;
    const primary = root.querySelector<HTMLButtonElement>('.mn-onboarding-primary-btn')!;
    address.value = 'http://127.0.0.1:8764';
    address.dispatchEvent(new win.Event('input'));
    probe.click();
    await waitUntil(() => root.textContent!.includes('Could not connect to the model server'));
    assert.equal(primary.disabled, true);
    assert.equal(providers.length, 0);
    address.value = 'http://127.0.0.1:8765';
    address.dispatchEvent(new win.Event('input'));
    probe.click();
    await waitUntil(() => !primary.disabled);
    assert.equal(providers.length, 0);
    primary.click();
    await waitUntil(() => root.querySelector('h2')?.textContent === 'Pick your chat model' && !primary.disabled);
    assert.equal(providers.length, 1);
    assert.equal(primary.textContent, 'Done');
    primary.click();
    await waitUntil(() => !isOnboardingMounted());
    assert.ok(state.completedAt);
    assert.equal(state.steps['model-pick']?.data?.modelId, 'fixture-model');
  } finally {
    await unmountOnboarding(false);
    invalidateProviderCache();
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});

test('shared Settings markers inside setup do not close onboarding on click', async () => {
  const win = new Window({ url: 'http://localhost:9473/#/workspaces' });
  const previousFetch = globalThis.fetch;
  installHappyDomGlobals(win, { fetch: async () => Response.json({ data: [], providers: [] }) });
  setStorageModeForTests('localStorage');
  const choice = ONBOARDING_STEPS[0];
  const originalRender = choice.render;
  let clicked = false;
  choice.render = (container, _ctx, actions) => {
    container.innerHTML = '<section data-settings-search-key="github.account"><button>Check again</button></section>';
    container.querySelector('button')!.onclick = () => { clicked = true; };
    actions.setPrimaryEnabled(true);
  };
  try {
    await mountOnboarding({ force: true });
    win.document.querySelector<HTMLButtonElement>('[data-settings-search-key] button')!.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clicked, true);
    assert.equal(isOnboardingMounted(), true);
    assert.equal(win.location.hash, '#/workspaces');
  } finally {
    await unmountOnboarding(false);
    choice.render = originalRender;
    globalThis.fetch = previousFetch;
    setStorageModeForTests(null);
    win.close();
  }
});
