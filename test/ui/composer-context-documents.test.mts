/** Composer context documents toggle visibility follows the global injection setting. */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const { setSessionStateForTests, createEmptyChatObject, flushScheduledSessionSaveForTests } =
  await import('../../src/state/sessions.ts');
const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
const { resetConfigFileCacheForTests } = await import('../../src/config/config-file-cache.ts');
const {
  initContextDocumentsInjectionControl,
  syncComposerContextDocumentsFromActiveChat,
} = await import('../../src/ui/composer-context-documents.ts');

function setupDom(): void {
  const win = new Window();
  globalThis.document = win.document as unknown as Document;
  globalThis.window = win as unknown as Window & typeof globalThis.window;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event as typeof Event;

  document.body.innerHTML = `
    <div id="composerContextDocumentsWrap" class="composer-control context-documents-control-wrap hidden">
      <div id="composerContextDocumentsControl" class="context-documents-toggle-host"></div>
    </div>
  `;
}

function teardownDom(): void {
  flushScheduledSessionSaveForTests();
  resetConfigFileCacheForTests();
  setSessionStateForTests(null);
}

describe('syncComposerContextDocumentsFromActiveChat', () => {
  afterEach(() => {
    teardownDom();
  });

  test('hides the toggle when context document injection is disabled in settings', async () => {
    setupDom();
    const chat = createEmptyChatObject('gpt-test');
    chat.id = 'chat-context-docs-hidden';
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
          json: async () => ({
            features: { contextDocumentsInjectionDefault: false },
            contextDocuments: { enabledPresets: ['agents-md'], customPaths: [] },
          }),
        } as Response;
      }
      return { ok: false } as Response;
    };

    initContextDocumentsInjectionControl();
    await syncComposerContextDocumentsFromActiveChat();

    assert.ok(document.querySelector('.context-documents-toggle-btn'));
    assert.equal(
      document.getElementById('composerContextDocumentsWrap')?.classList.contains('hidden'),
      true,
    );
    assert.equal(
      document.getElementById('composerContextDocumentsControl')?.classList.contains('hidden'),
      true,
    );

    globalThis.fetch = originalFetch;
    setLocalServerAvailableForTests(false);
  });
});
