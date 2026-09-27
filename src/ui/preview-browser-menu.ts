import type {
  MinnowPreviewBrowserActionResult,
  MinnowPreviewBrowserMenuApi,
} from '../electron';
import { appConfirm } from './app-dialog';
import { clearBrowserHistory } from './browser-history';
import { closeBrowserHistoryPopover } from './browser-url-suggest';
import { registerChromePopover, unregisterChromePopover } from './preview-electron-visibility';
import { showToast } from './toast';

const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

export type PreviewBrowserMenuAction =
  | 'hard-reload'
  | 'copy-url'
  | 'copy-screenshot'
  | 'clear-history'
  | 'clear-cookies'
  | 'clear-cache';

export interface PreviewBrowserActionDependencies {
  api: MinnowPreviewBrowserMenuApi;
  address: string;
  tabId?: string;
  instanceId?: string;
  confirm: typeof appConfirm;
  clearHistory: typeof clearBrowserHistory;
  notify: typeof showToast;
}

export interface PreviewBrowserMenuOptions {
  tabId: () => string | null;
  address: () => string;
  instanceId?: string;
  onClose?: () => void;
}

let openMenu: HTMLElement | null = null;
let openAnchor: HTMLButtonElement | null = null;
let cleanupOpenMenu: (() => void) | null = null;
let onOpenMenuClose: (() => void) | null = null;

function nextZoom(current: number, direction: 'in' | 'out'): number {
  if (direction === 'in') return ZOOM_STEPS.find((value) => value > current) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((value) => value < current) ?? ZOOM_STEPS[0]!;
}

function actionFailure(result: MinnowPreviewBrowserActionResult, fallback: string): string | null {
  return result.ok ? null : result.error || fallback;
}

export async function executePreviewBrowserMenuAction(
  action: PreviewBrowserMenuAction,
  deps: PreviewBrowserActionDependencies,
): Promise<void> {
  const { api, address, tabId, instanceId, confirm, clearHistory, notify } = deps;
  if (action === 'hard-reload') {
    const error = actionFailure(await api.hardReload(tabId, instanceId), 'Could not hard reload');
    if (error) notify(error, 'error');
    return;
  }
  if (action === 'copy-url') {
    const error = actionFailure(await api.copyUrl(address, tabId, instanceId), 'Could not copy URL');
    notify(error ?? 'URL copied', error ? 'error' : 'success');
    return;
  }
  if (action === 'copy-screenshot') {
    const error = actionFailure(
      await api.copyScreenshot(tabId, instanceId),
      'Could not copy screenshot',
    );
    notify(error ?? 'Screenshot copied to clipboard', error ? 'error' : 'success');
    return;
  }
  if (action === 'clear-history') {
    const ok = await confirm(
      'Clear saved pages and tab navigation from the in-app browser? Your OS browser history is not affected.',
      { title: 'Clear browsing history', confirmLabel: 'Clear history', danger: true },
    );
    if (!ok) return;
    clearHistory();
    const error = actionFailure(await api.clearHistory(), 'Could not clear tab navigation');
    notify(error ?? 'In-app browser history cleared', error ? 'error' : 'success');
    return;
  }
  if (action === 'clear-cookies') {
    const ok = await confirm(
      'Clear cookies from the in-app browser only? You may be signed out of sites in preview tabs.',
      { title: 'Clear in-app browser cookies', confirmLabel: 'Clear cookies', danger: true },
    );
    if (!ok) return;
    const error = actionFailure(await api.clearCookies(), 'Could not clear cookies');
    notify(error ?? 'In-app browser cookies cleared', error ? 'error' : 'success');
    return;
  }
  const ok = await confirm(
    'Clear cached files from the in-app browser only? Pages may load more slowly the next time you open them.',
    { title: 'Clear in-app browser cache', confirmLabel: 'Clear cache', danger: true },
  );
  if (!ok) return;
  const error = actionFailure(await api.clearCache(), 'Could not clear cache');
  notify(error ?? 'In-app browser cache cleared', error ? 'error' : 'success');
}

export function closePreviewBrowserMenu(options?: { restoreFocus?: boolean }): void {
  if (!openMenu) return;
  cleanupOpenMenu?.();
  cleanupOpenMenu = null;
  openMenu.remove();
  openMenu = null;
  unregisterChromePopover();
  openAnchor?.setAttribute('aria-expanded', 'false');
  if (options?.restoreFocus) openAnchor?.focus();
  openAnchor = null;
  const onClose = onOpenMenuClose;
  onOpenMenuClose = null;
  onClose?.();
}

function menuItem(
  label: string,
  action: PreviewBrowserMenuAction,
  run: (action: PreviewBrowserMenuAction) => void,
  options?: { danger?: boolean; hint?: string },
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'preview-browser-menu__item';
  button.dataset.action = action;
  button.setAttribute('role', 'menuitem');
  if (options?.danger) button.classList.add('preview-browser-menu__item--danger');
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  if (options?.hint) {
    const hint = document.createElement('span');
    hint.className = 'preview-browser-menu__hint';
    hint.textContent = options.hint;
    button.appendChild(hint);
  }
  button.addEventListener('click', () => run(action));
  return button;
}

function separator(): HTMLElement {
  const node = document.createElement('div');
  node.className = 'preview-browser-menu__separator';
  node.setAttribute('role', 'separator');
  return node;
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
}

async function openPreviewBrowserMenu(
  anchor: HTMLButtonElement,
  options: PreviewBrowserMenuOptions,
): Promise<void> {
  const api = window.minnow?.preview.browserMenu;
  if (!api) return;
  if (openMenu) closePreviewBrowserMenu();
  closeBrowserHistoryPopover();

  const tabId = options.tabId() ?? undefined;
  const instanceId = options.instanceId;
  const menu = document.createElement('div');
  menu.className = 'preview-browser-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Browser menu');

  const zoom = document.createElement('div');
  zoom.className = 'preview-browser-menu__zoom';
  zoom.setAttribute('role', 'group');
  zoom.setAttribute('aria-label', 'Page zoom');
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'preview-browser-menu__zoom-label';
  zoomLabel.textContent = 'Zoom';
  const zoomOut = document.createElement('button');
  zoomOut.type = 'button';
  zoomOut.className = 'preview-browser-menu__zoom-button';
  zoomOut.setAttribute('aria-label', 'Zoom out');
  zoomOut.textContent = '−';
  const zoomValue = document.createElement('button');
  zoomValue.type = 'button';
  zoomValue.className = 'preview-browser-menu__zoom-value';
  zoomValue.title = 'Reset zoom';
  zoomValue.setAttribute('aria-label', 'Reset page zoom');
  const zoomIn = document.createElement('button');
  zoomIn.type = 'button';
  zoomIn.className = 'preview-browser-menu__zoom-button';
  zoomIn.setAttribute('aria-label', 'Zoom in');
  zoomIn.textContent = '+';
  zoom.append(zoomLabel, zoomOut, zoomValue, zoomIn);
  menu.appendChild(zoom);

  let currentZoom = 100;
  const setZoomLabel = (value: number): void => {
    currentZoom = value;
    zoomValue.textContent = `${value}%`;
    zoomOut.disabled = value <= ZOOM_STEPS[0]!;
    zoomIn.disabled = value >= ZOOM_STEPS.at(-1)!;
  };
  setZoomLabel(currentZoom);
  const applyZoom = async (value: number): Promise<void> => {
    try {
      setZoomLabel(await api.setZoom(value, tabId, instanceId));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not change page zoom', 'error');
    }
  };
  zoomOut.addEventListener('click', () => void applyZoom(nextZoom(currentZoom, 'out')));
  zoomIn.addEventListener('click', () => void applyZoom(nextZoom(currentZoom, 'in')));
  zoomValue.addEventListener('click', () => void applyZoom(100));

  const run = (action: PreviewBrowserMenuAction): void => {
    closePreviewBrowserMenu();
    void executePreviewBrowserMenuAction(action, {
      api,
      address: options.address(),
      tabId,
      instanceId,
      confirm: appConfirm,
      clearHistory: clearBrowserHistory,
      notify: showToast,
    })
      .catch((error) => {
        showToast(error instanceof Error ? error.message : 'Browser action failed', 'error');
      })
      .finally(() => options.onClose?.());
  };

  menu.append(
    separator(),
    menuItem('Hard reload', 'hard-reload', run, { hint: 'Ignore cached files' }),
    menuItem('Copy URL', 'copy-url', run),
    menuItem('Copy screenshot to clipboard', 'copy-screenshot', run),
    separator(),
  );
  const dataLabel = document.createElement('div');
  dataLabel.className = 'preview-browser-menu__section-label';
  dataLabel.textContent = 'In-app browser data';
  menu.append(
    dataLabel,
    menuItem('Clear browsing history', 'clear-history', run, { danger: true }),
    menuItem('Clear cookies', 'clear-cookies', run, { danger: true }),
    menuItem('Clear cache', 'clear-cache', run, { danger: true }),
  );

  document.body.appendChild(menu);
  openMenu = menu;
  openAnchor = anchor;
  onOpenMenuClose = options.onClose ?? null;
  anchor.setAttribute('aria-expanded', 'true');
  registerChromePopover();
  positionMenu(menu, anchor);
  void window.minnow?.preview.hide(tabId, instanceId);
  void api.getZoom(tabId, instanceId).then(setZoomLabel, () => setZoomLabel(100));
  menu.querySelector<HTMLButtonElement>('.preview-browser-menu__zoom-button')?.focus();

  const onPointerDown = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (target && (menu.contains(target) || anchor.contains(target))) return;
    closePreviewBrowserMenu();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closePreviewBrowserMenu({ restoreFocus: true });
  };
  const onResize = (): void => closePreviewBrowserMenu();
  document.addEventListener('mousedown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onResize);
  cleanupOpenMenu = () => {
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
  };
}

export function bindPreviewBrowserMenu(
  anchor: HTMLButtonElement | null,
  options: PreviewBrowserMenuOptions,
): void {
  if (!anchor || anchor.dataset.previewBrowserMenu === '1') return;
  anchor.dataset.previewBrowserMenu = '1';
  if (!window.minnow?.preview.browserMenu) {
    anchor.hidden = true;
    return;
  }
  anchor.hidden = false;
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.addEventListener('click', () => {
    if (openAnchor === anchor) {
      closePreviewBrowserMenu();
      return;
    }
    void openPreviewBrowserMenu(anchor, options);
  });
}
