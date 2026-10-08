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

describe('scheduler app registry', () => {
  test('manual describes the foreground app and unattended permission behavior', () => {
    const manual = fs.readFileSync(new URL('../../documentation/manual/apps/scheduler.md', import.meta.url), 'utf8');
    assert.match(manual, /foreground \*\*main app\*\*/);
    assert.match(manual, /editor overlay/);
    assert.match(manual, /automatically allows tools set to \*\*Ask\*\*/);
    assert.match(manual, /\*\*Off\*\* remain disabled/);
    assert.match(manual, /ask_question.*non-interactive/);
    assert.doesNotMatch(manual, /side panel|just stalls|nobody to approve/);
  });
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
      if (url.includes('/api/scheduler/workspace')) {
        return new Response(JSON.stringify({ path: '/tmp' }), { status: 200 });
      }
      if (url.includes('/api/providers')) return Response.json({ providers: [], models: [] });
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

  test('watcher editor keeps repository configuration when saving guidance changes', async () => {
    let saved: Record<string, unknown> | undefined;
    let resolveSaved: () => void = () => {};
    const savedPromise = new Promise<void>(resolve => { resolveSaved = resolve; });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input) === '/api/scheduler/jobs/watcher' && init?.method === 'PUT') {
        saved = JSON.parse(String(init.body)).job;
        return Response.json({ job: { ...saved, id: 'watcher' } });
      }
      return previousFetch(input, init);
    };
    openJobEditorWindow({
      jobId: 'watcher',
      initialJob: {
        label: 'GitHub fixes', enabled: true, prompt: '', modeId: 'build',
        schedule: { kind: 'interval', value: '5m' }, channels: ['in_app'],
        githubWatch: { repository: 'owner/repo' }, workspacePath: '/repo',
      },
      onSaved: resolveSaved,
    });
    for (let attempt = 0; attempt < 40 && !document.querySelector('.scheduler-editor__actions'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const type = document.querySelector<HTMLSelectElement>('.scheduler-field select');
    assert.equal(type?.value, 'github');
    assert.equal(type?.disabled, true);
    const textarea = document.querySelector<HTMLTextAreaElement>('.scheduler-textarea')!;
    textarea.value = 'Run regression tests';
    textarea.dispatchEvent(new window.Event('input'));
    const mode = [...document.querySelectorAll<HTMLElement>('.scheduler-field')].find(field => field.querySelector('.scheduler-field__label')?.textContent === 'Mode');
    assert.equal(mode?.hidden, true);
    document.querySelector<HTMLButtonElement>('.scheduler-editor__actions button')!.click();
    await Promise.race([savedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Save did not finish')), 1000))]);
    assert.deepEqual(saved?.githubWatch, { repository: 'owner/repo', label: 'minnow' });
    assert.equal(saved?.workspacePath, '/repo');
    assert.equal(saved?.prompt, 'Run regression tests');
  });
});
