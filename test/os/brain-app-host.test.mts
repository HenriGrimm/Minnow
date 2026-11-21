/**
 * Brain app OS layer reveal — rail click must show the fullscreen layer.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { installHappyDomGlobals, seedMinimalSession, teardownHappyDomAsync } from './dom-helpers.mts';

const BRAIN_SECTION_IDS = [
  'graph',
  'edit',
  'log',
  'schema',
  'proposals',
  'memories',
  'ingest',
  'lint',
  'code',
  'settings',
] as const;

function setupBrainAppHostDom(doc: Document): void {
  const sectionPanels = BRAIN_SECTION_IDS.map(
    (id) => `<section id="brainSection-${id}" class="brain-section"></section>`,
  ).join('');
  const navButtons = BRAIN_SECTION_IDS.map(
    (id) =>
      `<button type="button" class="brain-rail__btn" data-brain-nav="${id}" title="${id}"></button>`,
  ).join('');

  doc.body.innerHTML = `
    <header class="topbar"></header>
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
    </div>
    <div id="appBody"></div>
    <main id="brainView" class="brain-page" aria-label="Brain">
      <h1 id="brainPageHeaderTitle"></h1>
      <p id="brainPageHeaderLead"></p>
      <div id="brainPageHeaderActions"></div>
      <div id="brainPageHeaderUsage" class="hidden"></div>
      <nav class="brain-rail">
        <div class="brain-rail__heading" data-back-to-chat-header><span>Brain</span></div>
        ${navButtons}
      </nav>
      <div class="brain-content">${sectionPanels}</div>
    </main>
  `;
}

function brainApiFetchResponse(url: string): Response {
  const path = String(url);
  if (path.includes('/api/brain/memories')) {
    return Response.json({ project: null, memories: [], limits: { projectCap: 150, userCap: 40 } });
  }
  if (path.includes('/api/brain/usage')) {
    return new Response(JSON.stringify({ thisWeek: {}, weeks: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('brain app host layer reveal', () => {
  /** @type {import('happy-dom').Window | undefined} */
  let happyDomWindow: import('happy-dom').Window | undefined;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    win.fetch = async (input) => brainApiFetchResponse(String(input));
    installHappyDomGlobals(win, { fetch: win.fetch });
    seedMinimalSession('chat-1');
    win.localStorage.clear();
    win.localStorage.setItem('minnow.brain.graphSelection', 'index.md');
    win.location.hash = '#/app/code/chat';
    setupBrainAppHostDom(win.document);

    const { resetInstancesForTests, launchInstance } = await import('../../src/os/instances.ts');
    const { resetOsRouterForTests, initOsRouter, launchApp } = await import('../../src/os/router.ts');
    const { resetOsPageBridgeForTests, initOsPageBridge } = await import('../../src/os/page-bridge.ts');
    const { resetAppHostForTests, initAppHost, syncAppHostForTests } = await import(
      '../../src/os/app-host.ts'
    );
    const { resetAppModulesForTests } = await import('../../src/os/app-modules.ts');
    const { resetBrainPageForTests } = await import('../../src/ui/brain-page.ts');

    resetInstancesForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
    resetAppHostForTests();
    resetAppModulesForTests();
    resetBrainPageForTests();
    initOsPageBridge();
    initOsRouter();
    initAppHost();
    launchInstance('code');
    syncAppHostForTests();

    // Store launchApp on window for tests (avoid re-import race).
    (win as unknown as { __launchApp?: typeof launchApp }).__launchApp = launchApp;
  });

  afterEach(async () => {
    const { resetAppHostForTests } = await import('../../src/os/app-host.ts');
    const { resetOsRouterForTests } = await import('../../src/os/router.ts');
    const { resetOsPageBridgeForTests } = await import('../../src/os/page-bridge.ts');
    const { resetInstancesForTests } = await import('../../src/os/instances.ts');
    const { resetAppModulesForTests } = await import('../../src/os/app-modules.ts');
    const { resetBrainPageForTests } = await import('../../src/ui/brain-page.ts');

    resetAppHostForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
    resetInstancesForTests();
    resetAppModulesForTests();
    resetBrainPageForTests();
    await teardownHappyDomAsync(happyDomWindow);
    happyDomWindow = undefined;
  });

  test('launchApp(brain) from Code reveals the brain OS layer', async () => {
    const launchApp = (happyDomWindow as unknown as { __launchApp: (id: string) => void }).__launchApp;
    const { getForegroundAppId } = await import('../../src/os/instances.ts');

    launchApp('brain');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const root = document.getElementById('brainView');
    assert.equal(getForegroundAppId(), 'brain');
    assert.ok(root?.classList.contains('is-open'));
    assert.ok(root?.classList.contains('is-active'));
    assert.equal(window.location.hash, '#/app/brain/memories');

    const back = root?.querySelector<HTMLButtonElement>('.brain-rail__heading > .back-to-chat');
    assert.ok(back);
    back.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(window.location.hash, '#/app/code/chat');
  });

  test('reopens brain layer when is-open was set without is-active', async () => {
    const launchApp = (happyDomWindow as unknown as { __launchApp: (id: string) => void }).__launchApp;
    const { syncAppHostForTests } = await import('../../src/os/app-host.ts');
    const { getForegroundAppId } = await import('../../src/os/instances.ts');

    launchApp('brain');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const root = document.getElementById('brainView');
    root?.classList.remove('is-active');

    syncAppHostForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(getForegroundAppId(), 'brain');
    assert.ok(root?.classList.contains('is-open'));
    assert.ok(root?.classList.contains('is-active'));
  });

});
