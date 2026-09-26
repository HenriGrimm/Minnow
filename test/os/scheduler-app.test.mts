/**
 * Minnow Scheduler app registration, routing, and workspace shell.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { APPS, getAppById, isAppId } from '../../src/os/app-registry.ts';
import { resetAppHostForTests } from '../../src/os/app-host.ts';
import {
  getForegroundAppId,
  getOsView,
  resetInstancesForTests,
} from '../../src/os/instances.ts';
import { resetOsPageBridgeForTests } from '../../src/os/page-bridge.ts';
import {
  initOsRouter,
  launchApp,
  parseOsHash,
  resetOsRouterForTests,
  resolveLegacyHash,
  syncOsRouteFromHashForTests,
} from '../../src/os/router.ts';
import {
  openJobEditorWindow,
  resetJobEditorWindowForTests,
} from '../../src/ui/scheduler/job-editor-overlay.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

function setupSchedulerDom(win: import('happy-dom').Window): void {
  win.document.body.innerHTML = `
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
    </div>
    <main id="schedulerView" class="scheduler-page">
      <div id="schedulerPanelMount"></div>
    </main>
  `;
}

async function waitForJobEditor(): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const editor = document
      .querySelector<HTMLElement>('.scheduler-editor-overlay .scheduler-editor__close')
      ?.closest<HTMLElement>('.scheduler-editor');
    if (editor) return editor;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Scheduler job editor did not finish mounting');
}

describe('scheduler app registry', () => {
  test('scheduler is a registered launcher app', () => {
    assert.ok(APPS.some((app) => app.id === 'scheduler'));
    const scheduler = getAppById('scheduler');
    assert.ok(scheduler);
    assert.match(scheduler.tag, /recurring/i);
  });

  test('isAppId accepts scheduler', () => {
    assert.equal(isAppId('scheduler'), true);
  });
});

describe('scheduler router', () => {
  test('legacy #/scheduler redirects to #/app/scheduler', () => {
    const legacy = resolveLegacyHash('#/scheduler');
    assert.equal(legacy.hash, '#/app/scheduler');
  });

  test('parseOsHash resolves scheduler app route', () => {
    const route = parseOsHash('#/app/scheduler');
    assert.equal(route.view, 'app');
    assert.equal(route.appId, 'scheduler');
  });
});

describe('scheduler markup contract', () => {
  test('index.html defines schedulerView shell', () => {
    const html = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    assert.match(html, /id="schedulerView"/);
    assert.match(html, /id="schedulerPanelMount"/);
    assert.match(html, /id="schedulerStatus"/);
    assert.match(html, /id="schedulerSummary"/);
    assert.match(html, /id="btnSchedulerAdd"/);
  });
});

describe('scheduler workspace shell', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;
  let fetchMock: typeof globalThis.fetch;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      HTMLElement: typeof HTMLElement;
      localStorage: Storage;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.localStorage = win.localStorage;
    win.localStorage.clear();
    setupSchedulerDom(win);
    win.location.hash = '#/workspaces';
    resetInstancesForTests();
    resetOsRouterForTests();
    resetAppHostForTests();
    resetOsPageBridgeForTests();
    resetJobEditorWindowForTests();
    initOsRouter();
    fetchMock = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/scheduler/jobs')) {
        return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      }
      if (url.includes('/api/scheduler/runs')) {
        return new Response(JSON.stringify({ runs: [] }), { status: 200 });
      }
      if (url.includes('/api/scheduler/default-workspace')) {
        return new Response(JSON.stringify({ path: '/tmp' }), { status: 200 });
      }
      return fetchMock(input);
    };
  });

  afterEach(async () => {
    globalThis.fetch = fetchMock;
    resetJobEditorWindowForTests();
    resetInstancesForTests();
    resetOsRouterForTests();
    resetAppHostForTests();
    resetOsPageBridgeForTests();
    if (happyDomWindow) {
      await teardownHappyDomAsync(happyDomWindow);
      happyDomWindow = undefined;
    }
  });

  test('launchApp(scheduler) foregrounds scheduler in app view', () => {
    launchApp('scheduler');
    syncOsRouteFromHashForTests();
    assert.equal(getForegroundAppId(), 'scheduler');
    assert.equal(getOsView(), 'app');
  });

  test('hash route #/app/scheduler foregrounds scheduler in app view', () => {
    window.location.hash = '#/app/scheduler';
    syncOsRouteFromHashForTests();
    assert.equal(getForegroundAppId(), 'scheduler');
    assert.equal(getOsView(), 'app');
  });

  test('scheduler job editor opens as an in-app overlay', () => {
    openJobEditorWindow({ title: 'Add scheduled job' });
    const overlay = document.querySelector('.scheduler-editor-overlay');
    assert.ok(overlay);
    resetJobEditorWindowForTests();
    assert.equal(document.querySelector('.scheduler-editor-overlay'), null);
  });

  test('scheduler job editor has visible close control and closes with Escape', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    openJobEditorWindow();
    await waitForJobEditor();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const title = document.getElementById('schedulerJobEditorTitle');
    const close = document.querySelector<HTMLButtonElement>('.scheduler-editor__close');
    assert.ok(dialog);
    assert.ok(title);
    assert.ok(close);
    assert.equal(dialog.getAttribute('aria-labelledby'), title.id);
    assert.match(close.getAttribute('aria-label') ?? '', /close job editor/i);

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('.scheduler-editor-overlay'), null);
    assert.equal(document.activeElement, opener);
  });

  test('scheduler editor associates visible labels with its controls', async () => {
    openJobEditorWindow();
    await waitForJobEditor();

    const scheduleKind = document.querySelector<HTMLSelectElement>('.scheduler-schedule-kind');
    const interval = document.querySelector<HTMLInputElement>('.scheduler-schedule-interval');
    const model = document.querySelector<HTMLSelectElement>('#schedulerJobModel');
    const modelTrigger = document.querySelector<HTMLButtonElement>(
      '.scheduler-model-field .model-select-trigger',
    );
    const workspace = document.querySelector<HTMLInputElement>('#schedulerJobWorkspace');
    const missedRun = document.querySelector<HTMLSelectElement>('.scheduler-missed-run-select');

    assert.match(scheduleKind?.closest('label')?.textContent ?? '', /type/i);
    assert.match(interval?.closest('label')?.textContent ?? '', /interval/i);
    assert.equal(model?.getAttribute('aria-labelledby'), 'schedulerJobModelLabel');
    assert.equal(modelTrigger?.getAttribute('aria-labelledby'), 'schedulerJobModelLabel');
    assert.equal(workspace?.labels?.[0]?.textContent, 'Workspace');
    assert.match(missedRun?.closest('label')?.textContent ?? '', /if a run is missed/i);
    assert.deepEqual(
      [...(missedRun?.options ?? [])].map((option) => option.value),
      ['run_once', 'skip'],
    );
    assert.equal(missedRun?.value, 'run_once');
  });

  test('scheduler only offers modes accepted by the scheduler runner', async () => {
    openJobEditorWindow({
      initialJob: {
        label: '',
        enabled: true,
        schedule: { kind: 'interval', value: '5m' },
        prompt: '',
        modeId: 'onboarding',
        channels: ['in_app'],
      },
    });
    await waitForJobEditor();

    const mode = document.querySelector<HTMLSelectElement>('.scheduler-mode-select');
    assert.ok(mode);
    assert.deepEqual(
      [...mode.options].map((option) => option.value),
      ['general', 'build', 'plan', 'debug'],
    );
    assert.equal(mode.value, 'build');
  });

  test('scheduler editor keeps actions visible and scrolls fields at compact heights', () => {
    const css = fs.readFileSync(
      new URL('../../src/styles/scheduler-editor-window.css', import.meta.url),
      'utf8',
    );
    assert.match(
      css,
      /\.scheduler-editor-overlay__dialog\.scheduler-editor-window-body \.scheduler-editor__fields\s*\{[^}]*overflow-y:\s*auto/s,
    );
    assert.match(
      css,
      /\.scheduler-editor-overlay__dialog\.scheduler-editor-window-body \.scheduler-editor__actions\s*\{[^}]*flex:\s*0 0 auto/s,
    );
  });
});
