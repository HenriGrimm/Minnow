import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('settings-sections', () => {
  test('exports refreshSettingsSection for settings page wiring', async () => {
    const mod = await import('../../src/ui/settings-sections.ts');
    assert.equal(typeof mod.refreshSettingsSection, 'function');
  });

  test("refreshSettingsSection('servers') renders managed server list", async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;

    document.body.innerHTML = `
      <div id="settingsServersBody" class="settings-section-body"></div>
    `;

    const mockServers = [
      {
        id: 'searxng',
        label: 'SearXNG',
        description: 'Local metasearch',
        kind: 'python-venv',
        healthPath: '/healthz',
        enabled: false,
        autoStart: true,
        port: 8899,
        defaultPort: 8899,
        installed: true,
        version: 'e964708c0',
        running: false,
        phase: 'stopped',
        job: null,
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === '/api/servers') {
        return {
          ok: true,
          json: async () => ({ servers: mockServers }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const { setLocalServerAvailable } = await import('../../src/tools/config.ts');
    setLocalServerAvailable(true);

    const { refreshSettingsSection } = await import('../../src/ui/settings-sections.ts');
    await refreshSettingsSection('servers');

    const list = document.getElementById('settingsManagedServerList');
    assert.ok(list);
    const row = list.querySelector('[data-server-id="searxng"]');
    assert.ok(row);
    assert.match(row.textContent ?? '', /SearXNG/);

    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test("concurrent refreshSettingsSection('general') does not duplicate groups", async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;

    document.body.innerHTML = `
      <div id="settingsGeneralBody" class="settings-section-body"></div>
    `;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/config/ping') || url.includes('/api/providers')) {
        return {
          ok: true,
          json: async () => (url.includes('providers') ? { providers: [] } : { ok: true }),
        };
      }
      if (url.includes('/api/config')) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, json: async () => ({}) };
    };

    const { refreshSettingsSection } = await import('../../src/ui/settings-sections.ts');
    await Promise.all([
      refreshSettingsSection('general'),
      refreshSettingsSection('general'),
    ]);

    const mount = document.getElementById('settingsGeneralBody');
    assert.ok(mount);
    assert.ok(mount.querySelector('.settings-general'), 'General section uses constrained shell');
    const updateGroups = mount.querySelectorAll('#settingsDesktopShell');
    assert.equal(updateGroups.length, 1, 'Desktop settings should appear once');

    globalThis.fetch = originalFetch;
    document.body.innerHTML = '';
  });

  test("refreshSettingsSection('notifications') uses constrained shell and emphasis groups", async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;

    document.body.innerHTML = `
      <div id="settingsNotificationsBody" class="settings-section-body"></div>
    `;

    const { refreshSettingsSection } = await import('../../src/ui/settings-sections.ts');
    await refreshSettingsSection('notifications');

    const mount = document.getElementById('settingsNotificationsBody');
    assert.ok(mount);
    assert.ok(mount.querySelector('.settings-general'), 'Notifications section uses constrained shell');
    assert.ok(
      mount.querySelector('.settings-group--emphasis'),
      'Notifications section uses emphasis panels',
    );
    assert.equal(
      mount.querySelectorAll('.settings-group--emphasis').length,
      2,
      'Alerts and sound groups should be bordered panels',
    );

    document.body.innerHTML = '';
  });

  test("refreshSettingsSection('audio') uses constrained shell and emphasis groups", async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.localStorage = window.localStorage;

    document.body.innerHTML = `
      <div id="settingsAudioBody" class="settings-section-body"></div>
    `;

    const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
    const { resetVoiceMetaCache } = await import('../../src/config/voice-meta.ts');
    setStorageModeForTests('server');
    resetVoiceMetaCache();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/config/ping')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url.includes('/api/config/meta')) {
        return {
          ok: true,
          json: async () => ({
            voice: {
              audio: {
                inputDeviceId: '',
                outputDeviceId: '',
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    };

    const { refreshSettingsSection } = await import('../../src/ui/settings-sections.ts');
    await refreshSettingsSection('audio');

    const mount = document.getElementById('settingsAudioBody');
    assert.ok(mount);
    assert.ok(mount.querySelector('.settings-general'), 'Audio section uses constrained shell');
    assert.equal(
      mount.querySelectorAll('.settings-group--emphasis').length,
      2,
      'Devices and processing groups should be bordered panels',
    );
    assert.ok(document.getElementById('settingsAudioInputDevice'));
    assert.ok(document.getElementById('settingsAudioEchoCancellation'));

    globalThis.fetch = originalFetch;
    setStorageModeForTests('localStorage');
    resetVoiceMetaCache();
    document.body.innerHTML = '';
  });
});
