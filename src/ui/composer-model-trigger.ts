import { decodeModelSelectKey, resolveModelSelectValueForChat } from '../lib/model-select-key';
import { syncBoardHeaderReasoning } from './orchestrate-board-reasoning.ts';
import { getModelRowForSelectOrCanonicalId, updateModelLoadUnloadButtons } from '../api/models';
import { modelCache } from '../app-state';
import { getForegroundAppId, getOsView } from '../os/instances';
import { modelProducerLogoSvg } from '../providers/model-producer';
import { isModelLoadUnloadBusy } from './model-load-unload-button';
import { resolveModelState } from './model-state-dot';
import { getActiveChat } from '../state/sessions';
import { isChatAppForeground } from './chat-mount';
import {
  onActiveChatModelChange,
  refreshActiveChatReasoningDefault,
} from './chat-model-ui';
import { scheduleCapabilityProbeForSelectValue } from '../providers/first-load-probe';
import {
  clearModelSearchQuery,
  closeModelSelectMenu,
  focusModelHostFilterSearch,
  mountModelHostFilterBar,
  mountModelMenuActions,
  registerModelSelectExternalCloser,
  renderModelSelectMenuRows,
  selectModelInPicker,
  shouldKeepModelMenuOpenAfterSelect,
  syncAllModelMenuReasoningDefaults,
} from './model-select-picker';
import {
  activitySuffixForModelId,
  subscribeServeActivityFeed,
  syncModelActivityIndicators,
} from '../models/serve-activity-feed';
import {
  registerChromePopover,
  unregisterChromePopover,
} from './preview-electron-visibility';

import { iconHtml } from './icon';
import { routerAssignmentLabel, getRouterConfigSync } from '../models/routers';

const CHEVRON_SVG = iconHtml('chevronDown', { size: 10 });

const MODEL_FALLBACK_ICON_SVG = iconHtml('appModels', { className: 'mn-os-mb-model-fallback-icon' });

type ComposerModelVariant =
  | 'desktop'
  | 'code'
  | 'chat'
  | 'menubar'
  | 'board'
  | 'research'
  | 'super-plan';

type ComposerModelSurfaceVariant = Exclude<ComposerModelVariant, 'menubar' | 'board'>;

type MenubarStyleVariant = 'menubar' | 'board';

/** Per-board model chip: display + persist, so V1 store and V2 journal can share the UI. */
export interface BoardModelChipContext {
  resolveBinding: () => { providerId: string; modelId: string };
  persist: (providerId: string, modelId: string) => void;
  onChanged: () => void;
}

let boardModelTriggerContext: BoardModelChipContext | null = null;

/** How long the menubar hover label stays visible before collapsing. */
const MENUBAR_EXPAND_HOLD_MS = 3200;

interface ComposerModelTrigger {
  variant: ComposerModelVariant;
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  logoEl: HTMLSpanElement;
  labelEl: HTMLSpanElement;
  menu: HTMLUListElement;
  panel: HTMLDivElement;
  providerEl?: HTMLSpanElement;
  iconLogoEl?: HTMLSpanElement;
  dotEl?: HTMLElement;
  expandEl?: HTMLElement;
  collapseTimer?: number;
}

const triggers: ComposerModelTrigger[] = [];
/** App-wide live-activity subscription; opened once by initComposerModelTriggers. */
let activityFeedUnsub: (() => void) | null = null;
let openTrigger: ComposerModelTrigger | null = null;
let chromePopoverRegistered = false;
let globalsBound = false;
let shortcutBound = false;
let unregisterExternalCloser: (() => void) | null = null;

// ── Finders ──────────────────────────────────────────────────────────────────

/** True when an element is connected and laid out in the viewport. */
function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Map the foreground composer surface to its per-chat model trigger variant. */
function resolveChatModelTriggerVariant(): ComposerModelSurfaceVariant | null {
  const foregroundAppId = getForegroundAppId();
  if (foregroundAppId === 'code') return 'code';
  if (false) return 'desktop';
  if (isChatAppForeground()) return 'chat';

  const desktopInput = document.getElementById('desktopInput');
  if (desktopInput && isElementVisible(desktopInput)) return 'desktop';

  const superPlanAnchor = document.getElementById('superPlanComposerModelAnchor');
  if (superPlanAnchor && isElementVisible(superPlanAnchor)) return 'super-plan';

  const researchAnchor = document.getElementById('researchComposerModelAnchor');
  if (researchAnchor && isElementVisible(researchAnchor)) return 'research';

  const codeAnchor = document.getElementById('codeComposerModelAnchor');
  if (codeAnchor && isElementVisible(codeAnchor)) return 'code';

  const chatAnchor = document.getElementById('chatAppComposerModelAnchor');
  if (chatAnchor && isElementVisible(chatAnchor)) return 'chat';

  if (getOsView() === 'workspaces' && desktopInput) return 'desktop';
  return null;
}

function findChatModelTrigger(
  variant: ComposerModelSurfaceVariant,
): ComposerModelTrigger | undefined {
  return triggers.find((trigger) => trigger.variant === variant);
}

function findBoardModelTrigger(): ComposerModelTrigger | undefined {
  return triggers.find((trigger) => trigger.variant === 'board');
}

function findResearchModelTrigger(): ComposerModelTrigger | undefined {
  return triggers.find((trigger) => trigger.variant === 'research');
}

function isMenubarStyleVariant(variant: ComposerModelVariant): variant is MenubarStyleVariant {
  return variant === 'menubar' || variant === 'board';
}

/** Update board model chip context (orchestrate board header). */
export function setBoardModelTriggerContext(ctx: BoardModelChipContext | null): void {
  boardModelTriggerContext = ctx;
  const boardTrigger = findBoardModelTrigger();
  if (boardTrigger) syncTrigger(boardTrigger);
}

/** Re-sync the board header model chip from persisted board state. */
export function syncBoardModelChipTrigger(): void {
  const boardTrigger = findBoardModelTrigger();
  if (boardTrigger) syncTrigger(boardTrigger);
}

// ── Sync ─────────────────────────────────────────────────────────────────────

function getModelSelect(): HTMLSelectElement | null {
  return document.getElementById('modelSelect') as HTMLSelectElement | null;
}

function canonicalModelIdFromSelectValue(value: string): string {
  return decodeModelSelectKey(value)?.modelId ?? value.trim();
}

function selectedOptionForValue(
  sel: HTMLSelectElement,
  value: string,
): HTMLOptionElement | undefined {
  const trimmed = value.trim();
  if (trimmed) {
    const match = [...sel.options].find((o) => o.value === trimmed);
    if (match) return match;
  }
  return sel.options[sel.selectedIndex];
}

function resolveTriggerSelectValue(trigger: ComposerModelTrigger): string {
  const sel = getModelSelect();
  if (!sel) return '';
  if (trigger.variant === 'menubar') {
    return sel.value.trim();
  }
  if (trigger.variant === 'board' && boardModelTriggerContext) {
    const values = [...sel.options].map((o) => o.value);
    return resolveModelSelectValueForChat(boardModelTriggerContext.resolveBinding(), values);
  }
  if (trigger.variant === 'research') {
    const values = [...sel.options].map((o) => o.value);
    return resolveModelSelectValueForChat(getActiveChat(), values);
  }
  const values = [...sel.options].map((o) => o.value);
  return resolveModelSelectValueForChat(getActiveChat(), values);
}

/** Split composite option text into model name and provider label. */
function parseModelOptionLabels(opt?: HTMLOptionElement): {
  model: string;
  provider: string;
} {
  const text = opt?.text?.trim() || opt?.label?.trim() || '';
  const sep = ' — ';
  const idx = text.lastIndexOf(sep);
  if (idx > 0) {
    return {
      model: text.slice(0, idx).trim(),
      provider: text.slice(idx + sep.length).trim(),
    };
  }
  return { model: text || 'Select model', provider: '' };
}

function applyLogoSvg(target: HTMLElement, modelId: string): void {
  const svg = modelId ? modelProducerLogoSvg(modelId) : '';
  if (svg) {
    target.innerHTML = svg;
    target.classList.remove('hidden');
  } else {
    target.innerHTML = '';
    target.classList.add('hidden');
  }
}

/** True while fetchModels has the select parked on its "Loading models…" placeholder. */
function isModelListLoading(): boolean {
  const sel = getModelSelect();
  if (!sel) return false;
  const options = [...sel.options];
  return (
    !options.some((o) => o.value.trim() !== '') &&
    options.some((o) => o.text.trim() === 'Loading models…')
  );
}

function syncMenubarLoadDot(trigger: ComposerModelTrigger, selectValue: string): void {
  if (!trigger.dotEl) return;
  let state = 'unknown';
  if (isModelLoadUnloadBusy() || isModelListLoading()) {
    state = 'loading';
  } else if (selectValue) {
    const row = getModelRowForSelectOrCanonicalId(selectValue);
    state = row
      ? resolveModelState(row)
      : modelCache.get(selectValue)
        ? resolveModelState(modelCache.get(selectValue))
        : 'unknown';
  }
  trigger.dotEl.dataset.loadState = state;
  if (!isMenubarStyleVariant(trigger.variant)) {
    // Composer chips only surface the dot as a spinner, in place of the producer logo.
    if (state === 'loading') trigger.trigger.setAttribute('aria-busy', 'true');
    else trigger.trigger.removeAttribute('aria-busy');
  }
  const busy = state === 'loaded' && Boolean(activitySuffixForModelId(canonicalActivityId(selectValue)));
  if (busy) trigger.dotEl.dataset.busy = 'true';
  else delete trigger.dotEl.dataset.busy;
}

/** Canonical model id an activity sample would be keyed by, for a picker select value. */
function canonicalActivityId(selectValue: string): string {
  if (!selectValue) return '';
  const decoded = decodeModelSelectKey(selectValue);
  return decoded?.modelId?.trim() || selectValue.trim();
}

/** Repaint only what telemetry changes — the trigger dots and the open menu's activity suffixes. */
function syncActivityOnly(): void {
  for (const trigger of triggers) syncMenubarLoadDot(trigger, resolveTriggerSelectValue(trigger));
  syncModelActivityIndicators();
}

/** Sync logo + label on one composer model trigger. */
function syncTrigger(trigger: ComposerModelTrigger): void {
  const sel = getModelSelect();
  const selectValue = resolveTriggerSelectValue(trigger);
  const selectedOpt = sel ? selectedOptionForValue(sel, selectValue) : undefined;
  const { model, provider } = parseModelOptionLabels(selectedOpt);

  if (isMenubarStyleVariant(trigger.variant)) {
    trigger.labelEl.textContent = model;
    if (trigger.providerEl) {
      const showProvider =
        Boolean(provider) &&
        provider.trim().toLowerCase() !== model.trim().toLowerCase();
      trigger.providerEl.textContent = provider;
      trigger.providerEl.hidden = !showProvider;
    }
  } else {
    const label =
      selectedOpt?.text?.trim() || selectedOpt?.label?.trim() || 'Select model';
    trigger.labelEl.textContent = label;
  }

  const title = selectedOpt?.title?.trim() || selectValue || '';
  if (title) trigger.labelEl.title = title;
  else trigger.labelEl.removeAttribute('title');

  const modelId = selectValue ? canonicalModelIdFromSelectValue(selectValue) : '';
  if (isMenubarStyleVariant(trigger.variant)) {
    if (trigger.iconLogoEl) {
      applyLogoSvg(trigger.iconLogoEl, modelId);
      const hasProducerLogo = Boolean(modelId && modelProducerLogoSvg(modelId));
      trigger.trigger.classList.toggle('has-producer-logo', hasProducerLogo);
    }
    syncMenubarLoadDot(trigger, selectValue);
    const summary = provider ? `${model} · ${provider}` : model;
    const labelPrefix = trigger.variant === 'board' ? 'Board model' : 'Default model';
    trigger.trigger.setAttribute('aria-label', `${labelPrefix}: ${summary}`);
    trigger.trigger.title = summary;
  } else {
    applyLogoSvg(trigger.logoEl, modelId);
    syncMenubarLoadDot(trigger, selectValue);
  }

  if (decodeModelSelectKey(selectValue)?.providerId === 'minnow-router') {
    const router = getRouterConfigSync().routers.find((r) => r.id === modelId);
    const assignment = !isMenubarStyleVariant(trigger.variant) ? routerAssignmentLabel(getActiveChat()?.id || '', modelId) : '';
    trigger.labelEl.textContent = `${router?.name || modelId} · Model pool${assignment ? ` → ${assignment}` : ''}`;
  }

  const hasSelectable =
    Boolean(sel) &&
    [...sel!.options].some((o) => o.value.trim() !== '') &&
    !sel!.disabled;
  trigger.trigger.disabled = !hasSelectable;
}

/** Sync every mounted composer model trigger. */
export function syncComposerModelTriggers(): void {
  for (const trigger of triggers) syncTrigger(trigger);
  if (openTrigger) rebuildOpenMenu();
  updateModelLoadUnloadButtons();
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function handleComposerModelPick(trigger: ComposerModelTrigger, modelId: string): void {
  if (trigger.variant === 'menubar') {
    selectModelInPicker(modelId);
    return;
  }
  if (trigger.variant === 'board') {
    if (!boardModelTriggerContext) return;
    const decoded = decodeModelSelectKey(modelId);
    const canonicalModelId = decoded?.modelId ?? modelId.trim();
    const providerId =
      decoded?.providerId?.trim() ||
      boardModelTriggerContext.resolveBinding().providerId.trim() ||
      '';
    if (!canonicalModelId || !providerId) return;
    boardModelTriggerContext.persist(providerId, canonicalModelId);
    scheduleCapabilityProbeForSelectValue(modelId);
    boardModelTriggerContext.onChanged();
    syncTrigger(trigger);
    syncBoardHeaderReasoning();
    return;
  }
  if (trigger.variant === 'research') {
    onActiveChatModelChange(modelId);
    return;
  }
  onActiveChatModelChange(modelId);
}

function rebuildOpenMenu(): void {
  if (!openTrigger) return;
  const sel = getModelSelect();
  if (!sel) return;
  const selectedValue = resolveTriggerSelectValue(openTrigger);
  renderModelSelectMenuRows(
    openTrigger.menu,
    sel,
    (modelId) => {
      handleComposerModelPick(openTrigger!, modelId);
      if (!shouldKeepModelMenuOpenAfterSelect(modelId)) {
        closeComposerModelMenu();
      } else {
        rebuildOpenMenu();
      }
    },
    selectedValue,
  );
  syncAllModelMenuReasoningDefaults();
}

function positionPanel(trigger: ComposerModelTrigger): void {
  const rect = trigger.trigger.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const panel = trigger.panel;

  const panelWidth = panel.offsetWidth || panel.getBoundingClientRect().width;
  let left = rect.right - panelWidth;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
  panel.style.left = `${left}px`;
  panel.style.right = 'auto';

  const panelHeight = panel.offsetHeight || panel.getBoundingClientRect().height;

  if (isMenubarStyleVariant(trigger.variant)) {
    let top = rect.bottom + gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - panelHeight - margin));
    panel.style.top = `${top}px`;
    return;
  }

  let top = rect.top - panelHeight - gap;
  if (top < margin) {
    top = rect.bottom + gap;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - panelHeight - margin));
  panel.style.top = `${top}px`;
}

function clearMenubarCollapseTimer(trigger: ComposerModelTrigger): void {
  if (trigger.collapseTimer === undefined) return;
  window.clearTimeout(trigger.collapseTimer);
  trigger.collapseTimer = undefined;
}

function positionMenubarExpandLabel(trigger: ComposerModelTrigger): void {
  const expand = trigger.expandEl;
  if (!expand) return;
  const rect = trigger.trigger.getBoundingClientRect();
  if (trigger.variant === 'board') {
    expand.style.left = `${rect.left + rect.width / 2}px`;
    expand.style.top = `${rect.bottom + 6}px`;
    expand.style.right = 'auto';
    return;
  }
  expand.style.left = `${rect.left - 6}px`;
  expand.style.top = `${rect.top + rect.height / 2}px`;
  expand.style.right = 'auto';
}

function isPointerOverMenubarChip(
  trigger: ComposerModelTrigger,
  target: Node | null,
): boolean {
  if (!target) return false;
  return trigger.root.contains(target) || Boolean(trigger.expandEl?.contains(target));
}

function collapseMenubarExpand(trigger: ComposerModelTrigger): void {
  if (openTrigger === trigger) return;
  clearMenubarCollapseTimer(trigger);
  trigger.root.classList.remove('is-expanded');
  trigger.expandEl?.classList.remove('is-expanded', 'is-open');
  trigger.expandEl?.setAttribute('aria-hidden', 'true');
}

function expandMenubarChip(trigger: ComposerModelTrigger): void {
  positionMenubarExpandLabel(trigger);
  trigger.root.classList.add('is-expanded');
  trigger.expandEl?.classList.add('is-expanded');
  trigger.expandEl?.setAttribute('aria-hidden', 'false');
  clearMenubarCollapseTimer(trigger);
  trigger.collapseTimer = window.setTimeout(() => {
    trigger.collapseTimer = undefined;
    collapseMenubarExpand(trigger);
  }, MENUBAR_EXPAND_HOLD_MS);
}

function wireMenubarHover(trigger: ComposerModelTrigger): void {
  let leaveTimer: number | undefined;

  const show = () => {
    if (leaveTimer !== undefined) {
      window.clearTimeout(leaveTimer);
      leaveTimer = undefined;
    }
    expandMenubarChip(trigger);
  };

  const scheduleCollapse = () => {
    if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = undefined;
      collapseMenubarExpand(trigger);
    }, 180);
  };

  const onPointerOut = (e: PointerEvent) => {
    const related = e.relatedTarget as Node | null;
    if (isPointerOverMenubarChip(trigger, related)) return;
    scheduleCollapse();
  };

  trigger.root.addEventListener('pointerenter', show);
  trigger.root.addEventListener('pointerout', onPointerOut);
  trigger.expandEl?.addEventListener('pointerenter', show);
  trigger.expandEl?.addEventListener('pointerout', onPointerOut);
  window.addEventListener('resize', () => {
    if (trigger.root.classList.contains('is-expanded') || openTrigger === trigger) {
      positionMenubarExpandLabel(trigger);
    }
  });
}

function detachGlobalListeners(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeyDown, true);
  window.removeEventListener('resize', onWindowResize);
}

function onDocumentPointerDown(e: PointerEvent): void {
  if (!openTrigger) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (
    openTrigger.root.contains(target) ||
    openTrigger.panel.contains(target)
  ) {
    return;
  }
  closeComposerModelMenu();
}

function onDocumentKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && openTrigger) {
    e.preventDefault();
    closeComposerModelMenu();
  }
}

function onWindowResize(): void {
  if (openTrigger) positionPanel(openTrigger);
}

function attachGlobalListeners(): void {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeyDown, true);
  window.addEventListener('resize', onWindowResize);
}

/** Open the per-chat model picker for the active composer surface. */
export function openActiveChatModelSelect(): boolean {
  ensureGlobals();
  const variant = resolveChatModelTriggerVariant();
  if (!variant) return false;

  const trigger = findChatModelTrigger(variant);
  if (!trigger || trigger.trigger.disabled) return false;

  if (openTrigger === trigger) {
    focusModelHostFilterSearch();
    return true;
  }

  openMenu(trigger);
  return true;
}

/** Bind Mod+M to open the per-chat model picker (works from composer fields). */
export function initChatModelSelectShortcut(): void {
  if (shortcutBound) return;
  shortcutBound = true;

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if (event.key.toLowerCase() !== 'm') return;
    if (event.altKey || event.shiftKey) return;
    if (!event.ctrlKey && !event.metaKey) return;
    if (!openActiveChatModelSelect()) return;
    event.preventDefault();
  });
}

/** Close any open composer model menu popover. */
export function closeComposerModelMenu(): void {
  if (!openTrigger) return;
  clearModelSearchQuery();
  const current = openTrigger;
  openTrigger = null;
  current.panel.classList.add('hidden');
  current.root.classList.remove('is-open');
  current.trigger.setAttribute('aria-expanded', 'false');
  if (isMenubarStyleVariant(current.variant)) {
    collapseMenubarExpand(current);
  }
  if (chromePopoverRegistered) {
    unregisterChromePopover();
    chromePopoverRegistered = false;
  }
  detachGlobalListeners();
}

// ── Build ────────────────────────────────────────────────────────────────────

function openMenu(trigger: ComposerModelTrigger): void {
  const sel = getModelSelect();
  if (!sel || trigger.trigger.disabled) return;
  closeModelSelectMenu();
  closeComposerModelMenu();
  openTrigger = trigger;
  if (isMenubarStyleVariant(trigger.variant)) {
    expandMenubarChip(trigger);
  }
  rebuildOpenMenu();
  updateModelLoadUnloadButtons();
  trigger.panel.classList.remove('hidden');
  trigger.root.classList.add('is-open');
  if (isMenubarStyleVariant(trigger.variant)) {
    trigger.expandEl?.classList.add('is-open');
    positionMenubarExpandLabel(trigger);
  }
  trigger.trigger.setAttribute('aria-expanded', 'true');
  positionPanel(trigger);
  attachGlobalListeners();
  if (!chromePopoverRegistered) {
    registerChromePopover();
    chromePopoverRegistered = true;
  }
  focusModelHostFilterSearch();
}

function toggleMenu(trigger: ComposerModelTrigger): void {
  if (openTrigger === trigger) closeComposerModelMenu();
  else openMenu(trigger);
}

function ensureGlobals(): void {
  if (globalsBound) return;
  globalsBound = true;

  unregisterExternalCloser = registerModelSelectExternalCloser(() => {
    closeComposerModelMenu();
  });

  const sel = getModelSelect();
  sel?.addEventListener('change', () => syncComposerModelTriggers());
  document.addEventListener('minnow:model-select-synced', () => syncComposerModelTriggers());
  document.addEventListener('minnow:model-load-unload-changed', () => syncActivityOnly());

  const source = document.getElementById('modelSelectTriggerText');
  if (source && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => syncComposerModelTriggers());
    observer.observe(source, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['title'],
    });
  }
}

/** Model select value the open composer menu targets — per chat, not the global default. */
function resolveOpenMenuSelectValue(): string {
  const trigger = openTrigger;
  const sel = getModelSelect();
  if (!sel) return '';
  if (!trigger || trigger.variant === 'menubar') {
    return sel.value.trim();
  }
  return resolveTriggerSelectValue(trigger);
}

function createModelMenuPanel(
  variant: ComposerModelVariant,
): { panel: HTMLDivElement; menu: HTMLUListElement } {
  const panel = document.createElement('div');
  panel.className = 'composer-model-menu hidden';
  panel.setAttribute('role', 'presentation');

  mountModelHostFilterBar(
    panel,
    {
      onFilterChange: () => rebuildOpenMenu(),
      onAfterRefresh: () => rebuildOpenMenu(),
      resolveLoadUnloadValue: resolveOpenMenuSelectValue,
    },
    'composer-model-menu__filter',
  );

  const menu = document.createElement('ul');
  menu.className = 'composer-model-menu__list model-select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Model');
  panel.appendChild(menu);
  mountModelMenuActions(panel, {
    resolveSelectValue: resolveOpenMenuSelectValue,
    closeMenu: closeComposerModelMenu,
    showReasoningDefault: variant !== 'board',
    onReasoningDefaultChange: (selectValue) => {
      refreshActiveChatReasoningDefault(selectValue);
    },
  });
  document.body.appendChild(panel);
  return { panel, menu };
}

function buildMenubarStyleTrigger(variant: MenubarStyleVariant): ComposerModelTrigger {
  const root = document.createElement('div');
  root.className =
    `mn-os-mb-model-chip composer-model-trigger-wrap composer-model-trigger-wrap--menubar composer-model-trigger-wrap--${variant}`;

  const expandEl = document.createElement('div');
  expandEl.className = 'mn-os-mb-model-expand';
  if (variant === 'board') {
    expandEl.classList.add('mn-os-mb-model-expand--board');
  }
  expandEl.setAttribute('aria-hidden', 'true');

  const expandInner = document.createElement('div');
  expandInner.className = 'mn-os-mb-model-expand-inner';

  const labelEl = document.createElement('span');
  labelEl.className = 'mn-os-mb-model-label';
  labelEl.textContent = 'Select model';

  const providerEl = document.createElement('span');
  providerEl.className = 'mn-os-mb-model-provider';
  providerEl.hidden = true;

  if (variant === 'menubar') {
    const expandRoleEl = document.createElement('span');
    expandRoleEl.className = 'mn-os-mb-model-expand-role';
    expandRoleEl.textContent = 'Default model';
    expandInner.append(expandRoleEl, labelEl, providerEl);
  } else {
    expandInner.append(labelEl, providerEl);
  }
  expandEl.appendChild(expandInner);

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'mn-os-mb-model-icon mn-os-mb-icon';
  triggerBtn.setAttribute('aria-haspopup', 'listbox');
  triggerBtn.setAttribute('aria-expanded', 'false');
  triggerBtn.setAttribute('aria-label', 'Default model');
  if (variant === 'board') {
    triggerBtn.dataset.focusKey = 'board-model';
  }

  const dotEl = document.createElement('span');
  dotEl.className = 'model-load-dot mn-os-mb-model-dot';
  dotEl.setAttribute('aria-hidden', 'true');

  const iconLogoEl = document.createElement('span');
  iconLogoEl.className = 'mn-os-mb-model-icon-logo hidden';
  iconLogoEl.setAttribute('aria-hidden', 'true');

  const fallbackWrap = document.createElement('span');
  fallbackWrap.className = 'mn-os-mb-model-fallback-wrap';
  fallbackWrap.innerHTML = MODEL_FALLBACK_ICON_SVG;
  fallbackWrap.setAttribute('aria-hidden', 'true');

  triggerBtn.append(dotEl, iconLogoEl, fallbackWrap);
  if (variant === 'menubar') {
    const staticRole = document.createElement('span');
    staticRole.className = 'mn-os-mb-model-static-role';
    staticRole.textContent = 'Default model';
    staticRole.setAttribute('aria-hidden', 'true');
    root.append(staticRole, triggerBtn);
  } else {
    root.appendChild(triggerBtn);
  }
  document.body.appendChild(expandEl);

  const { panel, menu } = createModelMenuPanel(variant);

  const entry: ComposerModelTrigger = {
    variant,
    root,
    trigger: triggerBtn,
    logoEl: iconLogoEl,
    labelEl,
    providerEl,
    iconLogoEl,
    dotEl,
    expandEl,
    menu,
    panel,
  };

  wireMenubarHover(entry);
  triggerBtn.addEventListener('click', () => toggleMenu(entry));
  triggers.push(entry);
  syncTrigger(entry);
  return entry;
}

function buildTrigger(variant: ComposerModelVariant): ComposerModelTrigger {
  if (isMenubarStyleVariant(variant)) {
    return buildMenubarStyleTrigger(variant);
  }

  const root = document.createElement('div');
  root.className = `composer-model-trigger-wrap composer-model-trigger-wrap--${variant}`;

  const triggerBtn = document.createElement('button');
  triggerBtn.type = 'button';
  triggerBtn.className = 'composer-model-trigger';
  triggerBtn.setAttribute('aria-haspopup', 'listbox');
  triggerBtn.setAttribute('aria-expanded', 'false');
  const ariaLabel =
    variant === 'research'
      ? 'Research model'
      : variant === 'super-plan'
        ? 'Super Plan model'
        : 'Active model';
  triggerBtn.setAttribute('aria-label', ariaLabel);

  const dotEl = document.createElement('span');
  dotEl.className = 'model-load-dot composer-model-trigger__spinner';
  dotEl.setAttribute('aria-hidden', 'true');

  const logoEl = document.createElement('span');
  logoEl.className = 'composer-model-trigger__logo hidden';
  logoEl.setAttribute('aria-hidden', 'true');

  const labelEl = document.createElement('span');
  labelEl.className = 'composer-model-trigger__label';
  labelEl.textContent = 'Select model';

  const chevronEl = document.createElement('span');
  chevronEl.className = 'composer-model-trigger__chevron';
  chevronEl.setAttribute('aria-hidden', 'true');
  chevronEl.innerHTML = CHEVRON_SVG;

  triggerBtn.append(dotEl, logoEl, labelEl, chevronEl);
  root.appendChild(triggerBtn);

  const { panel, menu } = createModelMenuPanel(variant);

  const entry: ComposerModelTrigger = {
    variant,
    root,
    trigger: triggerBtn,
    logoEl,
    labelEl,
    dotEl,
    menu,
    panel,
  };

  triggerBtn.addEventListener('click', () => toggleMenu(entry));
  triggers.push(entry);
  syncTrigger(entry);
  return entry;
}

// ── Mount ────────────────────────────────────────────────────────────────────

/** Mount a compact model trigger into an anchor element. */
export function mountComposerModelTrigger(
  anchor: HTMLElement,
  variant: ComposerModelSurfaceVariant,
): void {
  ensureGlobals();
  if (anchor.querySelector('.composer-model-trigger-wrap')) return;
  const entry = buildTrigger(variant);
  anchor.appendChild(entry.root);
}

/** Mount the menubar default-model icon chip (shared composer model menu). */
export function mountMenubarModelChipTrigger(anchor: HTMLElement): void {
  ensureGlobals();
  if (anchor.querySelector('.composer-model-trigger-wrap--menubar')) return;
  const entry = buildMenubarStyleTrigger('menubar');
  anchor.appendChild(entry.root);
}

/** Mount the orchestrate board model chip (same UI as menubar; per-board binding). */
export function mountBoardModelChipTrigger(anchor: HTMLElement): void {
  ensureGlobals();
  if (anchor.querySelector('.composer-model-trigger-wrap--board')) return;
  const entry = buildMenubarStyleTrigger('board');
  anchor.appendChild(entry.root);
}

/** Re-home the existing board chip, or mount one. */
export function adoptBoardModelChipTrigger(anchor: HTMLElement): void {
  ensureGlobals();
  const existing = findBoardModelTrigger();
  if (existing) {
    if (existing.root.parentElement !== anchor) anchor.appendChild(existing.root);
    return;
  }
  mountBoardModelChipTrigger(anchor);
}

/** Tear down the board model chip and floating menu (board header rebuild). */
export function unmountBoardModelChipTrigger(): void {
  const idx = triggers.findIndex((trigger) => trigger.variant === 'board');
  if (idx === -1) return;
  const entry = triggers[idx];
  if (openTrigger === entry) closeComposerModelMenu();
  clearMenubarCollapseTimer(entry);
  entry.expandEl?.remove();
  entry.panel.remove();
  entry.root.remove();
  triggers.splice(idx, 1);
  boardModelTriggerContext = null;
}

/** Mount the Code composer model chip into the trail, even when Tools is parked. */
function mountCodeComposerModelTrigger(): void {
  const existing = document.getElementById('codeComposerModelAnchor');
  if (existing) {
    mountComposerModelTrigger(existing, 'code');
    return;
  }

  const codeTrail = document.querySelector('.composer-controls__trail');
  if (!codeTrail) return;

  const codeAnchor = document.createElement('div');
  codeAnchor.id = 'codeComposerModelAnchor';
  codeAnchor.className = 'composer-model-trigger-anchor';
  // Compact overflow parks Tools out of the trail; only use it as a sibling when it is still here.
  const toolsInTrail = codeTrail.querySelector('.composer-tools-anchor');
  codeTrail.insertBefore(codeAnchor, toolsInTrail ?? codeTrail.firstChild);
  mountComposerModelTrigger(codeAnchor, 'code');
}

function mountChatAppComposerModelTrigger(): void {
  const chatInputRow = document.querySelector('.chat-app-input');
  const chatToolsAnchor = chatInputRow?.querySelector('.chat-app-tools-anchor');
  if (!chatInputRow || !chatToolsAnchor || chatInputRow.querySelector('#chatAppComposerModelAnchor')) {
    return;
  }

  const chatAnchor = document.createElement('div');
  chatAnchor.id = 'chatAppComposerModelAnchor';
  chatAnchor.className = 'composer-model-trigger-anchor';
  chatInputRow.insertBefore(chatAnchor, chatToolsAnchor);
  mountComposerModelTrigger(chatAnchor, 'chat');
}

/** Mount the Research engine popover model picker (canonical #modelSelect menu). */
export function mountResearchComposerModelTrigger(): void {
  ensureGlobals();
  const anchor = document.getElementById('researchComposerModelAnchor');
  if (!anchor || anchor.querySelector('.composer-model-trigger-wrap')) {
    return;
  }
  const entry = buildTrigger('research');
  anchor.appendChild(entry.root);
}

/** Tear down Super Plan model picker when the planning surface closes. */
export function unmountSuperPlanComposerModelTrigger(): void {
  const idx = triggers.findIndex((trigger) => trigger.variant === 'super-plan');
  if (idx === -1) return;
  const entry = triggers[idx];
  if (openTrigger === entry) closeComposerModelMenu();
  entry.panel.remove();
  entry.root.remove();
  triggers.splice(idx, 1);
}

/** Wire desktop + Code + Chat composer model triggers (idempotent). */
export function initComposerModelTriggers(): void {
  window.addEventListener('minnow-router-assignment', syncComposerModelTriggers);
  ensureGlobals();
  initChatModelSelectShortcut();

  const desktopAnchor = document.getElementById('desktopComposerModelAnchor');
  if (desktopAnchor) {
    mountComposerModelTrigger(desktopAnchor, 'desktop');
  }

  mountCodeComposerModelTrigger();
  mountChatAppComposerModelTrigger();

  if (!activityFeedUnsub) {
    activityFeedUnsub = subscribeServeActivityFeed(() => {
      syncActivityOnly();
    });
  }
}

/** Close the app-wide activity stream (called on quit). */
export function teardownComposerModelTriggers(): void {
  window.removeEventListener('minnow-router-assignment', syncComposerModelTriggers);
  activityFeedUnsub?.();
  activityFeedUnsub = null;
}
