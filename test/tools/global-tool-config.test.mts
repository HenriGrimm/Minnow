import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { normalizeToolConfig, defaultToolConfig, setToolConfigForTests, setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { normalizeToolConfig as normalizeServerConfig } from '../../server/config/validators.js';
import { getEnabledToolCatalogEntries } from '../../src/tools/client.ts';
import { getHeadlessToolDefinitions } from '../../src/headless/execute-tool.ts';
import { buildSettingsSearchIndex } from '../../src/ui/settings-search-index.ts';
import { buildFullFieldRegistry } from '../../src/settings/field-registry.ts';

afterEach(() => {
  setToolConfigForTests(defaultToolConfig());
  setLocalServerAvailableForTests(false);
});

test('client and server drop flat and nested legacy permission maps while retaining operational settings', () => {
  for (const permissions of [{ read_file: 'off' }, { default: { read_file: 'off', plugin__echo__ping: 'ask' } }]) {
    for (const normalize of [normalizeToolConfig, normalizeServerConfig]) {
      const config = normalize({ enabled: { read_file: false }, permissions, keys: { tavilyApiKey: 'fixture' },
        toolCache: { enabled: false }, lazyTools: false, toolOutput: { enabled: false, maxChars: 64000 },
        plugins: { echo: { enabled: false } } });
      assert.equal('permissions' in config, false);
      assert.equal('enabled' in config, false);
      assert.equal(config.keys.tavilyApiKey, 'fixture');
      assert.equal(config.toolCache?.enabled, false);
      assert.equal(config.lazyTools, false);
      assert.equal(config.toolOutput?.maxChars, 64000);
      assert.equal(config.plugins?.echo.enabled, false);
    }
  }
  assert.equal('permissions' in defaultToolConfig(), false);
});

test('renderer and CLI expose server-capable tools regardless of old Off/default toggles', () => {
  setToolConfigForTests(normalizeToolConfig({ enabled: { execute_command: false, list_directory: false },
    permissions: { default: { execute_command: 'off', list_directory: 'off' } } }));
  setLocalServerAvailableForTests(true);
  for (const name of ['execute_command', 'list_directory', 'save_file', 'load_skill']) {
    assert.ok(getEnabledToolCatalogEntries().some(tool => tool.id === name), name);
    assert.ok(getHeadlessToolDefinitions('general').some(tool => tool.function.name === name), name);
  }
});

test('settings APIs expose the global level and no writable per-tool permission keys', () => {
  const fields = buildFullFieldRegistry();
  assert.ok(fields.some(field => field.key === 'general.permissions' && field.writable));
  assert.ok(!fields.some(field => field.key.startsWith('integrations.tools.permission.') || field.key === 'integrations.tools.bulk'));
  assert.ok(!buildSettingsSearchIndex().some(entry => entry.searchKey?.startsWith('tools.item.')));
});

test('Settings, plugin details, and the composer contain no per-tool permission controls', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="(?:composerToolsAnchor|btnChatAppTools|composerOverflowToolsNav|composerOverflowToolsPage|toolsList)"/);
  const settings = await readFile(new URL('../../src/ui/settings-sections.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(settings, /settingsToolsAllFull|settingsToolsResetDefaults|settingsToolsList/);
  const plugins = await readFile(new URL('../../src/ui/settings-plugin-packages.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(plugins, /Ask each time|Full permission|setToolPermission/);
});
