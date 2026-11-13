import { getAppById } from './app-registry';
import { subscribeAppPreferences } from './app-preferences';
import {
  getForegroundAppId,
  getOsView,
  subscribeInstances,
} from './instances';
import { iconHtml } from '../ui/icon';
import { MINNOW_GLYPH_HEADER_HTML } from '../ui/minnow-glyph';
import { createAppIcon, createOsIcon } from './icons';
import { chatToggleAriaLabel, isChatToggleVisible } from './menubar-visibility';
import { initShellMenubarChrome } from './menubar-window-controls';
import { loadDefaultModelValue } from '../models/selection';
import { initUpdateMenubarPill } from './update-menubar';
import { openProductWiki } from '../ui/product-wiki';
import { bindShellOverlayTrigger, openShellOverlay, closeShellOverlay, isShellOverlayOpen } from '../ui/shell-overlay-state';
import { initAgentActivityMenubar } from '../ui/agent-activity-panel';
import { initQuickCaptureChord } from './quick-capture';
import { getCurrentRoute, navigateToCodeChat } from './router';
import { closeActiveCodeStageView } from '../ui/main-column-overlay';
import { buildMenuItems, openRegisteredMenu, subscribeMenuRegistry } from '../ui/menu-registry';

/** Render the Minnow menubar. Returns cleanup function. */
export function renderMenubar(root: HTMLElement): () => void {
  root.replaceChildren();
  root.className = 'mn-os-menubar';

  const left = document.createElement('div');
  left.className = 'mn-os-mb-left';

  const logo = document.createElement('div');
  logo.className = 'mn-os-mb-logo';
  logo.innerHTML = MINNOW_GLYPH_HEADER_HTML;

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'mn-os-mb-icon';
  back.setAttribute('aria-label', 'Back to chat');
  back.title = 'Back to chat';
  back.innerHTML = iconHtml('back', { size: 16 });
  back.addEventListener('click', async () => {
    const origin = window.location.hash;
    await closeActiveCodeStageView();
    // The route can be active before the lazy stage mounts.
    if (window.location.hash === origin && getForegroundAppId() === 'code') {
      navigateToCodeChat();
    }
  });
  left.append(logo, back);

  const brand = document.createElement('span');
  brand.className = 'mn-os-mb-brand';
  brand.textContent = 'Minnow';

  const workspaceSlot = document.createElement('div');
  workspaceSlot.id = 'osMenubarWorkspaceSlot';
  workspaceSlot.className = 'mn-os-mb-workspace-slot';
  workspaceSlot.hidden = true;

  const sep = document.createElement('span');
  sep.className = 'mn-os-mb-sep mn-os-mb-app-sep';
  sep.hidden = true;

  const appName = document.createElement('span');
  appName.className = 'mn-os-mb-appname';
  appName.hidden = true;

  const chatToggle = document.createElement('button');
  chatToggle.type = 'button';
  chatToggle.className = 'mn-os-mb-icon mn-os-mb-chat-toggle';
  chatToggle.setAttribute('aria-label', 'Chat sessions');
  chatToggle.hidden = true;
  chatToggle.innerHTML = iconHtml('menu', { size: 16 });
  chatToggle.addEventListener('click', () => {
    void import('../ui/layout').then((m) => m.toggleSidebarLayout());
  });

  left.append(brand, workspaceSlot, sep, appName, chatToggle);

  const right = document.createElement('div');
  right.className = 'mn-os-mb-right';
  right.dataset.pluginSlot = 'menubar';
  const pluginMenu = document.createElement('button');
  pluginMenu.type = 'button';
  pluginMenu.className = 'mn-os-mb-icon';
  pluginMenu.title = 'Plugin commands';
  pluginMenu.setAttribute('aria-label', 'Plugin commands');
  pluginMenu.setAttribute('aria-haspopup', 'menu');
  pluginMenu.appendChild(createOsIcon('grid', { size: 16 }));
  const pluginMenuTarget = { kind: 'menubar.plugins' };
  const syncPluginMenu = () => { pluginMenu.hidden = buildMenuItems(pluginMenuTarget).length === 0; };
  const cleanupPluginState = bindShellOverlayTrigger(pluginMenu, 'plugins');
  pluginMenu.addEventListener('click', () => {
    if (isShellOverlayOpen('plugins')) closeShellOverlay();
    else openRegisteredMenu({
      target: pluginMenuTarget, label: 'Plugin commands', anchor: pluginMenu, restoreFocus: pluginMenu,
    });
  });
  syncPluginMenu();
  const cleanupPluginMenu = subscribeMenuRegistry(syncPluginMenu);

  const modelChipAnchor = document.createElement('button');
  modelChipAnchor.type = 'button'; modelChipAnchor.className = 'mn-os-mb-icon';
  modelChipAnchor.title = 'Models'; modelChipAnchor.setAttribute('aria-label', 'Models');
  modelChipAnchor.setAttribute('aria-haspopup', 'dialog'); modelChipAnchor.setAttribute('aria-controls', 'modelsSystemPopover');
  modelChipAnchor.innerHTML = iconHtml('appModels', { size: 16 });
  const unbindModels = bindShellOverlayTrigger(modelChipAnchor, 'models');
  let closeModels: (() => void) | undefined;
  let modelsRequest = 0;
  modelChipAnchor.onclick = () => {
    if (isShellOverlayOpen('models')) closeShellOverlay();
    else {
      const request = ++modelsRequest;
      openShellOverlay('models', () => { modelsRequest++; });
      void import('../ui/models-popover').then((module) => {
        if (request === modelsRequest && isShellOverlayOpen('models')) closeModels = module.openModelsPopover(modelChipAnchor);
      }).catch(() => { if (request === modelsRequest) closeShellOverlay(); });
    }
  };
  let refreshingSelection = false;
  const refreshSelection = () => {
    if (document.hidden || refreshingSelection) return;
    refreshingSelection = true;
    void loadDefaultModelValue().catch(() => {}).finally(() => { refreshingSelection = false; });
  };
  window.addEventListener('focus', refreshSelection);
  const selectionTimer = window.setInterval(refreshSelection, 5000);
  const cleanupModelChip = () => { modelsRequest++; if (isShellOverlayOpen('models')) closeShellOverlay(); closeModels?.(); unbindModels(); window.clearInterval(selectionTimer); window.removeEventListener('focus', refreshSelection); };

  const activityBtn = document.createElement('button');
  activityBtn.type = 'button';
  const cleanupActivity = initAgentActivityMenubar(activityBtn, { bell: true });

  const cleanupQuickCapture = initQuickCaptureChord();

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'mn-os-mb-icon mn-os-mb-search';
  searchBtn.setAttribute('aria-label', 'Search chats and commands');
  searchBtn.setAttribute('aria-haspopup', 'dialog');
  searchBtn.title = 'Search chats and commands (Ctrl/Cmd+Shift+P)';
  searchBtn.innerHTML = iconHtml('search', { size: 16 });
  searchBtn.addEventListener('click', () => {
    void import('../ui/command-palette').then((m) => {
      if (m.isCommandPaletteOpen()) m.closeCommandPalette();
      else m.openCommandPalette();
    });
  });
  const cleanupSearchState = bindShellOverlayTrigger(searchBtn, 'search');

  const updateSlot = document.createElement('div');
  updateSlot.id = 'osMenubarUpdateSlot';
  updateSlot.className = 'mn-os-mb-update-slot';
  updateSlot.hidden = true;
  const cleanupUpdatePill = initUpdateMenubarPill(updateSlot);

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'mn-os-mb-icon';
  settingsBtn.dataset.graphiteWorkspaceSettings = '';
  settingsBtn.dataset.appId = 'settings';
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.appendChild(createOsIcon('gear', { size: 16 }));
  const cleanupSettingsState = bindShellOverlayTrigger(settingsBtn, 'settings');
  settingsBtn.setAttribute('aria-controls', 'settingsView');
  settingsBtn.addEventListener('click', () => {
    void import('../ui/settings-page').then((m) => {
      if (!isShellOverlayOpen('settings')) closeShellOverlay();
      m.openSettingsFromTopbar();
    });
  });

  const wikiBtn = document.createElement('button');
  wikiBtn.type = 'button';
  wikiBtn.className = 'mn-os-mb-icon';
  wikiBtn.setAttribute('aria-label', 'Minnow wiki — User manual');
  wikiBtn.title = 'Minnow wiki — User manual';
  wikiBtn.innerHTML = iconHtml('help', { size: 16 });
  const cleanupWikiState = bindShellOverlayTrigger(wikiBtn, 'wiki');
  wikiBtn.setAttribute('aria-controls', 'productWikiOverlay');
  wikiBtn.addEventListener('click', () => {
    if (isShellOverlayOpen('wiki')) closeShellOverlay();
    else openProductWiki();
  });

  const workspaceActions = document.createElement('div');
  workspaceActions.className = 'mn-os-workspace-actions';
  workspaceActions.append(activityBtn, modelChipAnchor, wikiBtn, searchBtn, updateSlot, settingsBtn);
  right.append(pluginMenu, workspaceActions);
  root.append(left, right);

  const cleanupShellChrome = initShellMenubarChrome(root);

  function syncSidebarToggle(): void {
    const desktop = document.documentElement.classList.contains('mn-graphite-workspace');
    const sidebar = document.getElementById('chatSidebar');
    const visible = sidebar && !sidebar.classList.contains('collapsed');
    brand.hidden = getOsView() !== 'workspaces' && !(desktop && visible);
    if (desktop && getOsView() === 'app') {
      chatToggle.hidden = false;
      chatToggle.setAttribute('aria-controls', 'chatSidebar');
      chatToggle.setAttribute('aria-expanded', String(Boolean(visible)));
      chatToggle.setAttribute('aria-label', visible ? 'Hide sidebar' : 'Show sidebar');
      chatToggle.innerHTML = iconHtml('sidebar', { size: 16 });
      return;
    }
    chatToggle.hidden = !isChatToggleVisible(getForegroundAppId()) || Boolean(document.documentElement.dataset.appWindow);
    const label = chatToggleAriaLabel(getForegroundAppId());
    if (label) chatToggle.setAttribute('aria-label', label);
    chatToggle.removeAttribute('aria-controls');
    chatToggle.removeAttribute('aria-expanded');
    chatToggle.innerHTML = iconHtml('menu', { size: 16 });
  }

  function syncMenubar(): void {
    const view = getOsView();
    const fgApp = getForegroundAppId();
    const onWorkspaces = view === 'workspaces';
    const section = fgApp === 'code' ? getCurrentRoute().codeSection : undefined;
    logo.hidden = Boolean(section && section !== 'chat');
    back.hidden = !logo.hidden;

    root.dataset.view = onWorkspaces ? 'workspaces' : 'app';
    sep.hidden = onWorkspaces;
    appName.hidden = onWorkspaces;

    if (!onWorkspaces && fgApp) {
      const meta = getAppById(fgApp);
      appName.replaceChildren();
      if (meta) {
        appName.appendChild(createAppIcon(meta.icon as 'code'));
        appName.appendChild(document.createTextNode(` ${meta.name}`));
      }
    }

    syncSidebarToggle();

    settingsBtn.hidden = Boolean(document.documentElement.dataset.appWindow);

    void import('./workspace-menubar').then((m) => m.syncWorkspaceMenubarPlacement());
  }

  syncMenubar();
  const unsub = subscribeInstances(syncMenubar);
  const unsubPrefs = subscribeAppPreferences(syncMenubar);
  window.addEventListener('minnow:graphite-workspace-changed', syncSidebarToggle);

  return () => {
    cleanupPluginState();
    cleanupSearchState();
    cleanupSettingsState();
    cleanupWikiState();
    unsub();
    unsubPrefs();
    window.removeEventListener('minnow:graphite-workspace-changed', syncSidebarToggle);
    cleanupModelChip();
    cleanupActivity();
    cleanupQuickCapture();
    cleanupUpdatePill();
    cleanupShellChrome();
    cleanupPluginMenu();
  };
}
