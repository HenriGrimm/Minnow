import { getAppById } from './app-registry';
import { subscribeAppPreferences } from './app-preferences';
import {
  getForegroundAppId,
  getOsView,
  subscribeInstances,
} from './instances';
import { getUnreadNotificationCount } from './notifications-menu';
import { onNewNotification } from '../notifications/push';
import { subscribeNotifications } from '../notifications/store';
import { iconHtml } from '../ui/icon';
import { launchApp } from './router';
import { MINNOW_GLYPH_HEADER_HTML } from '../ui/minnow-glyph';
import { createAppIcon, createOsIcon } from './icons';
import { chatToggleAriaLabel, isChatToggleVisible } from './menubar-visibility';
import { initOsNotificationsMenu } from './notifications-menu';
import { initShellMenubarChrome } from './menubar-window-controls';
import { initMenubarModelChip } from './menubar-model-chip';
import { initUpdateMenubarPill } from './update-menubar';
import { openProductWiki } from '../ui/product-wiki';
import { initAgentActivityMenubar } from '../ui/agent-activity-panel';
import { initMenubarCapture } from './menubar-capture';

/** Render the Minnow menubar. Returns cleanup function. */
export function renderMenubar(root: HTMLElement): () => void {
  root.replaceChildren();
  root.className = 'mn-os-menubar';

  const left = document.createElement('div');
  left.className = 'mn-os-mb-left';

  const logo = document.createElement('div');
  logo.className = 'mn-os-mb-logo';
  logo.innerHTML = MINNOW_GLYPH_HEADER_HTML;
  left.appendChild(logo);

  const brand = document.createElement('span');
  brand.className = 'mn-os-mb-brand';
  brand.textContent = 'Minnow';

  const statusPill = document.createElement('div');
  statusPill.className = 'mn-os-mb-status status-pill';
  statusPill.setAttribute('role', 'status');
  statusPill.setAttribute('aria-live', 'polite');
  const statusDot = document.createElement('div');
  statusDot.className = 's-dot';
  statusDot.id = 'osStatusDot';
  statusDot.setAttribute('aria-hidden', 'true');
  const statusText = document.createElement('span');
  statusText.id = 'osStatusText';
  statusText.textContent = 'Loading models…';
  statusPill.append(statusDot, statusText);
  const legacyDot = document.getElementById('sDot');
  const legacyText = document.getElementById('sText');
  if (legacyDot && legacyText) {
    statusDot.className = legacyDot.className;
    statusText.textContent = legacyText.textContent?.trim() || 'Loading models…';
    const title = legacyText.getAttribute('title');
    if (title) statusText.setAttribute('title', title);
  }

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

  const statusSep = document.createElement('span');
  statusSep.className = 'mn-os-mb-sep mn-os-mb-status-sep';

  const chatToggle = document.createElement('button');
  chatToggle.type = 'button';
  chatToggle.className = 'mn-os-mb-icon mn-os-mb-chat-toggle';
  chatToggle.setAttribute('aria-label', 'Chat sessions');
  chatToggle.hidden = true;
  chatToggle.innerHTML = iconHtml('menu', { size: 16 });
  chatToggle.addEventListener('click', () => {
    void import('../ui/layout').then((m) => m.toggleSidebarLayout());
  });

  left.append(brand, workspaceSlot, sep, appName, statusSep, statusPill, chatToggle);

  const right = document.createElement('div');
  right.className = 'mn-os-mb-right';

  const modelChipAnchor = document.createElement('div');
  modelChipAnchor.id = 'osMenubarModelChip';
  modelChipAnchor.className = 'mn-os-mb-model-slot';
  const cleanupModelChip = initMenubarModelChip(modelChipAnchor);

  const agentsBtn = document.createElement('button');
  agentsBtn.type = 'button';
  agentsBtn.className = 'mn-os-mb-icon mn-os-mb-agents';
  agentsBtn.innerHTML = iconHtml('appAgentActivity', { size: 16 });
  const cleanupAgentActivity = initAgentActivityMenubar(agentsBtn);

  const captureBtn = document.createElement('button');
  const cleanupCapture = initMenubarCapture(captureBtn);

  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'mn-os-mb-icon mn-os-mb-search';
  searchBtn.setAttribute('aria-label', 'Search chats and commands');
  searchBtn.setAttribute('aria-haspopup', 'dialog');
  searchBtn.title = 'Search chats and commands (Ctrl/Cmd+Shift+P)';
  searchBtn.innerHTML = iconHtml('search', { size: 16 });
  searchBtn.addEventListener('click', () => {
    void import('../ui/command-palette').then((m) => m.openCommandPalette());
  });

  const bell = document.createElement('button');
  bell.type = 'button';
  bell.className = 'mn-os-mb-bell';
  bell.setAttribute('aria-label', 'Notifications');
  bell.appendChild(createOsIcon('bell', { size: 16 }));
  const bellBadge = document.createElement('span');
  bellBadge.className = 'mn-os-bell-badge';
  bellBadge.hidden = true;
  bell.appendChild(bellBadge);
  const cleanupNotifications = initOsNotificationsMenu(bell);

  const updateSlot = document.createElement('div');
  updateSlot.id = 'osMenubarUpdateSlot';
  updateSlot.className = 'mn-os-mb-update-slot';
  updateSlot.hidden = true;
  const cleanupUpdatePill = initUpdateMenubarPill(updateSlot);

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'mn-os-mb-icon';
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.appendChild(createOsIcon('gear', { size: 16 }));
  settingsBtn.addEventListener('click', () => launchApp('settings'));

  const wikiBtn = document.createElement('button');
  wikiBtn.type = 'button';
  wikiBtn.className = 'mn-os-mb-icon';
  wikiBtn.setAttribute('aria-label', 'Minnow wiki — User manual');
  wikiBtn.title = 'Minnow wiki — User manual';
  wikiBtn.innerHTML = iconHtml('help', { size: 16 });
  wikiBtn.addEventListener('click', () => openProductWiki());

  right.append(
    modelChipAnchor,
    agentsBtn,
    captureBtn,
    searchBtn,
    bell,
    updateSlot,
    wikiBtn,
    settingsBtn,
  );
  root.append(left, right);

  const cleanupShellChrome = initShellMenubarChrome(root, right);

  function syncMenubar(): void {
    const view = getOsView();
    const fgApp = getForegroundAppId();
    const onWorkspaces = view === 'workspaces';

    root.dataset.view = onWorkspaces ? 'workspaces' : 'app';
    brand.hidden = !onWorkspaces;
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

    chatToggle.hidden = !isChatToggleVisible(fgApp) || Boolean(document.documentElement.dataset.appWindow);
    const toggleLabel = chatToggleAriaLabel(fgApp);
    if (toggleLabel) {
      chatToggle.setAttribute('aria-label', toggleLabel);
    }
    chatToggle.removeAttribute('aria-pressed');

    settingsBtn.hidden = Boolean(document.documentElement.dataset.appWindow);

    void import('./workspace-menubar').then((m) => m.syncWorkspaceMenubarPlacement());

    const unread = getUnreadNotificationCount();
    bell.classList.toggle('is-on', unread > 0);
    if (unread > 0) {
      bellBadge.hidden = false;
      bellBadge.textContent = unread > 99 ? '99+' : String(unread);
    } else {
      bellBadge.hidden = true;
      bellBadge.textContent = '';
    }
  }

  function ringBell(): void {
    bell.classList.remove('is-ringing');
    void bell.offsetWidth;
    bell.classList.add('is-ringing');
    window.setTimeout(() => bell.classList.remove('is-ringing'), 1200);
  }

  syncMenubar();
  const unsub = subscribeInstances(syncMenubar);
  const unsubInbox = subscribeNotifications(syncMenubar);
  const unsubPrefs = subscribeAppPreferences(syncMenubar);
  const unsubNotif = onNewNotification((record) => {
    syncMenubar();
    if (!record.read) ringBell();
  });

  return () => {
    unsub();
    unsubInbox();
    unsubPrefs();
    unsubNotif();
    cleanupModelChip();
    cleanupAgentActivity();
    cleanupCapture();
    cleanupNotifications();
    cleanupUpdatePill();
    cleanupShellChrome();
  };
}
