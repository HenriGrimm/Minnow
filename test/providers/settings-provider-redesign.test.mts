import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { invalidateProviderCache } from '../../src/providers/store.ts';
import { providerLogoId } from '../../src/providers/identity.ts';
import type { ProviderPublic } from '../../src/providers/types.ts';
import { createProviderSettingsRow, renderProvidersSettingsSection } from '../../src/ui/settings-providers.ts';

const connection: ProviderPublic = {
  id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api',
  apiKind: 'openai-v1', enabled: true, hasApiKey: true, hasBearer: false,
};
const originalFetch = globalThis.fetch;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let win: Window;
let requests: { url: string; method: string; body?: string }[];
let registry: ProviderPublic[];
let modelResponse: object;
let mutation: (url: string, init?: RequestInit) => Promise<Response>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function openCard(): HTMLDetailsElement {
  const card = document.querySelector<HTMLDetailsElement>('.settings-providers-edit-panel')!;
  card.open = true;
  card.dispatchEvent(new win.Event('toggle'));
  return card;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  win = new Window({ url: 'http://localhost/#/app/models/providers' });
  for (const key of ['document', 'window', 'localStorage', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Event']) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: key === 'window' ? win : (win as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  document.body.innerHTML = '<div id="settingsProvidersBody"></div>';
  registry = [{ ...connection }];
  requests = [];
  modelResponse = { data: [{ id: 'model-a' }, { id: 'model-b' }] };
  mutation = async () => json({ error: 'Save rejected' }, 400);
  setStorageModeForTests('server');
  invalidateProviderCache();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: init?.body as string | undefined });
    if (method !== 'GET') return mutation(url, init);
    if (url === '/api/providers') return json({ providers: registry, activeProviderId: registry[0]?.id });
    if (url.endsWith('/capabilities')) return json({}, 404);
    if (url.endsWith('/models')) return json(modelResponse);
    return json({});
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setStorageModeForTests(null);
  invalidateProviderCache();
  win.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

test('overlapping renders produce one row per provider, without catalog requests', async () => {
  registry.push({ ...connection, id: 'custom', label: 'Custom', enabled: false });
  await Promise.all([renderProvidersSettingsSection(), renderProvidersSettingsSection()]);
  assert.equal(document.querySelectorAll('.settings-providers-row').length, 2);
  assert.equal(document.querySelectorAll('form.settings-providers-edit-form').length, 0);
  assert.equal(requests.filter((request) => request.url.endsWith('/models') || request.url.endsWith('/capabilities')).length, 0);
  assert.ok(document.querySelector('#settingsProvidersAddPanel')?.classList.contains('hidden'));
});

test('opening cards builds labeled fields once and preserves drafts across close/reopen', () => {
  const row = createProviderSettingsRow(connection, false);
  document.body.append(row);
  const card = openCard();
  const form = card.querySelector('form')!;
  const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'My draft';
  const advanced = form.querySelector<HTMLDetailsElement>('.settings-providers-advanced')!;
  assert.equal(advanced.open, false);
  assert.ok(advanced.querySelector('[name="apiKind"]'));
  assert.ok(advanced.querySelector('[name="modelsPath"]'));
  assert.equal(form.querySelector('input[name="apiKey"]')?.getAttribute('type'), 'password');
  assert.ok(form.querySelector(`label[for="${name.id}"]`));
  assert.equal(form.querySelector('[data-provider-remove]'), null);
  card.open = false;
  card.dispatchEvent(new win.Event('toggle'));
  card.open = true;
  card.dispatchEvent(new win.Event('toggle'));
  assert.equal(card.querySelectorAll('form').length, 1);
  assert.equal(name.value, 'My draft');
});

test('unavailable provider API offers a retry and recovers without remounting the page', async () => {
  const availableFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Server unavailable'); };
  await renderProvidersSettingsSection();
  assert.equal(document.getElementById('settingsProvidersAddButton')!.textContent, 'Retry connection');
  assert.equal(document.getElementById('settingsProvidersList')!.hasAttribute('role'), false);
  globalThis.fetch = availableFetch;
  document.getElementById('settingsProvidersAddButton')!.click();
  await settle();
  assert.equal(document.getElementById('settingsProvidersAddButton')!.textContent, 'Add provider');
  assert.equal(document.querySelectorAll('.settings-providers-row').length, 1);
  assert.equal(document.getElementById('settingsProvidersList')!.getAttribute('role'), 'list');
});

test('connection check reports models, rejects unsaved changes, and treats unreachable HTTP 200 as failure', async () => {
  await renderProvidersSettingsSection();
  const card = openCard();
  const button = card.querySelector<HTMLButtonElement>('[data-provider-test]')!;
  button.click();
  await settle();
  const status = card.querySelector<HTMLElement>('[data-provider-connection-status]')!;
  assert.equal(status.textContent, 'Connected. 2 models available.');
  const count = requests.length;
  const input = card.querySelector<HTMLInputElement>('[name="baseUrl"]')!;
  input.value = 'https://other.example';
  button.click();
  await settle();
  assert.match(status.textContent ?? '', /Save changes before testing/);
  assert.equal(requests.length, count);
  input.value = input.defaultValue;
  modelResponse = { data: [], unreachable: true, error: 'Server unavailable' };
  button.click();
  await settle();
  assert.equal(status.textContent, 'Server unavailable');
  assert.equal(status.dataset.tone, 'error');
  assert.equal(button.disabled, false);
});

test('adding a duplicate preset suggests an unused ID, guards double submits, and keeps failed drafts', async () => {
  await renderProvidersSettingsSection();
  document.getElementById('settingsProvidersAddButton')!.click();
  const preset = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-providers-preset-btn')).find((button) => button.textContent === 'OpenRouter')!;
  preset.click();
  const form = document.getElementById('settingsProvidersAddForm') as HTMLFormElement;
  assert.equal(form.querySelector<HTMLInputElement>('[name="id"]')!.value, 'openrouter-2');
  assert.equal(document.activeElement, form.querySelector('[name="apiKey"]'));
  let finish!: (response: Response) => void;
  mutation = async () => new Promise((resolve) => { finish = resolve; });
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(form.getAttribute('aria-busy'), 'true');
  finish(json({ error: 'Try another name' }, 400));
  await settle();
  assert.equal(form.querySelector<HTMLInputElement>('[name="label"]')!.value, 'OpenRouter');
  assert.match(document.getElementById('settingsProvidersAddError')!.textContent ?? '', /Try another name/);
  assert.equal(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
});

test('a failed key write opens the created connection for retry instead of creating it again', async () => {
  await renderProvidersSettingsSection();
  document.getElementById('settingsProvidersAddButton')!.click();
  Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-providers-preset-btn')).find((button) => button.textContent === 'Anthropic')!.click();
  const form = document.getElementById('settingsProvidersAddForm') as HTMLFormElement;
  form.querySelector<HTMLInputElement>('[name="apiKey"]')!.value = 'test-only-key';
  mutation = async (url, init) => {
    if (url.endsWith('/secrets')) return json({ error: 'Key write failed' }, 500);
    const created = { ...JSON.parse(init?.body as string), hasApiKey: false, hasBearer: false };
    registry.push(created);
    return json(created);
  };
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const created = document.querySelector<HTMLElement>('.settings-providers-row[data-provider-id="anthropic"]')!;
  assert.equal(created.querySelector<HTMLDetailsElement>('details')!.open, true);
  assert.equal(created.querySelector<HTMLInputElement>('[name="apiKey"]')!.value, 'test-only-key');
  assert.match(created.querySelector('[data-provider-edit-error]')!.textContent ?? '', /Retry with Save changes/);
  assert.ok(document.getElementById('settingsProvidersAddPanel')!.classList.contains('hidden'));
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
});

test('custom names get unique IDs, Unicode names get a valid fallback, and manual IDs survive typing', async () => {
  await renderProvidersSettingsSection();
  document.getElementById('settingsProvidersAddButton')!.click();
  document.querySelector<HTMLButtonElement>('.settings-providers-add-custom')!.click();
  const form = document.getElementById('settingsProvidersAddForm')!;
  const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
  const id = form.querySelector<HTMLInputElement>('[name="id"]')!;
  name.value = 'OpenRouter';
  name.dispatchEvent(new win.Event('input'));
  assert.equal(id.value, 'openrouter-2');
  name.value = '模型';
  name.dispatchEvent(new win.Event('input'));
  assert.equal(id.value, 'provider');
  id.value = 'custom-id';
  id.dispatchEvent(new win.Event('input'));
  name.value = 'Another name';
  name.dispatchEvent(new win.Event('input'));
  assert.equal(id.value, 'custom-id');
});

test('manual capability checks do not discard unsaved drafts or send probe requests', async () => {
  await renderProvidersSettingsSection();
  const card = openCard();
  const name = card.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'Unsaved name';
  card.querySelector<HTMLButtonElement>('[data-provider-model-probe]')!.click();
  await settle();
  assert.equal(name.value, 'Unsaved name');
  assert.match(card.querySelector('[data-provider-edit-error]')!.textContent ?? '', /Save changes before checking/);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
});

test('logos use provider identity, including custom names, CLI kinds, and a neutral fallback', () => {
  assert.equal(providerLogoId({ ...connection, id: 'work', label: 'Work API' }), 'openrouter');
  assert.equal(providerLogoId({ ...connection, id: 'custom', label: 'Acme', baseUrl: 'https://acme.example' }), null);
  assert.equal(providerLogoId({ ...connection, apiKind: 'agent-cli-v1', id: 'cursor-agent-cli', baseUrl: '' }), 'cursor');
  assert.equal(providerLogoId({ ...connection, baseUrl: 'https://openrouter.ai.evil.example', id: 'custom', label: 'Acme' }), null);
});
