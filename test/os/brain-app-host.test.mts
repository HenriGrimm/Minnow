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
      <button type="button" id="btnBrainPageBack" aria-label="Back"></button>
      <h1 id="brainPageHeaderTitle"></h1>
      <p id="brainPageHeaderLead"></p>
      <div id="brainPageHeaderActions"></div>
      <div id="brainPageHeaderUsage" class="hidden"></div>
      <nav class="brain-rail">${navButtons}</nav>
      <div class="brain-content">${sectionPanels}</div>
      <div id="brainGraphStage" class="brain-graph-stage">
        <input type="search" id="brainGraphSearch">
        <canvas id="brainGraphCanvas" width="100" height="100"></canvas>
      </div>
      <aside id="brainInspector"></aside>
      <div id="brainInspectorResize"></div>
    </main>
  `;
}

function brainApiFetchResponse(url: string): Response {
  const path = String(url);
  if (path.includes('/api/brain/tree')) {
    return new Response(JSON.stringify({ tree: { name: 'root', children: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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
    assert.equal(window.location.hash, '#/app/brain/graph');
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
