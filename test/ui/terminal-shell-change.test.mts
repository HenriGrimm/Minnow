/**
 * MIN-541: Shell menu creates tabs without changing the configured default.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { resetTerminalMetaCache } from '../../src/config/terminal-meta.ts';
import {
  detachAllTerminalTabs,
  initTerminalTabs,
} from '../../src/ui/terminal-tabs.ts';
import { closeContextMenu } from '../../src/ui/context-menu.ts';
import { saveTerminalMeta, getTerminalMetaCached } from '../../src/config/terminal-meta.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';

const PTY_TAB_ID = '11111111-1111-1111-1111-111111111111';
const NEW_SESSION_ID = '22222222-2222-2222-2222-222222222222';

let prevFetch: typeof fetch | undefined;
let putBodies: unknown[] = [];
let configuredDefault: string | undefined = 'powershell';
let apiDefault = 'powershell';

/** Stub config, shell profiles, and PTY session creation. */
function installFetchMock(): void {
  prevFetch = globalThis.fetch;
  putBodies = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('/api/terminal/shell-profiles')) {
      return Response.json({
        profiles: [
          {
            id: 'powershell',
            label: 'PowerShell',
            shell: 'powershell.exe',
            args: [],
            platform: 'win32',
          },
          {
            id: 'bash',
            label: 'bash',
            shell: '/bin/bash',
            args: [],
            platform: 'linux',
          },
        ],
        ptyAvailable: true,
        defaultShellProfileId: apiDefault,
      });
    }

    if (url.includes('/api/terminal/session') && method === 'POST') {
      return Response.json({
        sessionId: NEW_SESSION_ID,
        shell: '/bin/bash',
        shellProfileId: 'bash',
        cwd: '/workspace',
        cols: 80,
        rows: 24,
      });
    }

    if (url.includes('/api/config/meta') && method === 'GET') {
      return Response.json({
        terminal: {
          open: true,
          heightPx: 240,
          tabs: [
            {
              id: PTY_TAB_ID,
              shellProfileId: 'powershell',
              title: 'PowerShell',
              order: 0,
            },
          ],
          activeTabId: PTY_TAB_ID,
          defaultShellProfileId: configuredDefault,
        },
      });
    }

    if (url.includes('/api/config/meta') && method === 'PUT') {
      putBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  };
}

function installWebSocketMock(): void {
  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    url: string;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => this.onopen?.());
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }

    send(): void {}
  }

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}

function restoreFetchMock(): void {
  if (prevFetch) {
    globalThis.fetch = prevFetch;
    prevFetch = undefined;
  }
}

function setupDom(): void {
  const window = new Window();
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  document.body.innerHTML = `
    <div id="terminalXtermHost"></div>
    <div id="terminalTabBar"></div>
  `;
}

function countPtyTabs(tabBar: HTMLElement): number {
  return tabBar.querySelectorAll(
  '.terminal-tab-list .terminal-tab:not(.terminal-tab--agent):not(.terminal-tab--dev-server)',
  ).length;
}

describe('terminal new-tab shell menu (MIN-541)', () => {
  beforeEach(() => {
    resetTerminalMetaCache();
    configuredDefault = 'powershell';
    apiDefault = 'powershell';
    installFetchMock();
    installWebSocketMock();
    setLocalServerAvailableForTests(true);
    setupDom();
  });

  afterEach(async () => {
    closeContextMenu();
    await detachAllTerminalTabs();
    resetTerminalMetaCache();
    setLocalServerAvailableForTests(false);
    restoreFetchMock();
  });

  async function initTabs(): Promise<HTMLElement> {
    const tabBar = document.getElementById('terminalTabBar')!;
    const { initTerminalXterm } = await import('../../src/ui/terminal-xterm.ts');
    initTerminalXterm(document.getElementById('terminalXtermHost')!);
    await initTerminalTabs(tabBar);
    return tabBar;
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test('menu lists shells and opens a new tab without changing the default or existing tabs', async () => {
    const tabBar = await initTabs();
    assert.equal(countPtyTabs(tabBar), 1);
    assert.equal(document.querySelector('select'), null);
    tabBar.querySelector<HTMLButtonElement>('.terminal-tab-shell-menu')!.click();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.mn-menu__item')];
    assert.deepEqual(rows.map((row) => row.textContent), ['PowerShell', 'bash']);
    rows[1].click();
    await settle();
    assert.equal(countPtyTabs(tabBar), 2);
    const tabs = getTerminalMetaCached().tabs!;
    assert.equal(tabs.find((tab) => tab.id === PTY_TAB_ID)?.shellProfileId, 'powershell');
    assert.equal(tabs.find((tab) => tab.id !== PTY_TAB_ID)?.shellProfileId, 'bash');
    assert.equal(getTerminalMetaCached().defaultShellProfileId, 'powershell');
    assert.ok(!putBodies.some((body: any) => body.terminal?.defaultShellProfileId === 'bash'));

    tabBar.querySelector<HTMLButtonElement>('.terminal-tab-add')!.click();
    await settle();
    assert.equal(getTerminalMetaCached().tabs!.at(-1)?.shellProfileId, 'powershell');
  });

  test('+ reads the latest default saved in Settings', async () => {
    const tabBar = await initTabs();
    await saveTerminalMeta({ defaultShellProfileId: 'bash' });
    tabBar.querySelector<HTMLButtonElement>('.terminal-tab-add')!.click();
    await settle();
    assert.equal(getTerminalMetaCached().tabs!.at(-1)?.shellProfileId, 'bash');
  });

  for (const shell of ['powershell', 'bash']) {
    test('+ uses the server platform default when no preference is saved: ' + shell, async () => {
      configuredDefault = undefined;
      apiDefault = shell;
      const tabBar = await initTabs();
      tabBar.querySelector<HTMLButtonElement>('.terminal-tab-add')!.click();
      await settle();
      assert.equal(getTerminalMetaCached().tabs!.at(-1)?.shellProfileId, shell);
    });
  }

  test('shell menu supports keyboard dismissal and restores focus', async () => {
    const tabBar = await initTabs();
    const trigger = tabBar.querySelector<HTMLButtonElement>('.terminal-tab-shell-menu')!;
    trigger.click();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
  });
});
