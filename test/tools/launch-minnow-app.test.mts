/**
 * launch_minnow_app browser tool executor.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetAppPreferencesForTests } from '../../src/os/app-preferences.ts';
import { resetInstancesForTests } from '../../src/os/instances.ts';
import { resetOsRouterForTests } from '../../src/os/router.ts';
import { resetOsPageBridgeForTests } from '../../src/os/page-bridge.ts';
import { executeBrowserTool } from '../../src/tools/browser-executor.ts';
import { toolLaunchMinnowApp } from '../../src/tools/os-launch-tool.ts';
import type { AppId, LaunchOptions } from '../../src/os/types.ts';

describe('launch_minnow_app', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis as typeof globalThis & {
      window: Window;
      localStorage: Storage;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.localStorage = win.localStorage;
    win.localStorage.clear();
    resetAppPreferencesForTests();
  });

  afterEach(() => {
    resetAppPreferencesForTests();
  });

  test('executor returns ok JSON and calls launchApp with app_id and seed', () => {
    const calls: Array<{ appId: AppId; options?: { seed?: string } }> = [];
    const launchApp = (appId: AppId, options?: { seed?: string }) => {
      calls.push({ appId, options });
    };

    const raw = toolLaunchMinnowApp(
      { app_id: 'code', seed: 'fix auth bug in src/api' },
      launchApp,
    );
    const parsed = JSON.parse(raw) as { ok: boolean; appId: string; hash: string };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.appId, 'code');
    assert.equal(parsed.hash, '#/app/code');
    assert.deepEqual(calls, [
      { appId: 'code', options: { seed: 'fix auth bug in src/api' } },
    ]);
  });

  test('supports legacy chat app_id with seed (routes to Code)', () => {
    const calls: Array<{ appId: AppId; options?: LaunchOptions }> = [];
    const launchApp = (appId: AppId, options?: LaunchOptions) => {
      calls.push({ appId, options });
    };

    const raw = toolLaunchMinnowApp({ app_id: 'chat', seed: 'explain recursion' }, launchApp);
    const parsed = JSON.parse(raw) as { ok: boolean; appId: string; hash: string };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.appId, 'code');
    assert.equal(parsed.hash, '#/app/code/chat');
    assert.deepEqual(calls, [
      {
        appId: 'code',
        options: { seed: 'explain recursion', codeSection: 'chat' },
      },
    ]);
  });

  test('rejects invalid app_id', () => {
    const result = toolLaunchMinnowApp({ app_id: 'unknown' }, () => {});
    assert.match(result, /^Error: invalid app_id/);
  });

  test('rejects research while it is hidden for release', () => {
    const calls: AppId[] = [];
    const result = toolLaunchMinnowApp({ app_id: 'research' }, (appId) => {
      calls.push(appId);
    });
    assert.match(result, /not available/i);
    assert.deepEqual(calls, []);
  });

  test('rejects developer-hidden apps', () => {
    const calls: AppId[] = [];
    const result = toolLaunchMinnowApp({ app_id: 'bench' }, (appId) => {
      calls.push(appId);
    });
    assert.match(result, /not available/i);
    assert.deepEqual(calls, []);
  });

  test('requires app_id', () => {
    const result = toolLaunchMinnowApp({}, () => {});
    assert.equal(result, 'Error: "app_id" is required');
  });

  test('settings_query resolves memory field to Brain app', () => {
    const calls: Array<{ appId: AppId; options?: LaunchOptions }> = [];
    const launchApp = (appId: AppId, options?: LaunchOptions) => {
      calls.push({ appId, options });
    };

    const raw = toolLaunchMinnowApp(
      { app_id: 'settings', settings_query: 'memory enabled' },
      launchApp,
    );
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      appId: string;
      hash: string;
      settingsSearchKey?: string;
    };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.appId, 'brain');
    assert.equal(parsed.hash, '#/app/brain/memories');
    assert.ok(parsed.settingsSearchKey);
    assert.equal(calls[0]?.appId, 'brain');
    assert.equal(calls[0]?.options?.brainSection, 'memories');
  });
});

describe('executeBrowserTool launch_minnow_app', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
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
    win.location.hash = '#/desktop';
    resetAppPreferencesForTests();
    resetInstancesForTests();
    resetOsRouterForTests();
    resetOsPageBridgeForTests();
  });

  afterEach(() => {
    resetOsRouterForTests();
    resetInstancesForTests();
    resetOsPageBridgeForTests();
    resetAppPreferencesForTests();
  });

  test('routes launch_minnow_app and updates the OS hash', async () => {
    const result = await executeBrowserTool('launch_minnow_app', { app_id: 'scheduler' });
    const parsed = JSON.parse(result) as { ok: boolean; appId: string; hash: string };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.appId, 'scheduler');
    assert.equal(parsed.hash, '#/app/scheduler');
    assert.equal(window.location.hash, '#/app/scheduler');
  });
});
