import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  CODE_PRIMARY_PANE_MIN_W,
  isCodeFileOverlayLayout,
  shouldUseCodeFileOverlay,
  syncCodeResponsiveLayout,
} from '../../src/ui/code-responsive-layout.ts';
import { resetMobileLayoutForTests } from '../../src/ui/mobile-layout.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('Code responsive sidebar policy', { concurrency: false }, () => {
  let win: Window;

  beforeEach(() => {
    win = new Window();
    installHappyDomGlobals(win);
    resetMobileLayoutForTests();
    win.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }) as MediaQueryList;
    document.documentElement.dataset.osApp = 'code';
  });

  afterEach(async () => {
    resetMobileLayoutForTests();
    await teardownHappyDomAsync(win);
  });

  test('moves Files to an overlay when two expanded sidebars squeeze a 900px workspace', () => {
    assert.equal(CODE_PRIMARY_PANE_MIN_W, 480);
    assert.equal(shouldUseCodeFileOverlay({
      containerWidth: 900,
      chatSidebarWidth: 300,
      fileSidebarWidth: 350,
      chatSidebarOpen: true,
      narrowLayout: false,
    }), true);
  });

  test('keeps normal desktop docking when the primary pane has enough room', () => {
    assert.equal(shouldUseCodeFileOverlay({
      containerWidth: 1280,
      chatSidebarWidth: 300,
      fileSidebarWidth: 350,
      chatSidebarOpen: true,
      narrowLayout: false,
    }), false);
    assert.equal(shouldUseCodeFileOverlay({
      containerWidth: 900,
      chatSidebarWidth: 300,
      fileSidebarWidth: 350,
      chatSidebarOpen: false,
      narrowLayout: false,
    }), false);
  });

  test('enters compact mode without persisting a collapse and dismisses an open drawer', () => {
    document.body.innerHTML = `
      <div id="appBody" style="--sidebar-w: 300px; --file-sidebar-w: 350px">
        <aside id="chatSidebar"></aside>
        <aside id="fileSidebar" class="mobile-open"></aside>
        <button id="btnCodeViewsFiles" aria-pressed="true" aria-label="Close file tree"></button>
        <button id="fileSidebarBackdrop" class="open" aria-hidden="false"></button>
      </div>
    `;
    const body = document.getElementById('appBody') as HTMLElement;
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 900 });
    document.documentElement.classList.add('mn-os-mobile-file-drawer');

    assert.equal(syncCodeResponsiveLayout(), true);
    assert.equal(isCodeFileOverlayLayout(), true);
    assert.equal(document.getElementById('fileSidebar')?.classList.contains('mobile-open'), false);
    assert.equal(document.getElementById('fileSidebar')?.classList.contains('collapsed'), false);
    assert.equal(document.getElementById('btnCodeViewsFiles')?.getAttribute('aria-pressed'), 'false');
    assert.equal(document.getElementById('btnCodeViewsFiles')?.getAttribute('aria-label'), 'Open file tree');
    assert.equal(document.getElementById('fileSidebarBackdrop')?.getAttribute('aria-hidden'), 'true');

    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 1280 });
    assert.equal(syncCodeResponsiveLayout(), false);
    assert.equal(isCodeFileOverlayLayout(), false);
  });

  test('clears the Code-only overlay policy when another app takes foreground', () => {
    document.body.innerHTML = `
      <div id="appBody" style="--sidebar-w: 300px; --file-sidebar-w: 350px">
        <aside id="chatSidebar"></aside>
        <aside id="fileSidebar" class="mobile-open"></aside>
        <button id="btnCodeViewsFiles" aria-pressed="true"></button>
        <button id="fileSidebarBackdrop" class="open" aria-hidden="false"></button>
      </div>
    `;
    const body = document.getElementById('appBody') as HTMLElement;
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 900 });

    assert.equal(syncCodeResponsiveLayout(), true);
    document.documentElement.dataset.osApp = 'issues';
    assert.equal(syncCodeResponsiveLayout(), false);
    assert.equal(isCodeFileOverlayLayout(), false);
    assert.equal(document.getElementById('fileSidebar')?.classList.contains('mobile-open'), false);
  });
});
