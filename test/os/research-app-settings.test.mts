import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';
import { isDeveloperReleased } from '../../src/os/app-registry.ts';

/** Research is hidden for release (releaseState 'hidden'); these re-arm when it ships again. */
const researchHidden = !isDeveloperReleased('research') && 'Research is hidden for release';

function setupResearchSettingsDom(doc: Document): void {
  doc.body.innerHTML = `
    <header class="topbar"></header>
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
      <div id="osWindowsLayer" class="mn-os-windows-layer"></div>
    </div>
    <div id="appBody"></div>
    <main id="researchView" class="research-page mn-os-app-layer" data-os-app="research"></main>
    <main id="settingsView" class="settings-page mn-os-app-layer" data-os-app="settings">
      <button type="button" id="btnSettingsPageBack" aria-label="Back">Back</button>
    </main>
  `;
}

describe('research app settings deep link', { skip: researchHidden }, () => {
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
  let getInstanceSnapshot: typeof import('../../src/os/instances.ts').getInstanceSnapshot;
  let getOsView: typeof import('../../src/os/instances.ts').getOsView;
  let resetInstancesForTests: typeof import('../../src/os/instances.ts').resetInstancesForTests;
  let initSettingsPage: typeof import('../../src/ui/settings-page.ts').initSettingsPage;
  let resetSettingsPageForTests: typeof import('../../src/ui/settings-page.ts').resetSettingsPageForTests;
  let openSettings: typeof import('../../src/ui/settings-page.ts').openSettings;
  let closeSettings: typeof import('../../src/ui/settings-page.ts').closeSettings;
  let resetAppModulesForTests: typeof import('../../src/os/app-modules.ts').resetAppModulesForTests;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    win.fetch = async () =>
      new Response(JSON.stringify({ activePromptProfile: 'default' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    installHappyDomGlobals(win, { fetch: win.fetch });
    seedMinimalSession('chat-1');
    win.localStorage.clear();
    win.location.hash = '#/app/research';
    setupResearchSettingsDom(win.document);

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
      getInstanceSnapshot,
      getOsView,
      resetInstancesForTests,
    } = await import('../../src/os/instances.ts'));
    ({ resetAppModulesForTests } = await import('../../src/os/app-modules.ts'));
    ({
      initSettingsPage,
      resetSettingsPageForTests,
      openSettings,
      closeSettings,
    } = await import('../../src/ui/settings-page.ts'));

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
    launchInstance('research');
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

  test('openSettings from Research foregrounds Settings with returnToApp research', async () => {
    assert.equal(getForegroundAppId(), 'research');
    openSettings('deep-research');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snap = getInstanceSnapshot();
    const settingsInst = snap.instances.find((i) => i.appId === 'settings');
    assert.ok(settingsInst);
    assert.equal(settingsInst.launchOptions?.returnToApp, 'research');
    assert.equal(settingsInst.launchOptions?.settingsSection, 'deep-research');
    assert.equal(getOsView(), 'app');
    assert.equal(getForegroundAppId(), 'settings');
    assert.equal(document.getElementById('settingsView')?.classList.contains('is-open'), true);
  });

  test('closing settings returns to Research', async () => {
    openSettings('deep-research');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    closeSettings();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'research');
    assert.equal(getOsView(), 'app');
    assert.equal(window.location.hash, '#/app/research');
  });
});
