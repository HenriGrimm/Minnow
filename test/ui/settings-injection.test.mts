/** Main Settings → Agents → Injection renders all optional prompt sources. */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { resetConfigFileCacheForTests } = await import(
  '../../src/config/config-file-cache.ts'
);
const { setStorageModeForTests } = await import('../../src/config/storage-mode.ts');
const { renderInjectionSettingsSection } = await import(
  '../../src/ui/settings-injection.ts'
);
const originalFetch = globalThis.fetch;

function setupDom(): HTMLElement {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Element = win.Element;

  document.body.innerHTML = '<div id="settingsInjectionBody"></div>';
  const mount = document.getElementById('settingsInjectionBody');
  assert.ok(mount);
  return mount;
}

describe('settings injection section', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetConfigFileCacheForTests();
    setStorageModeForTests(null);
  });

  test('renders Brain notes, code map, and context document settings together', async () => {
    const mount = setupDom();
    setStorageModeForTests('server');
    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          features: {
            memoryInjection: true,
            codeMapInjectionDefault: true,
            contextDocumentsInjectionDefault: true,
          },
          contextDocuments: {
            enabledPresets: ['agents-md'],
            customPaths: ['docs/CONTRIBUTING.md'],
          },
        }),
      }) as Response;

    await renderInjectionSettingsSection(mount, () => {});

    assert.ok(document.getElementById('settingsBrainNotesInjectionDefault'));
    assert.ok(document.getElementById('settingsCodeMapInjectionDefault'));
    assert.ok(document.getElementById('settingsContextDocumentsInjectionDefault'));
    assert.equal(
      mount.querySelector('[data-settings-search-key="agents.injection.contextDocuments"]') !==
        null,
      true,
    );
    assert.match(mount.textContent ?? '', /Workspace context documents/);
    assert.match(mount.textContent ?? '', /Custom paths/);

    globalThis.fetch = originalFetch;
  });
});
