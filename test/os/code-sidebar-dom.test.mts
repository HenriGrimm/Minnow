import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  resetAppHostForTests,
  shouldDeferAppLayerReveal,
} from '../../src/os/app-host.ts';
import { resetInstancesForTests } from '../../src/os/instances.ts';
import {
  initOsPageBridge,
  resetOsPageBridgeForTests,
  shouldHideAppBody,
} from '../../src/os/page-bridge.ts';
import {
  initOsRouter,
  resetOsRouterForTests,
  syncOsRouteFromHashForTests,
} from '../../src/os/router.ts';
import { initOsShell } from '../../src/os/shell.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from './dom-helpers.mts';

function setupCodeShellDom(doc: Document): void {
  doc.body.innerHTML = `
    <div id="minnowOsRoot" class="mn-os"></div>
    <header class="topbar"></header>
    <div class="app-body" id="appBody">
      <aside class="chat-sidebar" id="chatSidebar"></aside>
      <div class="main-column" id="mainColumn"><main id="chatArea"></main></div>
      <aside class="file-sidebar" id="fileSidebar"></aside>
    </div>
    <div id="welcomeView" hidden></div>
    <textarea id="msgInput"></textarea>
    <input type="file" id="fileInput" />
  `;
}

describe('code app sidebar DOM', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    win.fetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    installHappyDomGlobals(win, { fetch: win.fetch });
    setupCodeShellDom(win.document);
    win.location.hash = '#/app/code/chat';

    resetInstancesForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
    resetAppHostForTests();

    initOsPageBridge();
    initOsShell();
    initOsRouter();
    syncOsRouteFromHashForTests();
  });

  afterEach(async () => {
    resetOsRouterForTests();
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    resetAppHostForTests();
    if (happyDomWindow) await teardownHappyDomAsync(happyDomWindow);
  });

  test('keeps Code hidden until its lazy workspace layout is ready', () => {
    assert.equal(shouldDeferAppLayerReveal('code'), true);
  });

  test('keeps sidebars under #appBody when the Code layer is mounted', () => {
    assert.equal(shouldHideAppBody(), false);
    const appBody = document.getElementById('appBody');
    assert.ok(appBody);
    assert.equal(appBody.classList.contains('hidden'), false);

    const codeLayer = document.getElementById('osAppLayer-code');
    assert.ok(codeLayer);
    assert.equal(appBody.parentElement?.id, 'osAppLayer-code');

    const chat = document.getElementById('chatSidebar');
    const file = document.getElementById('fileSidebar');
    assert.equal(chat?.parentElement, appBody);
    assert.equal(file?.parentElement, appBody);
  });

  test('keeps the left app rail visible while Code is foreground', () => {
    const rail = document.getElementById('osAppRail');
    assert.ok(rail);
    assert.equal(rail.hidden, false);
    assert.ok(rail.querySelectorAll('.mn-os-app-rail__btn').length > 0);
  });
});
