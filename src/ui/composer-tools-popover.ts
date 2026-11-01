import { createButton, createIconButton, openPopover, type PopoverHandle } from './components';
import { loadToolConfigIntoDrawer, syncWebSearchProviderFromSearchConfig } from '../tools/config';
import { ensureToolsSectionFilled } from './tools-list';

interface ToolsPopoverIds {
  buttonId: string;
  popoverId: string;
  settingsLinkId: string;
}

const popoverState = new Map<string, boolean>();
const handles = new Map<string, PopoverHandle>();
const registeredPopovers: ToolsPopoverIds[] = [];

// ── Open ─────────────────────────────────────────────────────────────────────

function isPopoverOpen(popoverId: string): boolean {
  return popoverState.get(popoverId) === true;
}

function getButton(ids: ToolsPopoverIds): HTMLButtonElement | null {
  return document.getElementById(ids.buttonId) as HTMLButtonElement | null;
}

function getPopover(ids: ToolsPopoverIds): HTMLElement | null {
  return document.getElementById(ids.popoverId);
}

/** Close one tools popover and restore focus to its button. */
function closeToolsPopover(ids: ToolsPopoverIds): void {
  const popover = getPopover(ids);
  const button = getButton(ids);
  const handle = handles.get(ids.popoverId);
  if (handle) handle.close();
  if (!popover || popover.classList.contains('hidden')) {
    popoverState.set(ids.popoverId, false);
    return;
  }

  popover.classList.add('hidden');
  popoverState.set(ids.popoverId, false);
  button?.setAttribute('aria-expanded', 'false');
  button?.focus();
}

/** Close every registered tools popover except the optional keep-open id. */
function closeOtherToolsPopovers(keepOpenId?: string): void {
  for (const ids of registeredPopovers) {
    if (ids.popoverId === keepOpenId) continue;
    closeToolsPopover(ids);
  }
}

/** Open a tools popover and focus the first control inside. */
function openToolsPopover(ids: ToolsPopoverIds): void {
  const popover = getPopover(ids);
  const button = getButton(ids);
  if (!popover || !button) return;

  closeOtherToolsPopovers(ids.popoverId);

  fillToolsPopover(ids);

  const marker = document.createComment('tools popover home');
  popover.before(marker);
  popover.classList.remove('hidden');
  popoverState.set(ids.popoverId, true);
  const handle = openPopover({
    appearance: 'surface', portal: false,
    anchor: button, content: popover, placement: 'top-end',
    ariaLabel: 'Tool permissions', className: 'composer-tools-flyout',
    onClose: () => {
      popover.classList.add('hidden');
      marker.replaceWith(popover);
      handles.delete(ids.popoverId);
      popoverState.set(ids.popoverId, false);
    },
  });
  handles.set(ids.popoverId, handle);
}

// ── Fill ─────────────────────────────────────────────────────────────────────

/** Build the permission list without opening the floating popover. */
function fillToolsPopover(ids: ToolsPopoverIds): void {
  const popover = getPopover(ids);
  if (!popover) return;

  const list = popover.querySelector<HTMLElement>('[id$="ToolsList"], .tools-list');
  const listId =
    list?.id ||
    (ids.popoverId === 'composerToolsPopover'
      ? 'composerToolsList'
      : ids.popoverId === 'chatAppToolsPopover'
        ? 'chatAppToolsList'
        : ids.popoverId === 'desktopToolsPopover'
          ? 'desktopToolsList'
          : '');
  if (listId) {
    ensureToolsSectionFilled(listId, { variant: 'composer' });
  }

  loadToolConfigIntoDrawer(document);
  void syncWebSearchProviderFromSearchConfig();
}

/** Fill the Code composer tools list for the compact overflow sheet. */
export function fillComposerToolsPopover(): void {
  fillToolsPopover(COMPOSER_POPOVER_IDS);
}

/** Toggle one tools popover. */
function toggleToolsPopover(ids: ToolsPopoverIds): void {
  if (isPopoverOpen(ids.popoverId)) {
    closeToolsPopover(ids);
    return;
  }
  openToolsPopover(ids);
}

/** Wire button, outside click, Escape, and settings link for one popover. */
function initToolsPopover(ids: ToolsPopoverIds): void {
  if (!registeredPopovers.includes(ids)) registeredPopovers.push(ids);

  const button = getButton(ids);
  const popover = getPopover(ids);
  const settingsLink = document.getElementById(ids.settingsLinkId);

  if (!button || !popover || button.dataset.toolsPopoverBound === '1') return;
  button.dataset.toolsPopoverBound = '1';
  createIconButton({ appearance: 'surface', element: button, icon: 'settings', label: 'Tool permissions', tooltip: false, size: 'sm' });
  if (settingsLink?.tagName === 'BUTTON') createButton({ appearance: 'surface', element: settingsLink as HTMLButtonElement, variant: 'ghost', size: 'sm' });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleToolsPopover(ids);
  });

  settingsLink?.addEventListener('click', () => {
    closeToolsPopover(ids);
    void import('./settings-page').then(({ openSettings }) => openSettings('tools'));
  });
}

const COMPOSER_POPOVER_IDS: ToolsPopoverIds = {
  buttonId: 'btnComposerTools',
  popoverId: 'composerToolsPopover',
  settingsLinkId: 'composerToolsOpenSettings',
};

const CHAT_APP_POPOVER_IDS: ToolsPopoverIds = {
  buttonId: 'btnChatAppTools',
  popoverId: 'chatAppToolsPopover',
  settingsLinkId: 'chatAppToolsOpenSettings',
};

const DESKTOP_POPOVER_IDS: ToolsPopoverIds = {
  buttonId: 'btnDesktopTools',
  popoverId: 'desktopToolsPopover',
  settingsLinkId: 'desktopToolsOpenSettings',
};

// ── Init ─────────────────────────────────────────────────────────────────────

/** Whether the Code composer tools popover is visible. */
export function isComposerToolsPopoverOpen(): boolean {
  return isPopoverOpen(COMPOSER_POPOVER_IDS.popoverId);
}

/** Close the Code composer tools popover. */
export function closeComposerToolsPopover(): void {
  closeToolsPopover(COMPOSER_POPOVER_IDS);
}

/** Close the Chat app tools popover. */
export function closeChatAppToolsPopover(): void {
  closeToolsPopover(CHAT_APP_POPOVER_IDS);
}

/** Close every tools popover (composer + Chat app). */
export function closeAllToolsPopovers(): void {
  closeOtherToolsPopovers();
}

/** Wire Code composer tools button popover. */
export function initComposerToolsPopover(): void {
  initToolsPopover(COMPOSER_POPOVER_IDS);
}

/** Wire Chat app composer tools button popover. */
export function initChatAppToolsPopover(): void {
  initToolsPopover(CHAT_APP_POPOVER_IDS);
}

/** Close the desktop composer tools popover. */
export function closeDesktopToolsPopover(): void {
  closeToolsPopover(DESKTOP_POPOVER_IDS);
}

/** Wire desktop composer tools button popover. */
export function initDesktopToolsPopover(): void {
  initToolsPopover(DESKTOP_POPOVER_IDS);
}
