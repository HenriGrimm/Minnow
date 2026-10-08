import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

const { SETTINGS_SECTION_LABELS, SETTINGS_SECTIONS } = await import('../../src/ui/settings-page-types.ts');
const { categoryForArea, fieldByKey } = await import('../../src/ui/settings-catalog.ts');
const { renderPluginPackagesSection } = await import('../../src/ui/settings-plugin-packages.ts');
let win;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  win = new Window();
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  for (const name of ['window', 'document', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'localStorage', 'Event']) globalThis[name] = name === 'window' ? win : win[name];
  document.body.innerHTML = '<div id="mount"></div>';
});
afterEach(async () => { globalThis.fetch = originalFetch; await win.happyDOM.abort(); });

test('Plugins replaces the Apps settings page and is searchable', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.ok(SETTINGS_SECTIONS.includes('plugins'));
  assert.equal(SETTINGS_SECTION_LABELS.plugins, 'Plugins');
  assert.equal(categoryForArea('plugins'), 'apps');
  assert.equal(fieldByKey('plugins.installed').area, 'plugins');
  assert.equal(fieldByKey('plugins.add').area, 'plugins');
  assert.match(html, /id="settingsPluginsBody"/);
  assert.match(html, /data-area-jump="plugins"/);
  assert.doesNotMatch(html, /id="settingsSection-apps"/);
});

test('empty state exposes the authoring workflow and a labelled install form', async () => {
  globalThis.fetch = async () => Response.json({ revision: 0, packages: [] });
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  assert.match(mount.textContent, /\/build-plugin/);
  assert.match(mount.querySelector('[role="status"]').textContent, /No plugins installed/);
  assert.equal(mount.querySelector('label input').required, true);
  assert.equal(mount.querySelector('button').textContent, 'Review plugin');
  assert.match(mount.querySelector('label').textContent, /GitHub URL or plugin folder/);
  assert.ok([...mount.querySelectorAll('button')].some(button => button.textContent === 'Choose folder'));
  assert.ok(fieldByKey('plugins.add').keywords.includes('github'));
});

const reviewedPlugin = { id: 'remote-demo', name: 'Remote demo', description: 'Example', version: '1.0.0', tools: [], panels: [], skills: [], connections: [] };
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('UI did not finish the requested action');
}

test('GitHub review sends the source and installation sends its reviewed commit and digest', async () => {
  const calls = [];
  let installed = false;
  const source = 'https://github.com/owner/plugin';
  const commit = 'a'.repeat(40);
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/inspect')) return Response.json({ manifest: reviewedPlugin, source, commit, digest: 'reviewed-digest', trust: 'Install only code you trust.' });
    if (url.endsWith('/manage')) { installed = true; return Response.json({ ok: true }); }
    if (url === '/api/plugins/packages') return Response.json({ revision: installed ? 1 : 0, packages: installed ? [{ ...reviewedPlugin, source, enabled: true }] : [] });
    return Response.json({ tools: [], skills: [] });
  };
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  mount.querySelector('input').value = ` ${source} `;
  mount.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => mount.textContent.includes('Trust and install'));
  assert.deepEqual(calls.find(call => call.url.endsWith('/inspect')).body, { source });
  assert.match(mount.querySelector('.plugin-settings__preview').textContent, /Commit aaaaaaa/);
  [...mount.querySelectorAll('button')].find(button => button.textContent === 'Trust and install').click();
  await until(() => installed && mount.querySelector('input').value === '');
  assert.deepEqual(calls.find(call => call.url.endsWith('/manage')).body, { action: 'install', id: reviewedPlugin.id, source, commit, digest: 'reviewed-digest' });
  assert.equal(mount.querySelector('.plugin-settings__preview').textContent, '');
});

test('source changes clear the review and failed downloads leave the form ready to retry', async () => {
  let fail = false;
  globalThis.fetch = async url => url.endsWith('/inspect')
    ? fail ? Response.json({ error: 'GitHub download failed (404).' }, { status: 400 }) : Response.json({ manifest: reviewedPlugin, source: '/plugin', digest: 'digest', trust: 'Trust' })
    : Response.json({ revision: 0, packages: [], tools: [], skills: [] });
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  const input = mount.querySelector('input');
  const form = mount.querySelector('form');
  input.value = '/plugin';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => mount.textContent.includes('Trust and install'));
  input.value = 'https://github.com/owner/missing';
  input.dispatchEvent(new Event('input'));
  assert.equal(mount.querySelector('.plugin-settings__preview').textContent, '');
  fail = true;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await until(() => mount.querySelector('[role="status"]').textContent.includes('404'));
  assert.equal(input.disabled, false);
  assert.equal(form.querySelector('button').disabled, false);
  assert.equal(form.hasAttribute('aria-busy'), false);
});

test('server failures are distinguished from an empty catalog', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  assert.match(mount.querySelector('[role="status"]').textContent, /Cannot load plugins.*Unavailable/);
  assert.doesNotMatch(mount.textContent, /No plugins installed/);
});

test('disabled packages remain manageable and cannot open a panel', async () => {
  globalThis.fetch = async () => Response.json({ revision: 1, packages: [{ id: 'example', name: '<script>unsafe</script>', description: 'Example', version: '1.0.0', enabled: false, source: '/workspace/example', tools: [], panels: [{ id: 'main', title: 'Main' }], skills: [], connections: [] }] });
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  assert.equal(mount.querySelector('script'), null);
  const buttons = [...mount.querySelectorAll('button')];
  assert.ok(buttons.some(b => b.textContent === 'Enable' && !b.disabled));
  assert.ok(buttons.some(b => b.textContent === 'Open Main' && b.disabled));
  assert.ok(buttons.some(b => b.textContent === 'Remove'));
});

test('Choose folder fills the source without changing the workspace and cancellation keeps it', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET' });
    if (url.startsWith('/api/workspace/browse')) return Response.json({ path: '/outside/plugin', parent: '/outside', entries: [] });
    return Response.json({ revision: 0, packages: [], tools: [], skills: [] });
  };
  const mount = document.getElementById('mount');
  await renderPluginPackagesSection(mount);
  const choose = [...mount.querySelectorAll('button')].find(button => button.textContent === 'Choose folder');
  const input = mount.querySelector('input');
  input.value = 'https://github.com/owner/plugin';
  choose.click();
  await until(() => document.getElementById('workspaceFolderPickerOverlay')?.hidden === false || !choose.disabled);
  assert.equal(document.getElementById('workspaceFolderPickerOverlay')?.hidden, false, mount.querySelector('[role="status"]').textContent);
  assert.equal(document.getElementById('workspaceFolderPickerTitle').textContent, 'Choose plugin folder');
  document.querySelector('[data-ws-picker-open]').click();
  await until(() => !choose.disabled);
  assert.equal(input.value, '/outside/plugin');
  assert.match(mount.querySelector('[role="status"]').textContent, /Folder selected/);
  choose.click();
  await until(() => document.getElementById('workspaceFolderPickerOverlay')?.hidden === false);
  document.querySelector('[data-ws-picker-cancel]').click();
  await until(() => !choose.disabled);
  assert.equal(input.value, '/outside/plugin');
  assert.equal(calls.some(call => call.url.startsWith('/api/workspace') && call.method !== 'GET'), false);
});
