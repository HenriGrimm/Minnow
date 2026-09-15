import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('MCP settings import standard JSON and show provider sign-in', async () => {
  const window = new Window();
  for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'localStorage']) {
    globalThis[name] = name === 'window' ? window : window[name];
  }
  document.body.innerHTML = '<div id="settingsMcpBody"></div>';
  const originalFetch = globalThis.fetch;
  let imported;
  let completed;
  const saved = new Promise(resolve => { completed = resolve; });
  globalThis.fetch = async (url, options) => {
    if (url === '/api/mcp/servers' && options?.method === 'POST') {
      imported = JSON.parse(options.body);
      return { ok: true, json: async () => ({ servers: [] }) };
    }
    if (url === '/api/mcp/servers') return { ok: true, json: async () => ({ servers: [{ id: 'remote', label: 'Remote', enabled: true, connected: false, authorizationUrl: 'https://example.com/authorize' }] }) };
    if (url === '/api/mcp/secrets') return { ok: true, json: async () => ({ hasContext7ApiKey: false }) };
    if (url === '/api/mcp/tools') { completed(); return { ok: true, json: async () => ({ tools: [] }) }; }
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);
    const { refreshSettingsSection } = await import('../../src/ui/settings-sections.ts');
    await refreshSettingsSection('mcp');
    assert.equal(document.querySelector('#settingsMcpAddCommand'), null);
    assert.equal(document.querySelector('#settingsMcpServerList a').textContent, 'Sign in');
    const payload = { mcpServers: { remote: { url: 'https://example.com/mcp' } } };
    document.querySelector('#settingsMcpAddJson').value = JSON.stringify(payload);
    document.querySelector('#settingsMcpAddForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await saved;
    assert.deepEqual(imported, payload);
    await window.happyDOM.waitUntilComplete();
    assert.equal(document.querySelector('#settingsMcpAddJson').value, '');
  } finally {
    globalThis.fetch = originalFetch;
    await window.happyDOM.close();
  }
});
