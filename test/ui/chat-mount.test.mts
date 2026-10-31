/**
 * Chat mount / composer foreground resolution (MIN-171).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances.ts';
import {
  initOsPageBridge,
  resetOsPageBridgeForTests,
} from '../../src/os/page-bridge.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';

function setupDom(win: import('happy-dom').Window): void {
  win.document.body.innerHTML = `
    <main id="chatView" class="chat-app-page is-open"></main>
    <textarea id="msgInput"></textarea>
    <textarea id="chatAppInput"></textarea>
    <button id="sendBtn"></button>
    <button id="chatAppSendBtn"></button>
  `;
}

describe('chat-mount foreground', () => {
  let domWindow: import('happy-dom').Window;
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    domWindow = win;
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      HTMLElement: typeof HTMLElement;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    setupDom(win);
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    initOsPageBridge();
  });

  afterEach(async () => {
    await import('../../src/state/issues-store.ts');
    setSessionStateForTests(null);
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    await domWindow.happyDOM.close();
  });

  test('isChatAppForeground is false when Code is foreground but chatView stays is-open', async () => {
    const { isChatAppForeground } = await import('../../src/ui/chat-mount.ts');
    const { getActiveComposerSurface } = await import('../../src/ui/composer-surface.ts');

    assert.equal(isChatAppForeground(), true);

    launchInstance('code');

    assert.equal(isChatAppForeground(), false);
    assert.equal(getActiveComposerSurface().inputEl?.id, 'msgInput');
  });

  test('isChatAppForeground stays true for legacy chatView.is-open without OS foreground', async () => {
    resetOsPageBridgeForTests();
    const { isChatAppForeground } = await import('../../src/ui/chat-mount.ts');

    assert.equal(isChatAppForeground(), true);
  });
});
