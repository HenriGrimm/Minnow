/**
 * Composer Brain notes toggle markup and tri-state persistence.
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
const { resetConfigFileCacheForTests } = await import('../../src/config/config-file-cache.ts');
const { initBrainNotesInjectionControl, syncComposerBrainNotesFromActiveChat } = await import(
  '../../src/ui/composer-brain-notes.ts'
);

function setupDom(): void {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event as typeof Event;

  document.body.innerHTML = `
    <div id="composerBrainNotesWrap" class="composer-control brain-notes-control-wrap hidden">
      <div id="composerBrainNotesControl" class="brain-notes-toggle-host"></div>
    </div>
    <div id="desktopBrainNotesWrap" class="desktop-brain-notes-wrap hidden">
      <div id="desktopBrainNotesControl" class="brain-notes-toggle-host"></div>
    </div>
  `;
}

function teardownDom(): void {
  flushScheduledSessionSaveForTests();
  resetConfigFileCacheForTests();
  setSessionStateForTests(null);
}

describe('composer brain notes HTML', () => {
  test('index.html defines composer brain notes wrap and control', () => {
    assert.match(indexHtml, /id="composerBrainNotesWrap"/);
    assert.match(indexHtml, /id="composerBrainNotesControl"/);
  });
});

describe('syncComposerBrainNotesFromActiveChat', () => {
  afterEach(() => {
    teardownDom();
  });

  test('does not throw before sessions are loaded', async () => {
    setSessionStateForTests(null);
    await assert.doesNotReject(async () => syncComposerBrainNotesFromActiveChat());
  });

  test('cycles chat override on click when memory store enabled', async () => {
    setupDom();
    const chat = createEmptyChatObject('gpt-test');
    chat.id = 'chat-brain-notes-1';
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
          json: async () => ({ features: { memoryInjection: true }, memory: { enabled: true } }),
        } as Response;
      }
      if (url.includes('/api/memory/status')) {
        return { ok: true, json: async () => ({ enabled: true, entryCount: 0, home: '' }) } as Response;
      }
      return { ok: false } as Response;
    };

    initBrainNotesInjectionControl();
    await syncComposerBrainNotesFromActiveChat();

    const buttons = document.querySelectorAll('.brain-notes-toggle-btn');
    assert.equal(buttons.length, 2);
    const btn = buttons[0] as HTMLButtonElement;
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');

    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(chat.brainNotesInjection, 'off');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');

    globalThis.fetch = originalFetch;
    setLocalServerAvailableForTests(false);
  });

  test('hides both toggles when Brain notes injection is disabled in settings', async () => {
    setupDom();
    const chat = createEmptyChatObject('gpt-test');
    chat.id = 'chat-brain-notes-hidden';
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
          json: async () => ({ features: { memoryInjection: false }, memory: { enabled: true } }),
        } as Response;
      }
      if (url.includes('/api/memory/status')) {
        return { ok: true, json: async () => ({ enabled: true, entryCount: 0, home: '' }) } as Response;
      }
      return { ok: false } as Response;
    };

    initBrainNotesInjectionControl();
    await syncComposerBrainNotesFromActiveChat();

    assert.equal(document.querySelectorAll('.brain-notes-toggle-btn').length, 2);
    assert.equal(document.getElementById('composerBrainNotesWrap')?.classList.contains('hidden'), true);
    assert.equal(document.getElementById('composerBrainNotesControl')?.classList.contains('hidden'), true);
    assert.equal(document.getElementById('desktopBrainNotesWrap')?.classList.contains('hidden'), true);
    assert.equal(document.getElementById('desktopBrainNotesControl')?.classList.contains('hidden'), true);

    globalThis.fetch = originalFetch;
    setLocalServerAvailableForTests(false);
  });
});
