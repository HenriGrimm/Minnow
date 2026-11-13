import '../styles/minnowos-rail.css';
import '../styles/minnowos-shell.css';
import '../styles/git-panel.css';
import '../styles/research-page.css';
import '../styles/research-panel.css';

import { initAppHost } from './app-host';
import { initAppRail } from './app-rail';
import { renderMenubar } from './menubar';
import { initWorkspaceGate } from './workspace-gate';
import { isOsShellEnabled } from './page-bridge';
import { isAppWindowRenderer } from './app-window';
import { initGraphiteWorkspace } from './graphite-workspace';
import { initGraphiteAppChrome } from './graphite-app-chrome';

let shellCleanup: (() => void) | null = null;

/** Release shell subscriptions and view-owned timers. */
export function disposeOsShell(): void {
  const cleanup = shellCleanup;
  shellCleanup = null;
  cleanup?.();
}

function ensureShellDom(): { menubar: HTMLElement } {
  let root = document.getElementById('minnowOsRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'minnowOsRoot';
    root.className = 'mn-os';
    document.body.prepend(root);
  }

  let menubar = document.getElementById('osMenubar');
  if (!menubar) {
    menubar = document.createElement('div');
    menubar.id = 'osMenubar';
    root.appendChild(menubar);
  }

  let workspace = document.getElementById('osWorkspace');
  if (!workspace) {
    workspace = document.createElement('div');
    workspace.id = 'osWorkspace';
    workspace.className = 'mn-os-workspace';
    root.appendChild(workspace);
  }

  let appRail = document.getElementById('osAppRail');
  if (!appRail) {
    appRail = document.createElement('nav');
    appRail.id = 'osAppRail';
    appRail.className = 'mn-os-app-rail';
    workspace.appendChild(appRail);
  }

  let stage = document.getElementById('osStage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'osStage';
    stage.className = 'mn-os-stage';
    workspace.appendChild(stage);
  } else if (stage.parentElement !== workspace) {
    workspace.appendChild(stage);
  }

  let workspaceGate = document.getElementById('osWorkspaceGate');
  if (!workspaceGate) {
    workspaceGate = document.createElement('div');
    workspaceGate.id = 'osWorkspaceGate';
    workspaceGate.className = 'mn-os-workspace-gate';
    workspaceGate.hidden = true;
    stage.prepend(workspaceGate);
  } else if (workspaceGate.parentElement !== stage) {
    stage.prepend(workspaceGate);
  }

  if (!document.getElementById('osAppsLayer')) {
    const appsLayer = document.createElement('div');
    appsLayer.id = 'osAppsLayer';
    appsLayer.className = 'mn-os-apps-layer';
    stage.appendChild(appsLayer);
  }

  for (const legacyId of [
    'osDesktopLayer',
    'osWindowsLayer',
    'osSidePanelsLayer',
    'osDockLayer',
  ]) {
    document.getElementById(legacyId)?.remove();
  }

  return { menubar };
}

/** Boot the Minnow Shell UI (menubar, workspace gate, app rail, app host). */
export function initOsShell(): void {
  if (!isOsShellEnabled()) return;

  disposeOsShell();

  document.documentElement.classList.add('minnow-os-enabled');

  const { menubar } = ensureShellDom();

  const cleanupMenubar = renderMenubar(menubar);
  const appWindow = isAppWindowRenderer();
  const railEl = document.getElementById('osAppRail');
  const cleanupRail = appWindow || !railEl
    ? () => {}
    : initAppRail(railEl);
  const cleanupGraphiteWorkspace = appWindow || !railEl
    ? () => {}
    : initGraphiteWorkspace(railEl, menubar);
  const cleanupAppChrome = initGraphiteAppChrome();
  if (appWindow && railEl) {
    railEl.hidden = true;
    railEl.replaceChildren();
  }
  if (!appWindow) {
    initWorkspaceGate();
  }
  shellCleanup = () => {
    window.removeEventListener('beforeunload', disposeOsShell);
    cleanupGraphiteWorkspace();
    cleanupAppChrome();
    cleanupMenubar();
    cleanupRail();
  };

  initAppHost();
  void import('../ui/product-wiki').then((module) => module.initProductWiki());
  void import('./app-focus-cycle').then((m) => {
    m.initAppFocusCycleKeyboard();
    m.syncAppSurfaceMruFromShell();
  });

  window.addEventListener('beforeunload', disposeOsShell, { once: true });
}
