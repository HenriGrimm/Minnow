import { isActiveChatStreaming, isChatStreaming } from '../chat/streaming-state';
import { isComposerRecoveryBlocked } from './composer-send';
import { getDefaultWorkAgentForMode } from '../agents/work-agent-registry';
import { syncWorkAgentDevFromActiveChat } from './work-agent-dev';
import { listComposerModes, listModes } from '../chat/modes/registry';
import { normalizeModeId, type ModeId } from '../chat/modes/types';
import {
  getActiveChat,
  scheduleSaveSessions,
  sessionState,
  touchChat,
} from '../state/sessions';
import { renderChatFromHistory } from './messages';
import { setStatus } from './status';
import { syncOrchestratePlanStripFromActiveChat } from './orchestrate-plan-selector';
import { syncViewModeToggleFromActiveChat } from './view-mode-toggle';
import { refreshComposerRunTargetDisabled } from './composer-run-target';
import { createIcon } from './icon';
import { createModeMaskIcon, syncModeIconInDom } from './mode-icons';

const MODE_STATUS_MS = 2200;

let modeSelectorRoot: HTMLElement | null = null;
let modeDropdownBtn: HTMLButtonElement | null = null;
let statusHideTimer: ReturnType<typeof setTimeout> | null = null;
let modeMenuOutsideHandler: ((event: PointerEvent) => void) | null = null;
let modeMenuEscapeHandler: ((event: KeyboardEvent) => void) | null = null;

/** Re-sync the compact dropdown face after composer siblings change. */
export function refreshModeSelectorLayout(): void {
  const root = getModeSelectorEl();
  if (!root) return;
  syncModeDropdownFromActiveChat(root);
}

/** Run-target (and similar) inserts after boot — refresh the dropdown and overflow park. */
export function observeModeSelectorComposerSibling(_el: HTMLElement): void {
  refreshModeSelectorLayout();
  document.dispatchEvent(new CustomEvent('minnow:composer-controls-changed'));
}

function getModeSelectorEl(): HTMLElement | null {
  if (!modeSelectorRoot) {
    modeSelectorRoot = document.getElementById('modeSelector');
  }
  return modeSelectorRoot;
}

function getModeDropdownEl(): HTMLButtonElement | null {
  if (!modeDropdownBtn) {
    modeDropdownBtn = document.getElementById('modeSelectorDropdown') as HTMLButtonElement | null;
  }
  return modeDropdownBtn;
}

function detachModeMenuListeners(): void {
  if (modeMenuOutsideHandler) {
    document.removeEventListener('pointerdown', modeMenuOutsideHandler, true);
    modeMenuOutsideHandler = null;
  }
  if (modeMenuEscapeHandler) {
    document.removeEventListener('keydown', modeMenuEscapeHandler, true);
    modeMenuEscapeHandler = null;
  }
}

/** Close the compact mode list without changing the selected mode. */
export function closeModeSelectorMenu(): void {
  const root = getModeSelectorEl();
  const dropdown = getModeDropdownEl();
  root?.classList.remove('mode-segmented--menu-open');
  if (root) {
    root.style.position = '';
    root.style.top = '';
    root.style.left = '';
    root.style.minWidth = '';
  }
  dropdown?.setAttribute('aria-expanded', 'false');
  detachModeMenuListeners();
}

function positionModeMenu(root: HTMLElement, dropdown: HTMLElement): void {
  root.style.position = 'fixed';
  const rect = dropdown.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const height = root.offsetHeight || root.getBoundingClientRect().height;
  const width = Math.max(root.offsetWidth || 0, rect.width);

  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - gap);
  }

  let left = rect.left;
  if (left + width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - width - margin);
  }

  root.style.top = `${Math.round(top)}px`;
  root.style.left = `${Math.round(left)}px`;
  root.style.minWidth = `${Math.round(rect.width)}px`;
}

function attachModeMenuListeners(root: HTMLElement, dropdown: HTMLButtonElement): void {
  detachModeMenuListeners();

  modeMenuOutsideHandler = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (root.contains(target) || dropdown.contains(target)) return;
    closeModeSelectorMenu();
  };
  document.addEventListener('pointerdown', modeMenuOutsideHandler, true);

  modeMenuEscapeHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeModeSelectorMenu();
    dropdown.focus();
  };
  document.addEventListener('keydown', modeMenuEscapeHandler, true);
}

function openModeMenu(): void {
  const root = getModeSelectorEl();
  const dropdown = getModeDropdownEl();
  if (!root || !dropdown || root.hidden) return;

  document.dispatchEvent(new CustomEvent('minnow:close-composer-overflow'));
  root.classList.add('mode-segmented--menu-open');
  dropdown.setAttribute('aria-expanded', 'true');
  positionModeMenu(root, dropdown);
  attachModeMenuListeners(root, dropdown);

  const selected = root.querySelector<HTMLButtonElement>('[aria-checked="true"]');
  selected?.focus();
}

function toggleModeMenu(): void {
  const root = getModeSelectorEl();
  if (root?.classList.contains('mode-segmented--menu-open')) {
    closeModeSelectorMenu();
    return;
  }
  openModeMenu();
}

function composerModeLabel(modeId: ModeId): string {
  if (isPlanFamilyMode(modeId)) return 'Plan';
  return listModes().find((m) => m.id === modeId)?.label ?? modeId;
}

/** Keep the compact dropdown face in sync with the selected segment. */
function syncModeDropdownFromActiveChat(root: HTMLElement): void {
  const dropdown = ensureModeDropdown(root);
  dropdown.hidden = root.hidden;
  if (root.hidden) {
    closeModeSelectorMenu();
    return;
  }

  const chat = sessionState ? getActiveChat() : null;
  const activeId = normalizeModeId(chat?.modeId);
  const label = composerModeLabel(activeId);

  const iconHost = dropdown.querySelector('.mode-selector-dropdown__icon');
  if (iconHost instanceof HTMLElement) {
    applyModeIconToDropdown(iconHost, activeId);
  }

  const labelEl = dropdown.querySelector('.mode-selector-dropdown__label');
  if (labelEl) labelEl.textContent = label;

  dropdown.title = listModes().find((m) => m.id === activeId)?.description ?? label;
  dropdown.setAttribute('aria-label', `Operating mode, ${label}, selected`);
}

function applyModeIconToDropdown(host: HTMLElement, modeId: ModeId): void {
  host.replaceChildren(createModeMaskIcon(modeId, 'mode-segment__icon mode-mask-icon'));
}

function ensureModeDropdown(root: HTMLElement): HTMLButtonElement {
  const existing = getModeDropdownEl();
  if (existing) return existing;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'modeSelectorDropdown';
  btn.className = 'mode-selector-dropdown';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'modeSelector');

  const face = document.createElement('span');
  face.className = 'mode-selector-dropdown__face';
  const iconHost = document.createElement('span');
  iconHost.className = 'mode-selector-dropdown__icon';
  const label = document.createElement('span');
  label.className = 'mode-selector-dropdown__label';
  face.append(iconHost, label);

  const chevron = createIcon('chevronDown', { className: 'mode-selector-dropdown__chevron icon-svg' });
  btn.append(face, chevron);

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (isActiveChatStreaming() || isComposerRecoveryBlocked()) return;
    toggleModeMenu();
  });
  btn.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openModeMenu();
    }
  });

  root.parentElement?.insertBefore(btn, root);
  modeDropdownBtn = btn;
  return btn;
}

/** Board-managed chats must retain the role and tool policy assigned by the orchestrator. */
function isBoardManagedChat(chat: ReturnType<typeof getActiveChat>): boolean {
  return Boolean(chat.boardGroupId?.trim() || chat.boardTaskId?.trim());
}

/** Super Plan is not on the strip, but a Super Plan chat is still in the plan family — keep Plan lit rather than showing four unselected segments. */
function isPlanFamilyMode(modeId: ModeId | string | null | undefined): boolean {
  const normalized = normalizeModeId(modeId ?? undefined);
  return normalized === 'plan' || normalized === 'super-plan';
}

/** Apply active chat mode to segment buttons. */
export function syncModeSelectorFromActiveChat(): void {
  const root = getModeSelectorEl();
  if (!root || !sessionState) return;

  const chat = getActiveChat();
  root.hidden = isBoardManagedChat(chat);

  if (!root.hidden) {
    const activeId = normalizeModeId(chat.modeId);
    const buttons = root.querySelectorAll<HTMLButtonElement>('[data-mode-id]');
    let index = 0;
    let selectedIndex = 0;

    buttons.forEach((btn) => {
      const segmentModeId = btn.dataset.modeId as ModeId;
      const isSelected =
        segmentModeId === 'plan' ? isPlanFamilyMode(activeId) : segmentModeId === activeId;

      btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      if (isSelected) selectedIndex = index;
      index += 1;
    });

    root.setAttribute(
      'aria-label',
      `Operating mode, ${listModes().find((m) => m.id === activeId)?.label ?? activeId}, selected, ${selectedIndex + 1} of ${buttons.length}`,
    );
  }

  refreshModeSelectorDisabled();
  syncModeDropdownFromActiveChat(root);
}

/** Disable segments while the model is streaming. */
export function refreshModeSelectorDisabled(): void {
  const root = getModeSelectorEl();
  if (!root) return;
  const disabled = isActiveChatStreaming() || isComposerRecoveryBlocked();
  root.querySelectorAll<HTMLButtonElement>('[data-mode-id]').forEach((btn) => {
    btn.disabled = disabled;
  });
  const dropdown = getModeDropdownEl();
  if (dropdown) dropdown.disabled = disabled;
  refreshComposerRunTargetDisabled();
}

function showModeStatusPill(label: string): void {
  setStatus('ok', `Mode: ${label}`);
  if (statusHideTimer) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => {
    statusHideTimer = null;
    setStatus('idle', '');
  }, MODE_STATUS_MS);
}

export interface SetChatModeResult {
  ok: boolean;
  modeId?: ModeId;
  label?: string;
  error?: string;
}

/** Apply operating mode to the active chat (tool / programmatic handoff). */
export function setChatMode(modeId: ModeId, chat = getActiveChat(), allowDuringTurn = false): SetChatModeResult {
  if (isChatStreaming(chat.id) && !allowDuringTurn) {
    return { ok: false, error: 'Finish the current reply first' };
  }

  const normalized = modeId;
  if (chat.modeId === normalized) {
    const mode = listModes().find((m) => m.id === normalized);
    return { ok: true, modeId: normalized, label: mode?.label };
  }

  if (isBoardManagedChat(chat)) {
    return {
      ok: false,
      error: 'Board chats keep the role assigned by the orchestrator',
    };
  }

  if (normalizeModeId(normalized) === 'orchestrate') {
    void import('./orchestrate-hub').then((m) => m.openOrchestrateLanding());
    const mode = listModes().find((m) => m.id === 'orchestrate');
    if (mode) showModeStatusPill(mode.label);
    return { ok: true, modeId: 'orchestrate', label: mode?.label };
  }

  chat.modeId = normalized;
  if (chat.workAgentAuto !== false) {
    const agent = getDefaultWorkAgentForMode(normalized);
    chat.workAgentId = agent?.id ?? null;
  }
  touchChat(chat);
  scheduleSaveSessions();
  if (chat.id === getActiveChat().id) {
    if (!isChatStreaming(chat.id)) renderChatFromHistory(chat);
    syncModeSelectorFromActiveChat();
    void syncOrchestratePlanStripFromActiveChat();
    syncViewModeToggleFromActiveChat();
    syncWorkAgentDevFromActiveChat();

    const mode = listModes().find((m) => m.id === normalized);
    if (mode) showModeStatusPill(mode.label);
  }
  syncModeIconInDom(chat.id, normalized);
  const mode = listModes().find((m) => m.id === normalized);
  return { ok: true, modeId: normalized, label: mode?.label };
}

function selectMode(modeId: ModeId): void {
  setChatMode(modeId);
}

function onSegmentKeydown(event: KeyboardEvent, modeId: ModeId): void {
  const root = getModeSelectorEl();
  if (!root || isActiveChatStreaming()) return;

  const modes = listComposerModes();
  const currentIndex = modes.findIndex((m) => m.id === modeId);
  if (currentIndex < 0) return;

  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % modes.length;
    event.preventDefault();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + modes.length) % modes.length;
    event.preventDefault();
  } else if (event.key === 'Home') {
    nextIndex = 0;
    event.preventDefault();
  } else if (event.key === 'End') {
    nextIndex = modes.length - 1;
    event.preventDefault();
  } else {
    return;
  }

  const nextId = modes[nextIndex].id;
  selectMode(nextId);
  const nextBtn = root.querySelector<HTMLButtonElement>(
    `[data-mode-id="${nextId}"]`,
  );
  nextBtn?.focus();
}

/** Build segments and wire handlers (idempotent). */
export function initModeSelector(): void {
  const root = getModeSelectorEl();
  if (!root || root.dataset.initialized === 'true') return;

  root.innerHTML = '';
  root.setAttribute('role', 'radiogroup');

  for (const mode of listComposerModes()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mode-segment';
    btn.dataset.modeId = mode.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');
    btn.title = mode.description;
    btn.setAttribute('aria-label', mode.label);

    const icon = createModeMaskIcon(mode.id, 'mode-segment__icon mode-mask-icon');
    const label = document.createElement('span');
    label.className = 'mode-segment__label';
    label.textContent = mode.label;
    btn.append(icon, label);

    btn.addEventListener('click', () => {
      selectMode(mode.id);
      closeModeSelectorMenu();
    });
    btn.addEventListener('keydown', (e) => onSegmentKeydown(e, mode.id));

    root.appendChild(btn);
  }

  root.dataset.initialized = 'true';
  ensureModeDropdown(root);
  syncModeSelectorFromActiveChat();
}

/** Tear down observers and DOM for unit tests. */
export function disposeModeSelectorForTests(): void {
  closeModeSelectorMenu();
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }
  modeSelectorRoot = null;
  modeDropdownBtn?.remove();
  modeDropdownBtn = null;
  const root = document.getElementById('modeSelector');
  if (root) {
    root.innerHTML = '';
    root.classList.remove('mode-segmented--compact', 'mode-segmented--menu-open');
    root.style.position = '';
    root.style.top = '';
    root.style.left = '';
    root.style.minWidth = '';
    delete root.dataset.initialized;
  }
}
