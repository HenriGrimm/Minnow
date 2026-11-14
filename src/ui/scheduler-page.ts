import '../styles/scheduler-page.css';
import '../styles/automations.css';
import '../styles/settings-controls.css';

import { createAppIcon } from '../os/icons';
import { isOsAppHash, isOsShellEnabled } from '../os/page-bridge';
import { navigateToDesktop } from '../os/router';
import { mountAutomationsApp, type AutomationsApp } from './automations/app';

let initialized = false;
let statusTimer: number | undefined;
let app: AutomationsApp | null = null;

function getRoot(): HTMLElement | null {
  return document.getElementById('schedulerView');
}

function getBody(): HTMLElement | null {
  return document.getElementById('schedulerPanelMount');
}

function getStatusEl(): HTMLElement | null {
  return document.getElementById('schedulerStatus');
}

function setPanelStatus(state: 'ok' | 'err', message: string): void {
  const el = getStatusEl();
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-err', state === 'err');
  el.classList.add('is-visible');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    el.classList.remove('is-visible');
    el.textContent = '';
    el.classList.remove('is-err');
  }, 4000);
}

function ensureApp(): AutomationsApp | null {
  const body = getBody();
  if (!body) return null;
  if (app && body.classList.contains('auto-root')) return app;
  app?.dispose();
  app = mountAutomationsApp(body, {
    summary: document.getElementById('schedulerSummary'),
    controls: document.querySelector<HTMLElement>('#schedulerView .scheduler-header__controls'),
    addButton: document.getElementById('btnSchedulerAdd') as HTMLButtonElement | null,
    notify: setPanelStatus,
  });
  return app;
}

function mountHeaderIcon(): void {
  const slot = document.getElementById('schedulerPageIcon');
  if (!slot || slot.childElementCount > 0) return;
  slot.appendChild(createAppIcon('scheduler'));
}

export function initSchedulerPage(): void {
  if (initialized) return;
  initialized = true;
  mountHeaderIcon();
  if (!isOsShellEnabled()) {
    window.addEventListener('hashchange', onHashChange);
    if (
      window.location.hash === '#/scheduler' ||
      window.location.hash.startsWith('#/app/scheduler')
    ) {
      void openScheduler();
    }
  }
}

export async function openScheduler(): Promise<void> {
  const root = getRoot();
  if (!root) return;

  root.classList.add('is-open');
  mountHeaderIcon();
  await ensureApp()?.refresh();
}

export function closeScheduler(options?: { skipNavigate?: boolean }): void {
  const root = getRoot();
  if (!root) return;
  root.classList.remove('is-open');
  if (!isOsShellEnabled()) {
    if (!options?.skipNavigate && window.location.hash.startsWith('#/scheduler')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    navigateToDesktop();
  }
}

export function isSchedulerPageOpen(): boolean {
  return getRoot()?.classList.contains('is-open') ?? false;
}

/** Test hook: tear the app down between DOM setups. */
export function resetSchedulerPageForTests(): void {
  app?.dispose();
  app = null;
  initialized = false;
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash === '#/scheduler' || hash.startsWith('#/app/scheduler')) {
    void openScheduler();
    return;
  }
  if (isOsShellEnabled() && isOsAppHash(hash)) return;
  if (isSchedulerPageOpen()) {
    closeScheduler();
  }
}
