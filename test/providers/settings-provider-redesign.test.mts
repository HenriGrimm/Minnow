import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { invalidateProviderCache } from '../../src/providers/store.ts';
import { providerLogoId } from '../../src/providers/identity.ts';
import type { ProviderPublic } from '../../src/providers/types.ts';
import { closeProviderEditor, createProviderSettingsRow, renderProvidersSettingsSection } from '../../src/ui/settings-providers.ts';

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

function openEditor(): HTMLElement {
  document.querySelector<HTMLButtonElement>('.settings-providers-edit')!.click();
  return document.querySelector<HTMLElement>('.settings-providers-editor')!;
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
  document.body.innerHTML = '<select id="modelSelect"></select><div id="settingsProvidersBody"></div>';
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
  document.querySelector('.settings-providers-list')?.remove();
  closeProviderEditor();
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

test('the editor keeps labeled fields out of the list and retains the form across reopen', () => {
  const row = createProviderSettingsRow(connection, false);
  document.body.append(row);
  const card = openEditor();
  const form = card.querySelector('form')!;
  const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'My draft';
  const advanced = form.querySelector<HTMLElement>('.settings-providers-advanced-content')!;
  assert.equal(advanced.hidden, true);
  assert.ok(advanced.querySelector('[name="apiKind"]'));
  assert.ok(advanced.querySelector('[name="modelsPath"]'));
  assert.equal(form.querySelector('input[name="apiKey"]')?.getAttribute('type'), 'password');
  assert.ok(form.querySelector(`label[for="${name.id}"]`));
  assert.equal(form.querySelector('[data-provider-remove]'), null);
  assert.equal(row.querySelector('form'), null);
  assert.equal(card.getAttribute('role'), 'dialog');
  card.querySelector<HTMLButtonElement>('[data-tab-id="advanced"]')!.click();
  assert.equal(advanced.hidden, false);
  closeProviderEditor();
  assert.equal(document.activeElement, row.querySelector('.settings-providers-edit'));
  assert.equal(openEditor().querySelector('form'), form);
  assert.equal(name.value, 'My draft');
  name.value = name.defaultValue;
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
  const card = openEditor();
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
  assert.match(status.textContent ?? '', /Wait for changes to save before testing/);
  assert.equal(requests.length, count);
  input.value = input.defaultValue;
  modelResponse = { data: [], unreachable: true, error: 'Server unavailable' };
  button.click();
  await settle();
  assert.equal(status.textContent, 'Server unavailable');
  assert.equal(status.dataset.tone, 'error');
  assert.equal(button.disabled, false);
});

test('row tests use one compact result and share full feedback with the editor', async () => {
  await renderProvidersSettingsSection();
  const button = document.querySelector<HTMLButtonElement>('.models-provider-test')!;
  const result = document.querySelector<HTMLElement>('.models-provider-result')!;
  button.click();
  assert.equal(result.textContent, 'Testing…');
  assert.equal(button.textContent, 'Test');
  await settle();
  assert.equal(result.textContent, '2 models');
  const card = openEditor();
  const status = card.querySelector('[data-provider-connection-status]')!;
  assert.equal(status.textContent, 'Connected. 2 models available.');

  modelResponse = { unreachable: true, error: 'The saved server URL timed out while fetching its model catalog.' };
  card.querySelector<HTMLButtonElement>('[data-provider-test]')!.click();
  assert.equal(button.disabled, true);
  await settle();
  assert.equal(result.textContent, 'Connection failed');
  assert.equal(result.title, modelResponse.error);
  assert.equal(status.textContent, result.title);
  assert.equal(button.disabled, false);
});

test('the API provider switch rolls back on failure and saves independently of the editor', async () => {
  registry.push({ ...connection, id: 'custom', label: 'Custom' });
  await renderProvidersSettingsSection();
  const row = document.querySelector<HTMLElement>('[data-provider-id="openrouter"]')!;
  const toggle = row.querySelector<HTMLInputElement>('[role="switch"]')!;
  assert.equal(toggle.checked, true);
  assert.equal(toggle.closest('summary'), null);
  toggle.click();
  await settle();
  assert.equal(toggle.checked, true);
  assert.equal(row.dataset.enabled, 'true');
  assert.equal(row.querySelector('form'), null);

  const card = openEditor();
  const name = card.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'Unsaved name';
  mutation = async (_url, init) => {
    registry[0] = { ...registry[0], ...JSON.parse(init?.body as string) };
    return json(registry[0]);
  };
  toggle.click();
  await settle();
  assert.deepEqual(JSON.parse(requests.filter((request) => request.method === 'PUT').at(-1)!.body!), { enabled: false });
  assert.equal(toggle.checked, false);
  assert.equal(row.dataset.enabled, 'false');
  assert.equal(card.isConnected, true);
  assert.equal(name.value, 'Unsaved name');
  assert.equal(card.querySelector('[name="enabled"]'), null);

  await renderProvidersSettingsSection();
  assert.equal(document.querySelector<HTMLInputElement>('[data-provider-id="openrouter"] [role="switch"]')!.checked, false);
});

test('subscription switches use the CLI enable endpoint', async () => {
  const provider: ProviderPublic = {
    ...connection, id: 'codex-cli', label: 'Codex CLI', baseUrl: '', enabled: false, apiKind: 'agent-cli-v1',
    agentCli: { kind: 'codex', allowUtilityRoles: false, maxConcurrent: 1, sessionMode: 'auto' },
  };
  registry.push(provider);
  await renderProvidersSettingsSection();
  const toggle = document.querySelector<HTMLInputElement>('[data-provider-id="codex-cli"] [role="switch"]')!;
  mutation = async () => {
    provider.enabled = true;
    return json({ agentCli: { enabled: true } });
  };
  toggle.click();
  await settle();
  const writes = requests.filter((request) => request.method !== 'GET' && !request.url.endsWith('/capabilities/probe'));
  assert.deepEqual(writes.map(({ url, method, body }) => [url, method, JSON.parse(body!)]), [
    ['/api/models/agent-clis/codex/enable', 'POST', { enabled: true }],
  ]);
  assert.equal(toggle.checked, true);
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
  assert.ok(created.querySelector('.settings-providers-edit'));
  const editor = document.querySelector('.settings-providers-editor')!;
  assert.equal(editor.querySelector<HTMLInputElement>('[name="apiKey"]')!.value, 'test-only-key');
  assert.match(editor.querySelector('[data-provider-edit-error]')!.textContent ?? '', /Press Enter in the key field to retry/);
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

test('custom provider exposes OpenAI v1 and tests the draft before persisting it', async () => {
  await renderProvidersSettingsSection();
  document.getElementById('settingsProvidersAddButton')!.click();
  document.querySelector<HTMLButtonElement>('.settings-providers-add-custom')!.click();
  const form = document.querySelector<HTMLFormElement>('#settingsProvidersAddForm')!;
  const kind = form.querySelector<HTMLSelectElement>('[name="apiKind"]')!;
  const baseUrl = form.querySelector<HTMLInputElement>('[name="baseUrl"]')!;
  const key = form.querySelector<HTMLInputElement>('[name="apiKey"]')!;
  const status = form.querySelector<HTMLElement>('[data-provider-draft-connection-status]')!;
  const testConnection = form.querySelector<HTMLButtonElement>('#settingsProvidersAddTest')!;
  assert.equal(kind.value, 'openai-v1');
  assert.equal(kind.closest('details'), null);
  assert.equal(form.querySelector<HTMLInputElement>('[name="chatCompletionsPath"]')!.value, '/v1/chat/completions');
  baseUrl.value = 'http://localhost:18772';
  key.value = 'fixture-key';
  mutation = async () => json({ modelCount: 1 });
  testConnection.click();
  await settle();
  assert.equal(status.textContent, 'Connected. 1 model available.');
  const posts = requests.filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/providers/connection/test');
  assert.deepEqual(JSON.parse(posts[0].body!), {
    baseUrl: 'http://localhost:18772', apiKind: 'openai-v1', authStyle: 'bearer',
    modelsPath: '/v1/models', apiKey: 'fixture-key',
  });
  kind.value = 'lm-studio-v0';
  kind.dispatchEvent(new win.Event('change', { bubbles: true }));
  assert.equal(status.hidden, true);
  assert.equal(form.querySelector<HTMLInputElement>('[name="modelsPath"]')!.value, '/api/v0/models');
});

test('editing a draft connection suppresses results from an earlier test', async () => {
  await renderProvidersSettingsSection();
  document.getElementById('settingsProvidersAddButton')!.click();
  document.querySelector<HTMLButtonElement>('.settings-providers-add-custom')!.click();
  const form = document.querySelector<HTMLFormElement>('#settingsProvidersAddForm')!;
  const baseUrl = form.querySelector<HTMLInputElement>('[name="baseUrl"]')!;
  const status = form.querySelector<HTMLElement>('[data-provider-draft-connection-status]')!;
  const testConnection = form.querySelector<HTMLButtonElement>('#settingsProvidersAddTest')!;
  let complete!: (response: Response) => void;
  mutation = async () => new Promise((resolve) => { complete = resolve; });
  baseUrl.value = 'http://localhost:18772';
  testConnection.click();
  baseUrl.value = 'http://localhost:18773';
  baseUrl.dispatchEvent(new win.Event('input', { bubbles: true }));
  complete(json({ modelCount: 1 }));
  await settle();
  assert.equal(status.hidden, true);
  assert.equal(testConnection.disabled, false);
});

test('manual capability checks do not discard unsaved drafts or send probe requests', async () => {
  await renderProvidersSettingsSection();
  const card = openEditor();
  const name = card.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'Unsaved name';
  card.querySelector<HTMLButtonElement>('[data-provider-model-probe]')!.click();
  await settle();
  assert.equal(name.value, 'Unsaved name');
  assert.match(card.querySelector('[data-provider-edit-error]')!.textContent ?? '', /Wait for changes to save before checking/);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
});

test('provider edits auto-save in place and keep connection actions working after saving', async () => {
  registry.push({ ...connection, id: 'custom', label: 'Custom' });
  await renderProvidersSettingsSection();
  const card = openEditor();
  const form = card.querySelector<HTMLFormElement>('form')!;
  assert.equal(form.querySelector('button[type="submit"]'), null);
  assert.ok(form.querySelector('[data-provider-remove]'));
  mutation = async (url, init) => {
    if (url.endsWith('/secrets')) return json({ ok: true });
    registry[0] = { ...registry[0], ...JSON.parse(init?.body as string) };
    return json(registry[0]);
  };
  const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
  name.value = 'My OpenRouter';
  const key = form.querySelector<HTMLInputElement>('[name="apiKey"]')!;
  key.value = 'test-only-key';
  key.dispatchEvent(new win.Event('change', { bubbles: true }));
  key.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));

  const profileWrites = requests.filter((request) => request.url === '/api/providers/openrouter' && request.method === 'PUT');
  assert.equal(profileWrites.length, 1, JSON.stringify(profileWrites));
  assert.equal(Object.hasOwn(JSON.parse(profileWrites[0].body!), 'enabled'), false);
  assert.equal(requests.filter((request) => request.url.endsWith('/secrets') && request.method === 'PUT').length, 1);
  assert.equal(card.querySelector('form'), form);
  assert.equal(card.isConnected, true);
  assert.equal(card.querySelector('.mn-dialog__title')!.textContent, 'My OpenRouter');
  const row = document.querySelector('[data-provider-id="openrouter"]')!;
  assert.equal(row.querySelector('.settings-providers-edit')!.getAttribute('aria-label'), 'Edit My OpenRouter');
  assert.equal(row.querySelector('[role="switch"]')?.getAttribute('aria-label'), 'Enable My OpenRouter');
  assert.equal(key.value, '');
  assert.equal(form.querySelector('[data-provider-key-hint]')!.textContent, 'Key saved');
  assert.equal(form.querySelector('[data-provider-edit-status]')!.textContent, 'Saved', form.querySelector('[data-provider-edit-error]')!.textContent ?? '');
  form.querySelector<HTMLButtonElement>('[data-provider-test]')!.click();
  await settle();
  assert.equal(form.querySelector('[data-provider-connection-status]')!.textContent, 'Connected. 2 models available.');
});

test('provider autosave serializes edits, preserves newer drafts, and keeps failures visible', async () => {
  await renderProvidersSettingsSection();
  const card = openEditor();
  const form = card.querySelector<HTMLFormElement>('form')!;
  const name = form.querySelector<HTMLInputElement>('[name="label"]')!;
  let finish!: (response: Response) => void;
  mutation = async (_url, init) => {
    registry[0] = { ...registry[0], ...JSON.parse(init?.body as string) };
    return new Promise((resolve) => { finish = resolve; });
  };
  name.value = 'First name';
  name.dispatchEvent(new win.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(form.getAttribute('aria-busy'), 'true');
  name.value = 'Second name';
  name.dispatchEvent(new win.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 1);
  mutation = async () => json({ error: 'Save rejected' }, 400);
  finish(json(registry[0]));
  await settle();
  assert.equal(name.value, 'Second name');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const writes = requests.filter((request) => request.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1].body!).label, 'Second name');
  assert.equal(name.value, 'Second name');
  assert.match(form.querySelector('[data-provider-edit-error]')!.textContent ?? '', /Save rejected/);
  assert.equal(form.querySelector('[data-provider-edit-status]')!.textContent, 'Could not save changes.');
  assert.equal(form.hasAttribute('aria-busy'), false);
  assert.equal(form.querySelector<HTMLButtonElement>('[data-provider-test]')!.disabled, false);
});

test('logos use provider identity, including custom names, CLI kinds, and a neutral fallback', () => {
  assert.equal(providerLogoId({ ...connection, id: 'work', label: 'Work API' }), 'openrouter');
  assert.equal(providerLogoId({ ...connection, id: 'work', label: 'Work API', baseUrl: 'https://api.anthropic.com' }), 'claude');
  assert.equal(providerLogoId({ ...connection, id: 'custom', label: 'Acme', baseUrl: 'https://acme.example' }), null);
  assert.equal(providerLogoId({ ...connection, apiKind: 'agent-cli-v1', id: 'cursor-agent-cli', baseUrl: '' }), 'cursor');
  assert.equal(providerLogoId({ ...connection, baseUrl: 'https://openrouter.ai.evil.example', id: 'custom', label: 'Acme' }), null);
});
