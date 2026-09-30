import { isMinnowElectronShell } from '../tools/minnow-shell';
import {
  createWindowControlButton,
  setWindowControlButtonKind,
} from './window-control-buttons';

function shellWindowApi(): NonNullable<typeof window.minnow>['window'] | null {
  return window.minnow?.window ?? null;
}

function isDarwinShell(): boolean {
  return window.minnow?.app?.platform === 'darwin';
}

/** Mark interactive menubar nodes as non-drag so window drag regions stay usable. */
function markMenubarNoDrag(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(
    'button, a, input, select, textarea, [contenteditable="true"], .mn-os-mb-window-controls',
  ).forEach((el) => {
    el.style.webkitAppRegion = 'no-drag';
  });
}

/** Mount Win/Linux shell window controls and wire drag + maximize sync for frameless Electron. */
export function initShellMenubarChrome(
  menubarRoot: HTMLElement,
  rightCluster: HTMLElement,
): () => void {
  if (!isMinnowElectronShell()) return () => {};

  const platform = window.minnow?.app?.platform;
  if (platform) {
    document.documentElement.dataset.platform = platform;
  }
  document.documentElement.classList.add('is-electron-shell');
  menubarRoot.classList.add('mn-os-menubar--shell-frameless');
  markMenubarNoDrag(menubarRoot);

  const cleanups: Array<() => void> = [];
  const windowApi = shellWindowApi();

  let maxBtn: HTMLButtonElement | null = null;
  let syncedMaximizedFromEvent = false;

  if (isDarwinShell() && windowApi?.isFullScreen && windowApi.onFullScreenChanged) {
    let syncedFullScreenFromEvent = false;
    let disposed = false;
    const applyFullScreen = (fullScreen: boolean): void => {
      if (disposed) return;
      syncedFullScreenFromEvent = true;
      document.documentElement.dataset.windowFullScreen = String(fullScreen);
    };
    cleanups.push(windowApi.onFullScreenChanged(applyFullScreen));
    cleanups.push(() => { disposed = true; });
    void windowApi.isFullScreen().then((initial) => {
      if (!disposed && !syncedFullScreenFromEvent) applyFullScreen(initial);
    });
  }

  const applyMaximized = (maximized: boolean): void => {
    syncedMaximizedFromEvent = true;
    if (!maxBtn) return;
    if (maximized) {
      setWindowControlButtonKind(maxBtn, 'restore', 'Restore');
    } else {
      setWindowControlButtonKind(maxBtn, 'maximize', 'Maximize');
    }
  };

  if (!isDarwinShell() && windowApi) {
    const controls = document.createElement('div');
    controls.className = 'mn-os-mb-window-controls';
    controls.setAttribute('role', 'toolbar');
    controls.setAttribute('aria-label', 'Window controls');
    controls.style.webkitAppRegion = 'no-drag';

    const minBtn = createWindowControlButton('minimize', 'Minimize', () => {
      void windowApi.minimize();
    });
    maxBtn = createWindowControlButton('maximize', 'Maximize', () => {
      void windowApi.maximize();
    });
    const closeBtn = createWindowControlButton('close', 'Close Minnow', () => {
      void windowApi.close();
    });

    controls.append(minBtn, maxBtn, closeBtn);
    rightCluster.appendChild(controls);

    void windowApi.isMaximized().then((initial) => {
      if (!syncedMaximizedFromEvent) applyMaximized(initial);
    });
    cleanups.push(windowApi.onMaximizedChanged(applyMaximized));
    cleanups.push(() => controls.remove());
  }

  const onDblClick = (ev: MouseEvent): void => {
    const target = ev.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;
    void windowApi?.maximize();
  };
  menubarRoot.addEventListener('dblclick', onDblClick);
  cleanups.push(() => menubarRoot.removeEventListener('dblclick', onDblClick));

  return () => {
    for (const fn of cleanups) fn();
    menubarRoot.classList.remove('mn-os-menubar--shell-frameless');
    document.documentElement.classList.remove('is-electron-shell');
    document.documentElement.removeAttribute('data-platform');
    document.documentElement.removeAttribute('data-window-full-screen');
  };
}
