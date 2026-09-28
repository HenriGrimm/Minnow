import { getForegroundAppId, getOsView, subscribeInstances } from './instances';
import { isResearchPanelOpen, subscribeResearchPanel } from '../ui/research-panel';
import type { AppId } from './types';
import { isAppAvailable } from './app-preferences';
import { isDeveloperReleased } from './app-registry';

function gateOpenClass(): boolean {
  return document.documentElement.classList.contains('os-workspace-gate-open');
}

/** Feature flag — OS shell is always enabled in workspace-first builds. */
export function isOsShellEnabled(): boolean {
  return true;
}

/** Whether the hash belongs to the Minnow Shell (workspace gate or foreground app). */
export function isOsAppHash(hash?: string): boolean {
  const h = hash ?? window.location.hash;
  return h === '#/workspaces' || h === '#/desktop' || h.startsWith('#/app/');
}

/** Settings embedded in the OS apps layer (not legacy full-page swap). */
export function isOsEmbedded(): boolean {
  return isOsShellEnabled();
}

/** True when Code is the active fullscreen app. */
function isCodeForeground(): boolean {
  return getForegroundAppId() === 'code';
}

/** True when the legacy chat workspace (`#appBody`) should be hidden. */
export function shouldHideAppBody(): boolean {
  if (!isOsShellEnabled()) return false;
  if (isCodeForeground()) return false;
  if (isResearchPanelOpen()) return false;
  if (getOsView() === 'workspaces') return true;
  return getForegroundAppId() !== 'code';
}

/** Hide or show legacy chrome (topbar + chat shell) for the OS shell. */
export function syncLegacyChromeVisibility(): void {
  if (!isOsShellEnabled()) return;

  const hideLegacy = shouldHideAppBody();
  const appBody = document.getElementById('appBody');
  const topbar = document.querySelector('header.topbar');

  appBody?.classList.toggle('hidden', hideLegacy);
  topbar?.classList.toggle('hidden', hideLegacy);

  document.getElementById('btnBenchmark')?.toggleAttribute('hidden', !isAppAvailable('bench'));
  document.getElementById('btnExpertLab')?.toggleAttribute('hidden', !isAppAvailable('experts'));
  document
    .getElementById('expertsSection')
    ?.toggleAttribute('hidden', !isDeveloperReleased('experts'));

  const view = getOsView();
  const onWorkspaces = view === 'workspaces';
  document.documentElement.classList.toggle('os-workspaces', onWorkspaces);
  document.documentElement.classList.toggle('os-in-app', view === 'app');
  document.documentElement.classList.toggle('os-workspace-gate', onWorkspaces && gateOpenClass());

  const fg = getForegroundAppId();
  if (fg) {
    document.documentElement.dataset.osApp = fg;
  } else {
    delete document.documentElement.dataset.osApp;
  }

  void import('../ui/preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  void import('./workspace-menubar').then((m) => m.syncWorkspaceMenubarPlacement());

  void import('../ui/loop-active-hint').then(({ syncLoopActiveHint }) => {
    syncLoopActiveHint();
  });
}

/** Called when an app becomes foreground — sync DOM + dataset for page modules. */
export function osOnAppOpen(appId: AppId): void {
  if (!isOsShellEnabled()) return;
  document.documentElement.dataset.osApp = appId;
  if (appId === 'code') {
    void import('../ui/preview-panel').then((preview) => {
      preview.collapsePreviewPanelKeepingSource();
    });
  }
  syncLegacyChromeVisibility();
}

/** Called when a foreground app is replaced or the shell returns to the workspace gate. */
export function osOnAppClose(appId: AppId): void {
  if (!isOsShellEnabled()) return;
  if (appId === 'brain') {
    void import('../ui/brain-page').then((m) => m.suspendBrainAppSurface());
  }
  if (appId === 'code') {
    void import('../state/sessions').then(({ sessionState }) => {
      const activeId = sessionState?.activeId;
      if (!activeId) return;
      void import('../ui/orchestrate-plan-screen').then(({ suspendOrchestratePlanScreenOnAppLeave }) => {
        suspendOrchestratePlanScreenOnAppLeave(activeId);
      });
    });
  }
  if (document.documentElement.dataset.osApp === appId) {
    delete document.documentElement.dataset.osApp;
  }
  syncLegacyChromeVisibility();
}

let visibilityBound = false;

/** Keep legacy chrome in sync whenever instance/view state changes. */
export function initOsPageBridge(): void {
  if (visibilityBound || !isOsShellEnabled()) return;
  visibilityBound = true;
  subscribeInstances(() => {
    syncLegacyChromeVisibility();
  });
  subscribeResearchPanel(() => syncLegacyChromeVisibility());
  syncLegacyChromeVisibility();
}

/** Reset bridge bindings (tests). */
export function resetOsPageBridgeForTests(): void {
  visibilityBound = false;
  delete document.documentElement.dataset.osApp;
  document.documentElement.classList.remove(
    'os-workspaces',
    'os-in-app',
    'os-workspace-gate',
    'os-workspace-gate-open',
  );
}
