import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ManagedServerSummary } from '../../src/servers/client.ts';

const SEARXNG: ManagedServerSummary = {
  id: 'searxng',
  label: 'SearXNG',
  description: 'Local privacy-focused metasearch for Deep Research and web search.',
  kind: 'python-venv',
  healthPath: '/healthz',
  enabled: true,
  autoStart: true,
  port: 8899,
  defaultPort: 8899,
  installed: true,
  version: 'e964708c0',
  running: true,
  phase: 'running',
  job: null,
};

const MLX_UNSUPPORTED: ManagedServerSummary = {
  id: 'mlx-lm',
  label: 'MLX',
  description: 'Metal-native inference for MLX weights on Apple Silicon (mlx-lm).',
  kind: 'python-venv',
  healthPath: '/v1/models',
  enabled: false,
  autoStart: false,
  port: 8087,
  defaultPort: 8087,
  installed: false,
  running: false,
  phase: 'pending',
  job: null,
  supported: false,
  installable: false,
  reason:
    'MLX runs only on Apple Silicon Macs (macOS 13 or later). Use GGUF weights with llama.cpp on this machine.',
};

const LLAMA_CPP: ManagedServerSummary = {
  id: 'llama-cpp',
  label: 'llama.cpp',
  description: 'Local GGUF inference runtime (llama-server).',
  kind: 'native-binary',
  healthPath: '/health',
  enabled: false,
  autoStart: false,
  port: 8085,
  defaultPort: 8085,
  installed: true,
  running: false,
  phase: 'stopped',
  job: null,
};

describe('settings servers section', () => {
  let originalFetch: typeof fetch;
  /** Catalog payload for GET /api/servers — swapped per test. */
  let mockServers: ManagedServerSummary[] = [SEARXNG];

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;

    document.body.innerHTML = `<div id="settingsServersBody" class="settings-section-body"></div>`;

    mockServers = [SEARXNG];

    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/servers') {
        return {
          ok: true,
          json: async () => ({ servers: mockServers }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test('renderServersSettingsSection lists SearXNG row and running status', async () => {
    const mount = document.getElementById('settingsServersBody');
    assert.ok(mount);

    const { renderServersSettingsSection } = await import(
      '../../src/ui/settings-servers-section.ts'
    );
    await renderServersSettingsSection(mount);

    const list = document.getElementById('settingsManagedServerList');
    assert.ok(list);
    const row = list.querySelector<HTMLElement>('[data-server-id="searxng"]');
    assert.ok(row);
    assert.match(row.textContent ?? '', /SearXNG/);
    assert.match(row.textContent ?? '', /Running/);
    assert.match(row.textContent ?? '', /http:\/\/127\.0\.0\.1:8899/);

    const stopBtn = row.querySelector<HTMLButtonElement>('[data-server-stop="searxng"]');
    assert.ok(stopBtn);
    assert.equal(
      row.querySelector('[data-server-install="searxng"]'),
      null,
    );
  });

  test('leaves llama.cpp and MLX to Models → Engine', async () => {
    mockServers = [SEARXNG, MLX_UNSUPPORTED, LLAMA_CPP];
    const mount = document.getElementById('settingsServersBody');
    assert.ok(mount);

    const { renderServersSettingsSection } = await import(
      '../../src/ui/settings-servers-section.ts'
    );
    await renderServersSettingsSection(mount);

    assert.ok(document.querySelector('[data-server-id="searxng"]'));
    assert.equal(document.querySelector('[data-server-id="mlx-lm"]'), null);
    assert.equal(document.querySelector('[data-server-id="llama-cpp"]'), null);
    assert.match(mount.textContent ?? '', /Models → Engine/);
  });
});
