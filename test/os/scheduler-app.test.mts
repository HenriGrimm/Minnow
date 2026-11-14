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
import { mountAutomationsApp, draftFromDescription, type AutomationsApp } from '../../src/ui/automations/app.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { teardownHappyDomAsync } from '../os/dom-helpers.mts';

function setupSchedulerDom(win: import('happy-dom').Window): void {
  win.document.body.innerHTML = `
    <div id="osStage" class="mn-os-stage" style="width:1200px;height:800px;position:relative">
      <div id="osAppsLayer" class="mn-os-apps-layer"></div>
    </div>
    <main id="schedulerView" class="scheduler-page">
      <header class="scheduler-header"><div class="scheduler-header__controls"><button id="btnSchedulerAdd">New automation</button></div>
      <p id="schedulerSummary"></p></header>
      <div id="schedulerPanelMount"></div>
    </main>
  `;
}

describe('scheduler app registry', () => {
  test('manual describes the hub, presets and unattended behavior', () => {
    const manual = fs.readFileSync(new URL('../../documentation/manual/apps/scheduler.md', import.meta.url), 'utf8');
    assert.match(manual, /# Automations/);
    assert.match(manual, /PR Reviewer/);
    assert.match(manual, /Needs you/);
    assert.match(manual, /ask_question.*non-interactive/);
    assert.doesNotMatch(manual, /side panel|just stalls|nobody to approve|editor overlay/);
  });
  test('scheduler is a registered launcher app', () => {
    assert.ok(APPS.some((app) => app.id === 'scheduler'));
    const scheduler = getAppById('scheduler');
    assert.ok(scheduler);
    assert.match(scheduler.tag, /recurring/i);
    assert.equal(scheduler.name, 'Automations');
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
  let app: AutomationsApp | undefined;
  let overview: Record<string, unknown> = { jobs: [], activity: [], now: new Date().toISOString() };

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
    initOsRouter();
    fetchMock = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/scheduler/overview')) {
        return new Response(JSON.stringify(overview), { status: 200 });
      }
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
    app?.dispose();
    app = undefined;
    setLocalServerAvailableForTests(false);
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

  async function mountApp(): Promise<HTMLElement> {
    setLocalServerAvailableForTests(true);
    const mount = document.getElementById('schedulerPanelMount')!;
    app = mountAutomationsApp(mount, {
      summary: document.getElementById('schedulerSummary'),
      controls: document.querySelector<HTMLElement>('.scheduler-header__controls'),
      addButton: document.getElementById('btnSchedulerAdd') as HTMLButtonElement,
      notify: () => {},
    });
    await app.refresh();
    return mount;
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 80 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  };

  test('an empty hub offers presets and the gallery', async () => {
    const mount = await mountApp();
    assert.match(mount.querySelector('.auto-empty__title')?.textContent ?? '', /Nothing runs on its own yet/);
    const picks = [...mount.querySelectorAll('.auto-pick')].map(node => node.textContent);
    assert.ok(picks.includes('PR Reviewer'));
    (document.getElementById('btnSchedulerAdd') as HTMLButtonElement).click();
    assert.ok(mount.querySelector('.auto-gallery'));
    const presets = [...mount.querySelectorAll('.auto-preset__name')].map(node => node.textContent);
    assert.ok(presets.includes('PR Reviewer'));
    assert.ok(presets.includes('Issue Watcher'));
    assert.ok(presets.includes('Custom'));
  });

  test('the hub shows running agents, attention and the automations table', async () => {
    const now = Date.now();
    overview = {
      now: new Date(now).toISOString(),
      activity: [{ id: 'a1', at: new Date(now).toISOString(), jobId: 'pr', label: 'PR Reviewer', text: 'Claimed #142', tone: 'run' }],
      jobs: [
        {
          id: 'pr', label: 'PR Reviewer', enabled: true, running: true, schedule: { kind: 'interval', value: '2m' }, modeId: 'build', channels: ['in_app'],
          preset: { id: 'pr-review', config: { repository: 'o/r' } }, workspacePath: '/repo', createdAt: '', updatedAt: '',
          recentRuns: [{ id: 'r1', status: 'completed', quiet: false, startedAt: new Date(now - 60_000).toISOString() }],
          live: { runId: 'run-live', jobId: 'pr', label: 'PR Reviewer', startedAt: new Date(now - 5000).toISOString(), status: 'running', step: 'Reviewing #142',
            focus: { kind: 'pr', number: 142, title: 'Scatter radius', author: 'mira' }, stats: { rounds: 0, toolCalls: 0, filesRead: 0, filesEdited: 0, commands: 0 },
            live: null, children: [{ runId: 'c1', jobId: 'pr', label: 'Tests', roleLabel: 'Tests', startedAt: new Date(now).toISOString(), status: 'running', step: 'npm test', stats: {}, live: null, children: [] }] },
          attention: null,
        },
        {
          id: 'digest', label: 'Standup digest', enabled: true, schedule: { kind: 'cron', value: '0 9 * * 1-5' }, modeId: 'general', channels: ['in_app'],
          createdAt: '', updatedAt: '', recentRuns: [{ id: 'd1', status: 'failed', quiet: false, startedAt: new Date(now).toISOString() }], live: null,
          attention: { kind: 'run', runId: 'd1', text: 'Model is not loaded' },
        },
      ],
    };
    const mount = await mountApp();
    assert.match(mount.querySelector('.auto-run__focus')?.textContent ?? '', /#142 Scatter radius/);
    assert.match(mount.querySelector('.auto-run__agents')?.textContent ?? '', /Tests/);
    assert.match(mount.querySelector('.auto-attn__text')?.textContent ?? '', /Model is not loaded/);
    const rows = [...mount.querySelectorAll('.auto-row:not(.auto-row--head)')];
    assert.equal(rows.length, 2);
    assert.match(rows[1].textContent ?? '', /Weekdays at 9:00 AM/);
    assert.match(document.getElementById('schedulerSummary')?.textContent ?? '', /1 running · 1 needs you · 2 automations/);
    overview = { jobs: [], activity: [], now: new Date().toISOString() };
  });

  test('custom setup keeps the draft when saving fails, then creates the automation', async () => {
    const previousFetch = globalThis.fetch;
    let attempts = 0;
    let saved: Record<string, any> | undefined;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === '/api/scheduler/jobs' && init?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) return Response.json({ error: 'Workspace is unavailable' }, { status: 400 });
        saved = JSON.parse(String(init.body)).job;
        return Response.json({ job: { ...saved, id: 'saved' } });
      }
      if (url === '/api/scheduler/schedule/preview') return Response.json({ schedule: { kind: 'cron', value: '0 9 * * 1-5' }, nextRunAt: new Date().toISOString() });
      return previousFetch(input, init);
    };
    const mount = await mountApp();
    (document.getElementById('btnSchedulerAdd') as HTMLButtonElement).click();
    const custom = [...mount.querySelectorAll<HTMLButtonElement>('.auto-preset')].find(card => card.textContent?.includes('Custom'))!;
    custom.click();
    const name = mount.querySelector<HTMLInputElement>('.auto-name__input')!;
    const prompt = mount.querySelector<HTMLTextAreaElement>('.auto-composer__input')!;
    name.value = 'Audit job';
    prompt.value = 'Check the fixture and write a summary to a Brain page';
    for (const field of [name, prompt]) field.dispatchEvent(new window.Event('input'));
    const parsed = mount.querySelector('.auto-parsed');
    assert.match(parsed?.textContent ?? '', /Weekdays at 9:00 AM/);
    const save = mount.querySelector<HTMLButtonElement>('.auto-setup__footer .auto-btn--primary')!;
    save.click();
    const status = mount.querySelector<HTMLElement>('.auto-setup__status')!;
    await until(() => status.textContent === 'Workspace is unavailable');
    assert.equal(status.textContent, 'Workspace is unavailable');
    assert.equal(name.value, 'Audit job');
    save.click();
    await until(() => attempts === 2 && Boolean(saved));
    assert.equal(saved?.prompt, 'Check the fixture and write a summary to a Brain page');
    assert.deepEqual(saved?.schedule, { kind: 'cron', value: '0 9 * * 1-5' });
    globalThis.fetch = previousFetch;
  });

  test('PR Reviewer setup previews each run from its options', async () => {
    const mount = await mountApp();
    app!.openGallery();
    [...mount.querySelectorAll<HTMLButtonElement>('.auto-preset')].find(card => card.textContent?.includes('PR Reviewer'))!.click();
    const steps = () => [...mount.querySelectorAll('.auto-step b')].map(node => node.textContent);
    assert.ok(steps().includes('Claim it'));
    const claim = mount.querySelector<HTMLButtonElement>('.auto-toggle .auto-switch')!;
    claim.click();
    assert.ok(!steps().includes('Claim it'));
    const merge = [...mount.querySelectorAll<HTMLButtonElement>('.auto-option')].find(option => option.textContent?.includes('Merge now'))!;
    merge.click();
    assert.equal(merge.getAttribute('aria-checked'), 'true');
    assert.equal(mount.querySelector<HTMLElement>('.auto-warn')?.hidden, false);
    assert.match(mount.querySelector('.auto-instructions')?.textContent ?? '', /squash-merge it/);
  });

  test('describing an automation drafts its name and schedule', () => {
    const draft = draftFromDescription('Every weekday at 9, summarize what merged yesterday into Brain.');
    assert.equal(draft.scheduleText, 'Every weekday at 9');
    assert.match(draft.prompt ?? '', /^Summarize what merged/);
    assert.equal(draft.label, 'Summarize what merged yesterday into Brain');
  });
});
