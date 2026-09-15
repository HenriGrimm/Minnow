/**
 * Settings → Tools rows for MCP servers: one group per server, permissions that
 * persist to tools.json, and a readable state when a server never connected.
 */

import assert from 'node:assert/strict';
import { register } from 'node:module';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

register('../test-loader.mjs', import.meta.url);

const {
  invalidateToolConfigCache,
  getToolPermissionForId,
  loadToolConfig,
  setLocalServerAvailable,
  TOOL_CONFIG_STORAGE_KEY,
  flushToolListUiRefresh,
} = await import('../../src/tools/config.ts');
const { fillToolsSection } = await import('../../src/ui/tools-list.ts');
const { appendMcpToolsToList } = await import('../../src/ui/settings-mcp-tools.ts');

const NAVIGATE_ID = 'mcp__playwright__browser_navigate';

const CATALOG = [
  {
    id: 'playwright',
    label: 'Playwright',
    error: null,
    tools: [
      {
        name: 'browser_navigate',
        namespacedName: NAVIGATE_ID,
        description: 'Navigate to a URL',
      },
      {
        name: 'browser_click',
        namespacedName: 'mcp__playwright__browser_click',
        description: 'Click an element',
      },
    ],
  },
  {
    id: 'context7',
    label: 'Context7',
    error: null,
    tools: [
      {
        name: 'resolve-library-id',
        namespacedName: 'mcp__context7__resolve_library_id',
        description: 'Resolve a library id',
      },
    ],
  },
  { id: 'fixture', label: 'Fixture MCP (tests)', error: null, tools: [] },
  { id: 'broken', label: 'Broken server', error: 'spawn npx ENOENT', tools: [] },
];

/** Mount a settings tools list in happy-dom with a stubbed catalog endpoint. */
function setupSettingsToolsList(catalog = CATALOG) {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLSelectElement = window.HTMLSelectElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLLabelElement = window.HTMLLabelElement;
  globalThis.Event = window.Event;
  globalThis.localStorage = window.localStorage;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), '/api/mcp/tools/catalog');
    return { ok: true, json: async () => ({ servers: catalog }) };
  };

  invalidateToolConfigCache();
  setLocalServerAvailable(true);
  document.body.innerHTML = '<div id="settingsToolsList"></div>';
  fillToolsSection('settingsToolsList', { variant: 'settings' });
}

function groupFor(serverId) {
  return document.querySelector(`[data-tool-category="mcp:${serverId}"]`);
}

afterEach(() => {
  invalidateToolConfigCache();
  delete globalThis.fetch;
});

describe('MCP tool permission rows', () => {
  test('renders one group per connected server', async () => {
    setupSettingsToolsList();
    await appendMcpToolsToList('settingsToolsList');

    assert.ok(groupFor('playwright'), 'playwright group missing');
    assert.ok(groupFor('context7'), 'context7 group missing');
    assert.equal(groupFor('fixture'), null, 'test fixture server should stay hidden');

    const rows = groupFor('playwright').querySelectorAll('[data-tool-id]');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].getAttribute('data-tool-id'), NAVIGATE_ID);
    assert.equal(
      rows[0].querySelector('.tool-label').textContent,
      'browser_navigate',
      'row shows the spelling the server exposes',
    );
    assert.equal(
      groupFor('playwright').querySelector('.tool-group-count').textContent,
      '2 tools',
    );
  });

  test('added servers are approved without per-tool controls, including legacy overrides', async () => {
    setupSettingsToolsList();
    await appendMcpToolsToList('settingsToolsList');
    const row = document.querySelector(`[data-tool-id="${NAVIGATE_ID}"]`);
    assert.equal(row.querySelector('select'), null);
    const config = loadToolConfig();
    for (const mode of ['ask', 'off', 'full']) {
      config.permissions.default[NAVIGATE_ID] = mode;
      assert.equal(getToolPermissionForId(config, NAVIGATE_ID), 'full');
    }
  });

  test('a server that never started explains itself instead of vanishing', async () => {
    setupSettingsToolsList();
    await appendMcpToolsToList('settingsToolsList');

    const group = groupFor('broken');
    assert.ok(group);
    assert.equal(group.querySelector('.tool-group-count').textContent, 'Not connected');
    assert.match(group.querySelector('.tool-group-hint').textContent, /spawn npx ENOENT/);
  });

  test('re-rendering replaces groups instead of duplicating rows', async () => {
    setupSettingsToolsList();
    await appendMcpToolsToList('settingsToolsList');
    await appendMcpToolsToList('settingsToolsList');

    assert.equal(document.querySelectorAll(`[data-tool-id="${NAVIGATE_ID}"]`).length, 1);
    assert.equal(document.querySelectorAll('[data-tool-category^="mcp:"]').length, 3);
  });
});
