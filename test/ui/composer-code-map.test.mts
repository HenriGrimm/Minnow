/**
 * Composer code map toggle markup and tri-state persistence.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

const { setSessionStateForTests, createEmptyChatObject, flushScheduledSessionSaveForTests } =
  await import('../../src/state/sessions.ts');
const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
const { resetConfigFileCacheForTests } = await import('../../src/config/config-file-cache.ts');
const { initCodeMapInjectionControl, syncComposerCodeMapFromActiveChat } = await import(
  '../../src/ui/composer-code-map.ts'
);

function setupDom(): void {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event as typeof Event;

  document.body.innerHTML = `
    <div id="composerCodeMapWrap" class="composer-control code-map-control-wrap hidden">
      <div id="composerCodeMapControl" class="code-map-toggle-host"></div>
    </div>
  `;
}

function teardownDom(): void {
  flushScheduledSessionSaveForTests();
  resetConfigFileCacheForTests();
  setSessionStateForTests(null);
}

describe('composer code map HTML', () => {
  test('index.html defines composer code map wrap and control', () => {
    assert.match(indexHtml, /id="composerCodeMapWrap"/);
    assert.match(indexHtml, /id="composerCodeMapControl"/);
  });
});

describe('syncComposerCodeMapFromActiveChat', () => {
  afterEach(() => {
    teardownDom();
  });

  test('does not throw before sessions are loaded', async () => {
    setSessionStateForTests(null);
    await assert.doesNotReject(async () => syncComposerCodeMapFromActiveChat());
  });

  test('cycles chat override on click when workspace and code index enabled', async () => {
    setupDom();
    const chat = createEmptyChatObject('gpt-test');
    chat.id = 'chat-codemap-1';
    chat.workspacePath = 'C:/repo';
    setWorkspaceFromServer('C:/repo');
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const originalFetch = globalThis.fetch;
    const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
    setLocalServerAvailableForTests(true);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/config/file')) {
        return {
          ok: true,
          json: async () => ({ features: { codeMapInjectionDefault: true } }),
        } as Response;
      }
      if (url.includes('/api/brain/code/config')) {
        return {
          ok: true,
          json: async () => ({ code: { enabled: true, repoMapTokenBudget: 1500 } }),
        } as Response;
      }
      return { ok: false } as Response;
    };

    initCodeMapInjectionControl();
    await syncComposerCodeMapFromActiveChat();

    const btn = document.querySelector('.code-map-toggle-btn') as HTMLButtonElement;
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');

    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chat.codeMapInjection, 'off');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');

    globalThis.fetch = originalFetch;
    setLocalServerAvailableForTests(false);
  });

  test('hides the toggle when the Brain default is disabled', async () => {
    setupDom();
    const chat = createEmptyChatObject('gpt-test');
    chat.id = 'chat-codemap-hidden';
    chat.workspacePath = 'C:/repo';
    setWorkspaceFromServer('C:/repo');
    setSessionStateForTests({
      version: 2,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const originalFetch = globalThis.fetch;
    const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
    setLocalServerAvailableForTests(true);
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/config/file')) {
        return {
          ok: true,
          json: async () => ({ features: { codeMapInjectionDefault: false } }),
        } as Response;
      }
      if (url.includes('/api/brain/code/config')) {
        return {
          ok: true,
          json: async () => ({ code: { enabled: true, repoMapTokenBudget: 1500 } }),
        } as Response;
      }
      return { ok: false } as Response;
    };

    initCodeMapInjectionControl();
    await syncComposerCodeMapFromActiveChat();

    assert.ok(document.querySelector('.code-map-toggle-btn'));
    assert.equal(document.getElementById('composerCodeMapWrap')?.classList.contains('hidden'), true);
    assert.equal(document.getElementById('composerCodeMapControl')?.classList.contains('hidden'), true);

    globalThis.fetch = originalFetch;
    setLocalServerAvailableForTests(false);
  });
});
