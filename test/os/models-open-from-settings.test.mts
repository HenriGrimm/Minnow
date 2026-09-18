/**
 * Settings Tools → Open Providers must launch the Models app, not only
 * toggle #modelsView.is-open while Settings stays the OS foreground.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';

function setupSettingsModelsDom(doc: Document): void {
  doc.body.innerHTML = `
    <header class="topbar"></header>
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
      <div id="osWindowsLayer" class="mn-os-windows-layer"></div>
    </div>
    <div id="appBody"></div>
    <main id="settingsView" class="settings-page mn-os-app-layer is-open is-active" data-os-app="settings">
      <button type="button" id="btnSettingsPageBack" aria-label="Back">Back</button>
    </main>
    <main id="modelsView" class="models-page mn-os-app-layer" data-os-app="models">
      <div id="modelsSection-providers"></div>
    </main>
  `;
}

describe('openModels from Settings', () => {
  /** @type {import('happy-dom').Window | undefined} */
  let happyDomWindow: import('happy-dom').Window | undefined;
  let syncOsRouteFromHashForTests: typeof import('../../src/os/router.ts').syncOsRouteFromHashForTests;
  let initOsRouter: typeof import('../../src/os/router.ts').initOsRouter;
  let resetOsRouterForTests: typeof import('../../src/os/router.ts').resetOsRouterForTests;
  let initAppHost: typeof import('../../src/os/app-host.ts').initAppHost;
  let resetAppHostForTests: typeof import('../../src/os/app-host.ts').resetAppHostForTests;
  let syncAppHostForTests: typeof import('../../src/os/app-host.ts').syncAppHostForTests;
  let initOsPageBridge: typeof import('../../src/os/page-bridge.ts').initOsPageBridge;
  let resetOsPageBridgeForTests: typeof import('../../src/os/page-bridge.ts').resetOsPageBridgeForTests;
  let launchInstance: typeof import('../../src/os/instances.ts').launchInstance;
  let getForegroundAppId: typeof import('../../src/os/instances.ts').getForegroundAppId;
  let resetInstancesForTests: typeof import('../../src/os/instances.ts').resetInstancesForTests;
  let resetAppModulesForTests: typeof import('../../src/os/app-modules.ts').resetAppModulesForTests;
  let initSettingsPage: typeof import('../../src/ui/settings-page.ts').initSettingsPage;
  let openSettings: typeof import('../../src/ui/settings-page.ts').openSettings;
  let resetSettingsPageForTests: typeof import('../../src/ui/settings-page.ts').resetSettingsPageForTests;
  let openModels: typeof import('../../src/ui/models-page.ts').openModels;

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
    seedMinimalSession('chat-1');
    win.localStorage.clear();
    win.location.hash = '#/app/settings';
    setupSettingsModelsDom(win.document);

    ({
      syncOsRouteFromHashForTests,
      initOsRouter,
      resetOsRouterForTests,
    } = await import('../../src/os/router.ts'));
    ({
      initAppHost,
      resetAppHostForTests,
      syncAppHostForTests,
    } = await import('../../src/os/app-host.ts'));
    ({
      initOsPageBridge,
      resetOsPageBridgeForTests,
    } = await import('../../src/os/page-bridge.ts'));
    ({
      launchInstance,
      getForegroundAppId,
      resetInstancesForTests,
    } = await import('../../src/os/instances.ts'));
    ({ resetAppModulesForTests } = await import('../../src/os/app-modules.ts'));
    ({
      initSettingsPage,
      openSettings,
      resetSettingsPageForTests,
    } = await import('../../src/ui/settings-page.ts'));
    ({ openModels } = await import('../../src/ui/models-page.ts'));

    resetInstancesForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
    resetAppHostForTests();
    resetAppModulesForTests();
    resetSettingsPageForTests();
    initOsPageBridge();
    initOsRouter();
    initAppHost();
    initSettingsPage();
    launchInstance('settings');
    syncAppHostForTests();
    syncOsRouteFromHashForTests();
  });

  afterEach(async () => {
    const { resetInstancesForTests } = await import('../../src/os/instances.ts');
    const { resetOsRouterForTests } = await import('../../src/os/router.ts');
    const { resetOsPageBridgeForTests } = await import('../../src/os/page-bridge.ts');
    const { resetAppHostForTests } = await import('../../src/os/app-host.ts');
    const { resetAppModulesForTests } = await import('../../src/os/app-modules.ts');
    const { resetSettingsPageForTests } = await import('../../src/ui/settings-page.ts');
    resetInstancesForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
    resetAppHostForTests();
    resetAppModulesForTests();
    resetSettingsPageForTests();
    if (happyDomWindow) {
      await teardownHappyDomAsync(happyDomWindow);
      happyDomWindow = undefined;
    }
  });

  test('Open Providers from Settings foregrounds Models providers', async () => {
    assert.equal(getForegroundAppId(), 'settings');

    openModels('providers');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(getForegroundAppId(), 'models');
    assert.equal(window.location.hash, '#/app/models/providers');
    const modelsView = document.getElementById('modelsView');
    assert.equal(modelsView?.classList.contains('is-open'), true);
    assert.equal(modelsView?.classList.contains('is-active'), true);
  });

  test('opening a model-owned Settings section redirects to Models', async () => {
    openSettings('model-routing');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(getForegroundAppId(), 'models');
    assert.equal(window.location.hash, '#/app/models/routing');
  });
});
