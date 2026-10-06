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
  for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'localStorage', 'Event']) globalThis[name] = name === 'window' ? win : win[name];
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
