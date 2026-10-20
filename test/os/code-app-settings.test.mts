import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';

function setupCodeSettingsDom(doc: Document): void {
  doc.body.innerHTML = `
    <header class="topbar"></header>
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
      <div id="osWindowsLayer" class="mn-os-windows-layer"></div>
    </div>
    <div id="appBody"></div>
    <main id="settingsView" class="settings-page mn-os-app-layer" data-os-app="settings">
      <button type="button" id="btnSettingsPageBack" aria-label="Back to Code">Back</button>
    </main>
  `;
}

describe('code app settings (MIN-417)', () => {
  /** @type {import('happy-dom').Window | undefined} */
  let happyDomWindow: import('happy-dom').Window | undefined;
  let launchApp: typeof import('../../src/os/router.ts').launchApp;
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
  let openSettingsFromTopbar: typeof import('../../src/ui/settings-page.ts').openSettingsFromTopbar;
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
    win.location.hash = '#/app/code/chat';
    setupCodeSettingsDom(win.document);

    ({
      launchApp,
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
      openSettingsFromTopbar,
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
    // Single bind — openAppPage also ensureAppInitialized; idempotent init must not stack handlers.
    initSettingsPage();
    launchInstance('code');
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

  test('opening settings from Code foregrounds settings in the apps layer', async () => {
    assert.equal(getForegroundAppId(), 'code');
    openSettingsFromTopbar();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snap = getInstanceSnapshot();
    const settingsInst = snap.instances.find((i) => i.appId === 'settings');
    assert.ok(settingsInst);
    assert.equal(settingsInst.launchOptions?.returnToApp, 'code');
    assert.equal(getOsView(), 'app');
    assert.equal(getForegroundAppId(), 'settings');
    assert.equal(document.getElementById('settingsView')?.classList.contains('is-open'), true);
  });

  test('closing settings returns to the Code app', async () => {
    openSettingsFromTopbar();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    closeSettings();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snap = getInstanceSnapshot();
    assert.equal(snap.instances.some((i) => i.appId === 'settings'), false);
    assert.equal(getForegroundAppId(), 'code');
    assert.equal(getOsView(), 'app');
    assert.equal(window.location.hash, '#/app/code/chat');
  });

  test('pressing the header gear again closes Settings and can reopen it', async () => {
    for (const expectedOpen of [true, false, true, false]) {
      openSettingsFromTopbar();
      syncOsRouteFromHashForTests();
      syncAppHostForTests();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(document.getElementById('settingsView')?.classList.contains('is-open'), expectedOpen);
      assert.equal(getInstanceSnapshot().instances.some((i) => i.appId === 'settings'), expectedOpen);
      assert.equal(getForegroundAppId(), expectedOpen ? 'settings' : 'code');
      if (!expectedOpen) assert.equal(window.location.hash, '#/app/code/chat');
    }
  });

  test('clicking the original app after opening Settings restores its surface', async () => {
    const { initAppRail } = await import('../../src/os/app-rail.ts');
    const rail = document.createElement('nav');
    document.body.appendChild(rail);
    const dispose = initAppRail(rail);
    try {
      openSettingsFromTopbar();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(getForegroundAppId(), 'settings');
      const code = rail.querySelector<HTMLButtonElement>('[data-app-id="code"]');
      assert.ok(code);
      code.dispatchEvent(new happyDomWindow!.PointerEvent('pointerdown', { bubbles: true }));
      code.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(getForegroundAppId(), 'code');
      assert.equal(window.location.hash, '#/app/code/chat');
      assert.equal(document.getElementById('settingsView')?.classList.contains('is-open'), false);
      assert.equal(document.getElementById('settingsView')?.classList.contains('is-active'), false);
      assert.equal(document.getElementById('appBody')?.classList.contains('hidden'), false);
    } finally {
      dispose();
    }
  });

  test('settings back button returns to the Code app', async () => {
    openSettingsFromTopbar();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const back = document.getElementById('btnSettingsPageBack');
    assert.ok(back);
    back.click();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'code');
    assert.equal(getOsView(), 'app');
    assert.equal(window.location.hash, '#/app/code/chat');
    assert.equal(getInstanceSnapshot().instances.some((i) => i.appId === 'settings'), false);
  });

  test('stacked back handlers do not fall through to desktop', async () => {
    // Pre-fix failure mode: a second closeSettings listener runs after Code was restored.
    document.getElementById('btnSettingsPageBack')?.addEventListener('click', () => {
      closeSettings();
    });

    openSettingsFromTopbar();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.getElementById('btnSettingsPageBack')?.click();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'code');
    assert.equal(getOsView(), 'app');
    assert.equal(window.location.hash, '#/app/code/chat');
  });

  test('launchApp(settings) from Code menubar path is fullscreen, not a window', async () => {
    launchApp('settings');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'settings');
    assert.equal(getOsView(), 'app');
  });

  test('closing Settings without a caller clears the route before another overlay returns', async () => {
    const { closeInstance } = await import('../../src/os/instances.ts');
    for (const instance of getInstanceSnapshot().instances) closeInstance(instance.id);
    launchApp('settings');
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    closeSettings();
    syncOsRouteFromHashForTests();
    assert.equal(window.location.hash, '#/workspaces');
    assert.notEqual(getForegroundAppId(), 'settings');
  });

  test('reopens settings when stale openAppPage left the layer without content', async () => {
    openSettingsFromTopbar();
    syncOsRouteFromHashForTests();
    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const root = document.getElementById('settingsView');
    assert.ok(root?.classList.contains('is-open'));

    // Simulate syncGeneration aborting openAppPage after showAppLayer bookkeeping.
    root.classList.remove('is-open');

    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'settings');
    assert.ok(root?.classList.contains('is-open'));
  });
});
