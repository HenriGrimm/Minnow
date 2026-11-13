import assert from 'node:assert/strict';
import { describe, test, afterEach, beforeEach } from 'node:test';
import { Window } from 'happy-dom';
import { initShellMenubarChrome } from '../../src/os/menubar-window-controls.ts';
import { isWideMacTrafficLights } from '../../src/os/shell-platform.ts';
import type { MinnowElectronBridge } from '../../src/electron.d.ts';

function makeWindowBridge(
  platform: NodeJS.Platform,
  overrides: Partial<NonNullable<MinnowElectronBridge['window']>> = {},
): MinnowElectronBridge {
  let maximized = false;
  const listeners = new Set<(maximized: boolean) => void>();
  return {
    preview: {} as MinnowElectronBridge['preview'],
    app: { isElectron: true, platform, openExternal: async () => {} },
    window: {
      minimize: async () => {},
      maximize: async () => {
        maximized = !maximized;
        for (const cb of listeners) cb(maximized);
      },
      close: async () => {},
      isMaximized: async () => maximized,
      onMaximizedChanged: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      ...overrides,
    },
  };
}

function installDom(): { container: HTMLDivElement } {
  const dom = new Window();
  globalThis.document = dom.document;
  globalThis.HTMLElement = dom.HTMLElement;
  globalThis.window = dom as unknown as Window & typeof globalThis.window;
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container };
}

describe('menubar-window-controls', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ container } = installDom());
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-platform');
    document.documentElement.removeAttribute('data-mac-titlebar');
  });

  afterEach(() => {
    container.remove();
  });

  test('does not mount controls without Electron preload bridge', () => {
    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);

    const cleanup = initShellMenubarChrome(menubar);
    cleanup();

    assert.equal(menubar.querySelector('.mn-os-mb-window-controls'), null);
    assert.equal(document.documentElement.classList.contains('is-electron-shell'), false);
  });

  test('mounts Win/Linux controls and toggles maximize icon on IPC callback', async () => {
    const bridge = makeWindowBridge('win32');
    (globalThis.window as Window & { minnow?: MinnowElectronBridge }).minnow = bridge;

    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);

    const cleanup = initShellMenubarChrome(menubar);

    const controls = menubar.querySelector('.mn-os-mb-window-controls');
    assert.ok(controls);
    assert.equal(menubar.lastElementChild, controls);
    assert.equal(controls!.querySelectorAll('button').length, 3);
    assert.equal(document.documentElement.classList.contains('is-electron-shell'), true);
    assert.equal(document.documentElement.dataset.platform, 'win32');
    assert.equal(menubar.classList.contains('mn-os-menubar--shell-frameless'), true);

    const maxBtn = controls!.querySelector('.mn-os-window-btn--maximize') as HTMLButtonElement;
    assert.ok(maxBtn);

    await bridge.window!.maximize();
    assert.ok(controls!.querySelector('.mn-os-window-btn--restore'));
    assert.equal(controls!.querySelector('.mn-os-window-btn--maximize'), null);

    cleanup();
    assert.equal(menubar.querySelector('.mn-os-mb-window-controls'), null);
  });

  test('skips custom controls on macOS (native traffic lights)', () => {
    (globalThis.window as Window & { minnow?: MinnowElectronBridge }).minnow = makeWindowBridge('darwin');

    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);

    initShellMenubarChrome(menubar);

    assert.equal(menubar.querySelector('.mn-os-mb-window-controls'), null);
    assert.equal(menubar.classList.contains('mn-os-menubar--shell-frameless'), true);
    assert.equal(document.documentElement.dataset.platform, 'darwin');
    assert.equal(document.documentElement.dataset.macTitlebar, undefined);
  });

  test('marks macOS 26+ for the wider traffic-light inset and clears it on cleanup', () => {
    const bridge = makeWindowBridge('darwin');
    bridge.app = { ...bridge.app!, osVersion: '26.1.0' };
    (globalThis.window as Window & { minnow?: MinnowElectronBridge }).minnow = bridge;

    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);
    const cleanup = initShellMenubarChrome(menubar);

    assert.equal(document.documentElement.dataset.macTitlebar, 'wide');
    cleanup();
    assert.equal(document.documentElement.dataset.platform, undefined);
    assert.equal(document.documentElement.dataset.macTitlebar, undefined);
  });

  test('tracks live page zoom so the inset clears native traffic lights', () => {
    let zoom = 0.9;
    const bridge = makeWindowBridge('darwin');
    bridge.app = { ...bridge.app!, getZoomFactor: () => zoom };
    (globalThis.window as Window & { minnow?: MinnowElectronBridge }).minnow = bridge;

    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);
    const cleanup = initShellMenubarChrome(menubar);

    const root = document.documentElement;
    assert.equal(root.style.getPropertyValue('--mn-shell-zoom'), '0.9');
    zoom = 1.25;
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(root.style.getPropertyValue('--mn-shell-zoom'), '1.25');
    cleanup();
    assert.equal(root.style.getPropertyValue('--mn-shell-zoom'), '');
  });

  test('isWideMacTrafficLights keys off the macOS major version', () => {
    assert.equal(isWideMacTrafficLights('26.0.1'), true);
    assert.equal(isWideMacTrafficLights('27.0'), true);
    assert.equal(isWideMacTrafficLights('15.6.1'), false);
    assert.equal(isWideMacTrafficLights(''), false);
    assert.equal(isWideMacTrafficLights(undefined), false);
  });

  test('tracks macOS full screen so the traffic-light inset can clear and return', async () => {
    let fullScreen = true;
    let emitFullScreen: ((value: boolean) => void) | undefined;
    const bridge = makeWindowBridge('darwin', {
      isFullScreen: async () => fullScreen,
      onFullScreenChanged: (callback) => {
        emitFullScreen = callback;
        return () => { emitFullScreen = undefined; };
      },
    });
    (globalThis.window as Window & { minnow?: MinnowElectronBridge }).minnow = bridge;

    const menubar = document.createElement('div');
    const right = document.createElement('div');
    menubar.appendChild(right);
    container.appendChild(menubar);
    const cleanup = initShellMenubarChrome(menubar);

    await Promise.resolve();
    assert.equal(document.documentElement.dataset.windowFullScreen, 'true');
    fullScreen = false;
    emitFullScreen?.(false);
    assert.equal(document.documentElement.dataset.windowFullScreen, 'false');
    fullScreen = true;
    emitFullScreen?.(true);
    assert.equal(document.documentElement.dataset.windowFullScreen, 'true');

    cleanup();
    assert.equal(document.documentElement.dataset.windowFullScreen, undefined);
    assert.equal(emitFullScreen, undefined);
  });
});
