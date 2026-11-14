import '../../styles/surfaces.css';
import { findChatById, getActiveChat, getChatMessageCount, sessionState } from '../../state/sessions';
import { getWorkspacePath } from '../../state/workspace';
import type { Chat } from '../../types';
import { endTabDrag } from '../../attachments/tab-drag';
import { createIcon, type IconName } from '../icon';
import { openContextMenu, type MenuItem } from '../context-menu';
import { isPhoneLayout, onPhoneLayoutChange } from '../mobile-layout';
import { markPreviewOccluder, unmarkPreviewOccluder } from '../preview-occlusion';
import {
  scheduleElectronPreviewHostLayoutSync,
  scheduleSecondaryPreviewHostLayoutSync,
} from '../preview-electron-visibility';
import { createPointerFrame } from '../pointer-frame';
import { setGraphiteSurfaceBridge } from './surface-bridge';
import {
  SURFACES, SURFACE_GROUPS, SURFACE_TABS, type ContentTabPlacement, type SurfaceAvailability, type SurfaceContent,
  type SurfaceContext, type SurfaceRegistration,
} from './surface-registry';
import {
  activateSurfaceTab, closeSurfaceTab, contentTab, getPanelTabs, getSurfaceDock, getSurfacePanel, isPanelVisible,
  isSurfaceId, launcherPanelForKey, mergeSurfaceTabs, normalizeSurfaceState, openSurfaceTab, PANEL_SIZES,
  setPanelShown, splitSurfaceTabs, surfaceSize, surfaceSplitRatio, SURFACE_DOCKS, SURFACE_PANELS,
  toggleMaximizedPanel, type ContentTabId, type LauncherSurfaceId, type SurfaceDock, type SurfaceId,
  type SurfacePanel, type SurfaceTab, type ThreadSurfaceState,
} from './surface-state';

export type { SurfaceId, SurfacePanel } from './surface-state';
export type { SurfaceContext, SurfaceRegistration } from './surface-registry';

const PREFIX = 'minnow.graphite.surfaces.v1';
const SIZE_KEY = `${PREFIX}.sizes`;
const CONTENT_TAB_MIME = 'application/x-minnow-surface-tab';
const SIDE_CHAT_MIN_WIDTH = 360;
const SIDE_SPLIT_MIN_WIDTH = 600;
const SIDE_MAXIMIZE_OVERSHOOT = 48;

interface PanelElements {
  root: HTMLElement;
  title: HTMLElement;
  strip: HTMLElement;
  add: HTMLButtonElement;
  controls: HTMLElement;
  body: HTMLElement;
  launcher: HTMLElement;
  contentLimit: HTMLElement;
  resizer: HTMLElement;
  signature: string;
}

interface ActiveSurface {
  context: SurfaceContext;
  node: HTMLElement;
}

let stage: HTMLElement | null = null;
let content: SurfaceContent | undefined;
let activeKey = '';
let state = normalizeSurfaceState();
let desktopState: ThreadSurfaceState | undefined;
let renderInProgress = false;
let refreshQueued = false;
let mobileShown: SurfaceDock | null = null;
let mobileReturnFocus: HTMLElement | null = null;
let mobileBackdrop: HTMLButtonElement;
let mobilePortal: { host: HTMLElement; chatId?: string } | undefined;
const panelSlides = new Map<SurfaceDock, { key: string; tab: SurfaceTab; closing: boolean }>();
let legacySurfaces: readonly SurfaceId[] = [];
let legacyMigrated = false;
let sizes: Record<SurfaceDock, number> = { side: PANEL_SIZES.side.default, bottom: PANEL_SIZES.bottom.default };
const dragSizes: Partial<Record<SurfaceDock, number>> = {};
const mounted = new Map<SurfacePanel, PanelElements>();
const registrations = new Map<SurfaceId, SurfaceRegistration>();
const visible = new Map<SurfaceId, ActiveSurface>();
const wrappers = new Map<SurfaceId, HTMLElement>();
const targets = new Map<SurfaceId, unknown>();
const panelToggles = new Map<SurfaceDock, HTMLButtonElement>();

function read(key: string): unknown {
  try {
    const value = localStorage.getItem(key);
    return value === null ? undefined : JSON.parse(value);
  } catch { return undefined; }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep this view usable when storage is unavailable. */ }
}

function preferenceKey(chat: Chat): string {
  const workspace = chat.workspacePath || getWorkspacePath();
  return `${PREFIX}.thread.${JSON.stringify([workspace, chat.id])}`;
}

function getContextChat(): Chat | undefined {
  if (mobilePortal?.chatId) return findChatById(mobilePortal.chatId);
  return sessionState ? getActiveChat() : undefined;
}

export function isCurrentSurfaceChat(chatId: string): boolean {
  return stage !== null && getContextChat()?.id === chatId;
}

export function usePhonePresentation(): boolean {
  return Boolean(mobilePortal || document.documentElement.classList.contains('mn-mobile-app') || isPhoneLayout());
}

function isBoardsStageOpen(): boolean {
  return !mobilePortal && Boolean(stage?.querySelector('#orchestratorBoardsRoot'));
}

function syncChat(chat: Chat): void {
  const next = preferenceKey(chat);
  if (activeKey === next) return;
  activeKey = next;
  const saved = read(next);
  state = normalizeSurfaceState(saved);
  desktopState = undefined;
  if (!legacyMigrated) {
    legacyMigrated = true;
    const migrationKey = `${PREFIX}.migrated.${JSON.stringify(chat.workspacePath || getWorkspacePath())}`;
    if (saved === undefined && read(migrationKey) !== true && legacySurfaces.length &&
      getChatMessageCount(chat) > 0 && !usePhonePresentation()) {
      for (const id of legacySurfaces) openSurfaceTab(state, id);
      persist();
    }
    if (!usePhonePresentation()) write(migrationKey, true);
  }
  content?.restore(state, saved !== undefined);
  if (content) persist();
  targets.clear();
  mobileShown = null;
}

function context(chat: Chat, id: SurfaceId, panel: SurfacePanel): SurfaceContext {
  return { chat, target: targets.get(id), panel };
}

function getAvailability(id: SurfaceId, ctx: SurfaceContext): SurfaceAvailability {
  if (id === 'preview' && content) return { available: true };
  if (contentTab(id)) return { available: Boolean(content?.describe(id as ContentTabId)) };
  const registration = registrations.get(id);
  if (!registration) return { available: false, reason: 'Unavailable in this workspace' };
  return registration.availability?.(ctx) ?? { available: true };
}

function persist(): void {
  if (activeKey && !desktopState) write(activeKey, state);
}

function otherDock(panel: SurfacePanel): SurfaceDock {
  return getSurfaceDock(state, panel) === 'side' ? 'bottom' : 'side';
}

function syncViewport(): void {
  if (usePhonePresentation() && !desktopState) {
    desktopState = state;
    state = normalizeSurfaceState(state);
    mergeSurfaceTabs(state);
  } else if (!usePhonePresentation() && desktopState) {
    state = desktopState;
    desktopState = undefined;
  }
}

function placePanel(panel: SurfaceDock, root: HTMLElement, open: boolean, docked: boolean, animateClose: boolean): void {
  const wasHidden = root.hidden;
  const wasClosing = root.classList.contains('graphite-surface-panel--closing');
  const priorSlide = panelSlides.get(panel);
  // Keep the live tab mounted and non-interactive while its grid track closes.
  const closing = docked && !open && !wasHidden && (animateClose ||
    (priorSlide?.closing === true && priorSlide.key === activeKey && priorSlide.tab === state[panel].active));
  root.classList.toggle('graphite-surface-panel--closing', closing);
  root.toggleAttribute('inert', closing);
  root.toggleAttribute('hidden', !open && !closing);

  if (!docked || root.hidden) {
    panelSlides.delete(panel);
    root.classList.remove('graphite-surface-panel--sliding');
  } else if (wasHidden || wasClosing !== closing) {
    const transition = stage?.getAnimations?.().find(animation =>
      'transitionProperty' in animation && animation.transitionProperty === `--mn-graphite-${panel}-reveal`);
    root.classList.toggle('graphite-surface-panel--sliding', Boolean(transition));
    if (transition) {
      const slide = { key: activeKey, tab: state[panel].active, closing };
      panelSlides.set(panel, slide);
      const finish = () => {
        if (panelSlides.get(panel) !== slide) return;
        panelSlides.delete(panel);
        root.classList.remove('graphite-surface-panel--sliding');
        if (closing) render();
        else schedulePreviewLayout();
      };
      void transition.finished.then(finish, finish);
    } else {
      panelSlides.delete(panel);
      if (closing) {
        root.hidden = true;
        root.removeAttribute('inert');
        root.classList.remove('graphite-surface-panel--closing');
      }
    }
  }
}

function renderPlacement(animateClose?: SurfaceDock): void {
  if (!stage) return;
  const isPhone = usePhonePresentation();
  const showPanels = !isBoardsStageOpen();
  const side = showPanels && (isPhone ? mobileShown === 'side' : isPanelVisible(state, 'side'));
  const bottom = showPanels && (isPhone ? mobileShown === 'bottom' : isPanelVisible(state, 'bottom'));
  stage.dataset.surfaceSide = String(side);
  stage.dataset.surfaceBottom = String(bottom);
  stage.dataset.surfaceMax = showPanels && !isPhone ? state.maximized ?? '' : '';
  stage.classList.toggle('graphite-surfaces--phone', isPhone);
  mobileBackdrop.hidden = !(isPhone && (side || bottom));
  document.getElementById('mainColumn')?.toggleAttribute('inert', isPhone && (side || bottom));
  for (const panel of SURFACE_DOCKS) {
    const open = panel === 'side' ? side : bottom;
    const root = mounted.get(panel)?.root;
    if (root) placePanel(panel, root, open, showPanels && !isPhone && !state.maximized, animateClose === panel);
    if (isPhone && open) {
      root?.setAttribute('role', 'dialog');
      root?.setAttribute('aria-modal', 'true');
    } else {
      root?.removeAttribute('role');
      root?.removeAttribute('aria-modal');
    }
    panelToggles.get(panel)?.setAttribute('aria-pressed', String(open));
  }
  const split = mounted.get('split')!;
  const dock = !isPhone && state.split.dock ? mounted.get(state.split.dock) : undefined;
  split.root.hidden = !dock || dock.root.hidden;
  moveSurfaceNode(split.root, dock?.root ?? stage);
  for (const panel of SURFACE_DOCKS) {
    const view = mounted.get(panel)!;
    view.root.classList.toggle('graphite-surface-panel--split-dock', view === dock && !split.root.hidden);
  }
  applySplitRatio(state.split.ratio);
  applySizes();
}

function updateSize(panel: SurfaceDock, value: number): void {
  sizes[panel] = dockSize(panel, value);
  write(SIZE_KEY, sizes);
  applySizes();
  schedulePreviewLayout();
}

function availableSize(panel: SurfaceDock): number {
  const dimension = panel === 'side' ? stage?.clientWidth : stage?.clientHeight;
  if (!dimension) return Infinity;
  return Math.max(0, dimension - (panel === 'side' ? SIDE_CHAT_MIN_WIDTH : 180));
}

function dockSize(panel: SurfaceDock, value: number, available = availableSize(panel)): number {
  const preferred = panel === 'side' && state.split.dock === panel ? Math.max(SIDE_SPLIT_MIN_WIDTH, value) : value;
  return surfaceSize(panel, preferred, available);
}

function applySizes(): void {
  for (const panel of SURFACE_DOCKS) {
    const available = availableSize(panel);
    const applied = dockSize(panel, dragSizes[panel] ?? sizes[panel], available);
    const resizer = mounted.get(panel)?.resizer;
    stage?.style.setProperty(`--mn-graphite-${panel}-size`, `${applied}px`);
    resizer?.setAttribute('aria-valuemin', String(dockSize(panel, PANEL_SIZES[panel].min, available)));
    const max = Math.min(PANEL_SIZES[panel].max, available);
    if (Number.isFinite(max)) resizer?.setAttribute('aria-valuemax', String(max));
    else resizer?.removeAttribute('aria-valuemax');
    resizer?.setAttribute('aria-valuenow', String(applied));
  }
}

function schedulePreviewLayout(): void {
  scheduleElectronPreviewHostLayoutSync();
  scheduleSecondaryPreviewHostLayoutSync();
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function control(label: string, icon: IconName, run: () => void): HTMLButtonElement {
  const button = element('button', 'graphite-surface-icon');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(createIcon(icon, { size: 14 }));
  button.addEventListener('click', run);
  return button;
}

function panelName(panel: SurfacePanel): string {
  return { side: 'Side panel', bottom: 'Bottom panel', split: 'Right group' }[panel];
}

function selected(id: SurfaceId, panel: SurfacePanel): boolean {
  return state[panel].active === id;
}

function tabsForPanel(panel: SurfacePanel, chat: Chat): SurfaceId[] {
  return getPanelTabs(state, panel).filter(id => {
    // Keep selected tabs mounted while their live data is loading or temporarily unavailable.
    return selected(id, panel) || getAvailability(id, context(chat, id, panel)).available;
  });
}

function focusSelected(panel: SurfacePanel): void {
  const view = mounted.get(panel);
  if (!view) return;
  if (view.root.classList.contains('graphite-surface-panel--changes-sheet')) {
    view.controls.querySelector('button')?.focus({ preventScroll: true });
    return;
  }
  const selectedTab = view.strip.querySelector<HTMLElement>('[aria-selected="true"]');
  (selectedTab ?? view.launcher)?.focus({ preventScroll: true });
}

function focusPanelOpener(panel: SurfacePanel): void {
  const fallback = document.getElementById('msgInput');
  const target = panelToggles.get(getSurfaceDock(state, panel));
  if (target?.getClientRects().length) target.focus({ preventScroll: true });
  else fallback?.focus({ preventScroll: true });
}

function setActiveTab(panel: SurfacePanel, id: SurfaceId | 'launch', focus = true): void {
  activateSurfaceTab(state, panel, id);
  persist();
  render();
  if (focus) focusSelected(panel);
}

async function closeTab(panel: SurfacePanel, id: SurfaceId): Promise<void> {
  if (contentTab(id)) {
    await content?.close(id as ContentTabId);
    if (!mounted.get(panel)?.root.contains(document.activeElement) && document.activeElement !== document.body) return;
    render();
    focusSelected(panel);
    return;
  }
  closeSurfaceTab(state, id);
  targets.delete(id);
  registrations.get(id)?.close?.();
  persist();
  render();
  focusSelected(panel);
}

export function dismissSurface(id: LauncherSurfaceId): void {
  if (state.open.includes(id)) void closeTab(getSurfacePanel(state, id), id);
}

function renderLauncher(panel: SurfacePanel, view: PanelElements, chat: Chat): void {
  const dock = getSurfaceDock(state, panel);
  const compact = dock === 'bottom' && state.maximized !== dock && !usePhonePresentation();
  const groups = SURFACE_GROUPS.map(({ id, label, items }) => ({
    id, label, choices: items.map(item => ({
      item,
      availability: getAvailability(item.id, context(chat, item.id, panel)),
      action: item.action && registrations.has(item.action.id) ? item.action : undefined,
    })),
  }));
  const signature = JSON.stringify([compact, groups.map(group => group.choices.map(({ availability, action }) =>
    [availability, Boolean(action)]))]);
  if (view.launcher.dataset.signature !== signature) {
    view.launcher.dataset.signature = signature;
    view.launcher.classList.toggle('graphite-surface-launcher--compact', compact);
    const focused = view.launcher.contains(document.activeElement) ? document.activeElement?.id : undefined;
    const header = element('div', 'graphite-surface-launcher-header');
    const heading = element('span', 'graphite-surface-launcher-title');
    heading.textContent = 'Open a surface';
    const note = element('span', 'graphite-surface-launcher-note');
    note.textContent = 'Press a shortcut to open a tab.';
    header.append(heading, note);
    header.hidden = compact;
    view.launcher.replaceChildren(header);
    for (const group of groups) {
      const list = element('div', 'graphite-surface-launcher-group');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', group.label);
      list.dataset.group = group.id;
      const caption = element('span', 'graphite-surface-launcher-caption');
      caption.textContent = group.label;
      caption.setAttribute('aria-hidden', 'true');
      list.append(caption);
      for (const { item, availability, action } of group.choices) {
        const button = element('button', 'graphite-surface-choice');
        button.type = 'button';
        button.id = `graphiteLaunch-${panel}-${item.id}`;
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-label', item.label);
        button.setAttribute('aria-disabled', String(!availability.available));
        const description = availability.available
          ? [item.description, availability.hint].filter(Boolean).join(' · ')
          : availability.reason ?? 'Unavailable';
        const stats = availability.available ? availability.diffStats : undefined;
        button.setAttribute('aria-description', stats
          ? `${description}. ${stats.additions} added, ${stats.deletions} deleted.`
          : description);
        const copy = element('span', 'graphite-surface-choice-copy');
        const title = element('span', 'graphite-surface-choice-title');
        const label = element('span', 'graphite-surface-choice-label');
        label.textContent = item.label;
        title.append(label);
        if (stats) {
          const counts = element('span', 'graphite-surface-choice-stats');
          counts.setAttribute('aria-hidden', 'true');
          const added = element('span', 'graphite-surface-choice-added');
          added.textContent = `+${stats.additions}`;
          const deleted = element('span', 'graphite-surface-choice-deleted');
          deleted.textContent = `−${stats.deletions}`;
          counts.append(added, deleted);
          title.append(counts);
        }
        const hint = element('span', 'graphite-surface-choice-hint');
        hint.textContent = description;
        copy.append(title, hint);
        button.append(createIcon(item.icon, { size: 14, className: 'graphite-surface-choice-icon' }), copy);
        if (availability.available) {
          const key = element('kbd', 'graphite-surface-key');
          key.textContent = item.key;
          key.setAttribute('aria-hidden', 'true');
          button.setAttribute('aria-keyshortcuts', item.key);
          button.append(key);
        }
        button.addEventListener('click', () => {
          if (availability.available && openSurface(item.id, { panel }) && !(content && item.id === 'preview')) focusSelected(panel);
        });
        if (action) {
          const card = element('div', 'graphite-surface-choice-with-action');
          const shortcut = element('button', 'graphite-surface-choice-action');
          shortcut.type = 'button';
          shortcut.id = `${button.id}-action`;
          shortcut.title = action.label;
          shortcut.setAttribute('role', 'menuitem');
          shortcut.setAttribute('aria-label', action.label);
          shortcut.append(createIcon(action.icon, { size: 13 }));
          shortcut.addEventListener('click', () => {
            if (openSurface(action.id, { panel, force: true, target: action.target })) focusSelected(panel);
          });
          card.append(button, shortcut);
          list.append(card);
        } else {
          list.append(button);
        }
      }
      view.launcher.append(list);
    }
    if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  }
}

function surfaceDomKey(id: SurfaceId): string {
  return encodeURIComponent(id);
}

function renderPanelChrome(panel: SurfacePanel, view: PanelElements, chat: Chat): void {
  const tabs = tabsForPanel(panel, chat);
  const active = state[panel].active;
  const launcher = active === 'launch' || !tabs.includes(active);
  const dock = getSurfaceDock(state, panel);
  const maximized = state.maximized === dock;
  const split = state.split.dock;
  const isPhone = usePhonePresentation();
  const phoneChanges = isPhone && active === 'changes' && !launcher;
  const name = panelName(panel);
  view.root.classList.toggle('graphite-surface-panel--changes-sheet', phoneChanges);
  view.root.setAttribute('aria-label', phoneChanges ? 'Diff' : name);
  view.title.hidden = !phoneChanges;
  view.strip.hidden = phoneChanges;
  view.add.hidden = phoneChanges;
  const counts = new Map<SurfaceId, number>();
  for (const id of tabs) {
    if (id !== 'changes' && id !== 'agents') continue;
    const availability = getAvailability(id, context(chat, id, panel));
    const count = availability.tabCount ?? (id === 'agents' ? Number(availability.hint) : undefined);
    if (count && Number.isFinite(count)) counts.set(id, count);
  }
  const labels = tabs.map(id => contentTab(id) ? content?.describe(id as ContentTabId) : undefined);
  const signature = JSON.stringify([tabs, active, maximized, isPhone, split, Array.from(counts),
    labels.map(label => label && [label.label, label.title, label.dirty, label.loading])]);
  if (view.signature !== signature) {
    view.signature = signature;
    const focusId = view.strip.contains(document.activeElement) ? document.activeElement?.id : undefined;
    view.strip.replaceChildren();
    let activeWrap: HTMLElement | undefined;
    for (const [index, id] of tabs.entries()) {
      const item = SURFACE_TABS.find(surface => surface.id === id);
      const details = labels[index];
      const label = details?.label ?? item?.label ?? id;
      const tabWrap = element('span', 'graphite-surface-tab-wrap');
      tabWrap.dataset.surfaceTab = id;
      const tab = element('button', 'graphite-surface-tab');
      tab.type = 'button';
      tab.id = `graphiteTab-${panel}-${surfaceDomKey(id)}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `graphitePanel-${surfaceDomKey(id)}`);
      tab.setAttribute('aria-selected', String(selected(id, panel)));
      tab.tabIndex = selected(id, panel) || (launcher && id === tabs[0]) ? 0 : -1;
      tab.title = details?.title ?? (item?.key ? `${label} (${item.key})` : label);
      const name = element('span', 'graphite-surface-tab-label');
      name.textContent = label;
      tab.append(details?.icon() ?? createIcon(item?.icon ?? 'fileText', { size: 14 }), name);
      if (details?.dirty) {
        const dot = element('span', 'graphite-surface-tab-dirty');
        dot.setAttribute('aria-hidden', 'true');
        tab.setAttribute('aria-description', 'Unsaved changes');
        tab.append(dot);
      }
      tab.classList.toggle('is-loading', Boolean(details?.loading));
      const count = counts.get(id);
      if (count) {
        const badge = element('span', 'graphite-surface-tab-count');
        badge.textContent = String(count);
        tab.append(badge);
      }
      tab.addEventListener('click', () => setActiveTab(panel, id));
      const close = control(`Close ${label}`, 'close', () => void closeTab(panel, id));
      close.id = `${tab.id}-close`;
      tabWrap.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        event.preventDefault();
        void closeTab(panel, id);
      });
      if (contentTab(id)) {
        tabWrap.draggable = true;
        tabWrap.addEventListener('dragstart', event => {
          const transfer = event.dataTransfer;
          if (!transfer) return;
          transfer.setData(CONTENT_TAB_MIME, id);
          transfer.effectAllowed = 'copyMove';
          content?.drag(id as ContentTabId, transfer);
        });
        tabWrap.addEventListener('dragend', endTabDrag);
        tabWrap.addEventListener('contextmenu', event => {
          event.preventDefault();
          const items: MenuItem[] = [{ id: 'close', label: 'Close', onSelect: () => void closeTab(panel, id) }];
          if (!isPhone) items.push({
            id: 'move',
            label: `Move to ${panelName(otherDock(panel)).toLowerCase()}`,
            onSelect: () => moveTab(panel, id),
          });
          if (!isPhone && split === dock) items.push({
            id: 'move-split',
            label: panel === 'split' ? 'Move to left group' : 'Move to right group',
            onSelect: () => moveTab(panel, id, panel === 'split' ? dock : 'split'),
          });
          const file = contentTab(id);
          if (file?.kind === 'file') {
            const paths = tabs.flatMap(id => {
              const tab = contentTab(id);
              return tab?.kind === 'file' ? [tab.key] : [];
            });
            const right = paths.slice(paths.indexOf(file.key) + 1);
            const closeFiles = (paths: string[]) => void content?.closeFiles(paths);
            items.push(
              { id: 'close-others', label: 'Close other files', disabled: paths.length < 2, onSelect: () => closeFiles(paths.filter(path => path !== file.key)) },
              { id: 'close-right', label: 'Close files to the right', disabled: !right.length, onSelect: () => closeFiles(right) },
              { id: 'close-all', label: 'Close all files in this panel', onSelect: () => closeFiles(paths) },
            );
          }
          openContextMenu({ clientX: event.clientX, clientY: event.clientY, restoreFocus: tab, label, items });
        });
      }
      close.classList.add('graphite-surface-close-tab');
      tabWrap.append(tab, close);
      view.strip.append(tabWrap);
      if (id === active) activeWrap = tabWrap;
    }
    view.add.setAttribute('aria-pressed', String(launcher));
    view.controls.replaceChildren();
    if (!isPhone && !maximized && active !== 'launch') {
      const move = control(`Move to ${panelName(otherDock(panel)).toLowerCase()}`,
        'inspectorPanel', () => moveActiveSurface(panel));
      move.classList.toggle('graphite-surface-icon--bottom', dock === 'side');
      view.controls.append(move);
    }
    if (!isPhone && panel !== 'split' && !split) {
      const splitButton = control('Split right', 'appCompare', () => splitSurfacePanel(panel));
      splitButton.setAttribute('aria-keyshortcuts', 'Control+\\ Meta+\\');
      view.controls.append(splitButton);
    }
    if (!isPhone && panel !== 'split') {
      const maximize = control(maximized ? 'Restore' : 'Maximize', maximized ? 'restore' : 'expand',
        () => toggleSurfaceMaximize(panel));
      maximize.setAttribute('aria-pressed', String(maximized));
      view.controls.append(maximize);
    }
    view.controls.append(panel === 'split'
      ? control('Close split', 'close', closeSurfaceSplit)
      : control(phoneChanges ? 'Close Diff' : `Hide ${name.toLowerCase()}`, 'close', () => toggleSurfacePanel(panel)));
    if (activeWrap) {
      const strip = view.strip.getBoundingClientRect();
      const tab = activeWrap.getBoundingClientRect();
      if (tab.left < strip.left) view.strip.scrollLeft -= strip.left - tab.left;
      else if (tab.right > strip.right) view.strip.scrollLeft += tab.right - strip.right;
    }
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  view.resizer.hidden = panel !== 'split' && (maximized || isPhone);
  view.launcher.hidden = !launcher;
  if (launcher) renderLauncher(panel, view, chat);
}

export function moveSurfaceNode(node: HTMLElement, host: HTMLElement): void {
  if (node.parentElement === host) return;
  // Connected moves retain iframe and native input state in Chromium. Other
  // renderers fall back to the portable DOM operation with the same node.
  const connectedHost = host as HTMLElement & { moveBefore?: (node: Node, before: Node | null) => void };
  if (node.isConnected && host.isConnected && connectedHost.moveBefore) connectedHost.moveBefore(node, null);
  else host.append(node);
}

function renderSurfaces(chat: Chat): void {
  const next = new Map<SurfaceId, { view: PanelElements; context: SurfaceContext }>();
  const workbench: ContentTabPlacement[] = [];
  for (const panel of SURFACE_PANELS) {
    const view = mounted.get(panel)!;
    if (view.root.hidden) continue;
    if (!view.root.closest('[inert]')) renderPanelChrome(panel, view, chat);
    view.contentLimit.hidden = true;
    const id = state[panel].active;
    if (id === 'launch') continue;
    const ctx = context(chat, id, panel);
    if (contentTab(id)) workbench.push({ id: id as ContentTabId, ...ctx });
    if (registrations.has(id) || contentTab(id)) next.set(id, { view, context: ctx });
  }
  // Each content kind has two live hosts. Keep the focused tab visible when
  // the split and the other dock all select the same kind of content.
  if (workbench.length === 3 && workbench.every(tab => contentTab(tab.id)?.kind === contentTab(workbench[0].id)?.kind)) {
    const deferredPanel = getSurfaceDock(state, state.focused) === state.split.dock ? otherDock('split') : 'split';
    const index = workbench.findIndex(tab => tab.panel === deferredPanel);
    const [deferred] = workbench.splice(index, 1);
    next.get(deferred.id)!.view.contentLimit.hidden = false;
    next.delete(deferred.id);
  }
  for (const [id, prior] of visible) {
    const newContext = next.get(id)?.context;
    if (newContext?.chat.id === prior.context.chat.id) continue;
    registrations.get(id)?.setVisible?.(false, prior.context);
    visible.delete(id);
    const wrapper = wrappers.get(id);
    if (wrapper) wrapper.hidden = true;
  }
  content?.layout(workbench, state.focused);
  for (const [id, current] of next) {
    const registration = registrations.get(id);
    const node = contentTab(id) ? content?.render(id as ContentTabId) : registration?.render(current.context);
    if (!node) continue;
    let wrapper = wrappers.get(id);
    if (!wrapper) {
      wrapper = element('div', 'graphite-surface-pane');
      wrapper.id = `graphitePanel-${surfaceDomKey(id)}`;
      wrapper.setAttribute('role', 'tabpanel');
      wrappers.set(id, wrapper);
    }
    const phoneChanges = id === 'changes' &&
      current.view.root.classList.contains('graphite-surface-panel--changes-sheet');
    if (phoneChanges) {
      wrapper.removeAttribute('role');
      wrapper.removeAttribute('aria-labelledby');
    } else {
      wrapper.setAttribute('role', 'tabpanel');
      wrapper.setAttribute('aria-labelledby', `graphiteTab-${current.context.panel}-${surfaceDomKey(id)}`);
    }
    moveSurfaceNode(wrapper, current.view.body);
    wrapper.hidden = false;
    if (node.parentElement !== wrapper) {
      wrapper.replaceChildren();
      moveSurfaceNode(node, wrapper);
    }
    const previous = visible.get(id);
    if (!previous || previous.node !== node || previous.context.panel !== current.context.panel) {
      registration?.setVisible?.(true, current.context);
    }
    visible.set(id, { node, context: current.context });
  }
}

function render(animateClose?: SurfaceDock): void {
  if (!stage || renderInProgress) return;
  const chat = getContextChat();
  if (!chat) return;
  renderInProgress = true;
  try {
    syncChat(chat);
    syncViewport();
    for (const id of state.open) {
      const missing = id === 'review' ? !getAvailability(id, context(chat, id, getSurfacePanel(state, id))).available
        : contentTab(id) && !content?.describe(id as ContentTabId);
      if (!missing) continue;
      closeSurfaceTab(state, id);
      persist();
    }
    renderPlacement(animateClose);
    renderSurfaces(chat);
    for (const [id, wrapper] of wrappers) {
      if (!contentTab(id) || content?.describe(id as ContentTabId)) continue;
      wrapper.remove();
      wrappers.delete(id);
    }
    schedulePreviewLayout();
  } finally { renderInProgress = false; }
}

export function refreshSurfacePanels(): void {
  if (refreshQueued || !stage) return;
  refreshQueued = true;
  queueMicrotask(() => {
    refreshQueued = false;
    render();
  });
}

export function retargetContentSurface(from: ContentTabId, to: ContentTabId): void {
  if (!state.open.includes(from) || state.open.includes(to)) return;
  state.open = state.open.map(id => id === from ? to : id);
  state.panelOf[to] = state.panelOf[from];
  delete state.panelOf[from];
  for (const panel of SURFACE_PANELS) {
    if (state[panel].active === from) state[panel].active = to;
  }
  persist();
}

export function registerSurface(id: SurfaceId, registration: SurfaceRegistration): () => void {
  registrations.set(id, registration);
  refreshSurfacePanels();
  return () => {
    if (registrations.get(id) !== registration) return;
    const previous = visible.get(id);
    if (previous) registration.setVisible?.(false, previous.context);
    registrations.delete(id);
    refreshSurfacePanels();
  };
}

interface OpenSurfaceOptions {
  panel?: SurfacePanel;
  target?: unknown;
  /** Direct application commands may open an empty surface such as a clean Diff. */
  force?: boolean;
}

function openMobile(panel: SurfacePanel): void {
  if (!usePhonePresentation()) return;
  if (!mobileShown && document.activeElement instanceof HTMLElement) mobileReturnFocus = document.activeElement;
  mobileShown = getSurfaceDock(state, panel);
}

export function openSurface(id: LauncherSurfaceId, options: OpenSurfaceOptions = {}): boolean {
  if (!stage) return false;
  const chat = getContextChat();
  if (!chat || (!registrations.has(id) && !(content && id === 'preview'))) return false;
  syncChat(chat);
  syncViewport();
  const panel = options.panel ?? getSurfacePanel(state, id);
  const ctx = { chat, target: options.target, panel };
  if (!options.force && !getAvailability(id, ctx).available) return false;
  if (id === 'preview' && content) {
    void Promise.resolve(content.openBrowser(ctx)).catch(error => console.error('[graphite] Failed to open Browser', error));
    return true;
  }
  openSurfaceTab(state, id, options.panel);
  targets.set(id, options.target);
  openMobile(panel);
  persist();
  render();
  if (id === 'changes' && usePhonePresentation()) focusSelected(panel);
  const result = registrations.get(id)?.open?.(ctx);
  if (result) void Promise.resolve(result).catch(error => console.error(`[graphite] Failed to open ${id}`, error));
  return true;
}

export function toggleSurfacePanel(panel: SurfacePanel): void {
  if (!stage) return;
  const chat = getContextChat();
  if (!chat) return;
  syncChat(chat);
  syncViewport();
  const dock = getSurfaceDock(state, panel);
  if (usePhonePresentation()) {
    if (mobileShown === dock) {
      mobileShown = null;
      render();
      mobileReturnFocus?.focus({ preventScroll: true });
      mobileReturnFocus = null;
      return;
    }
    openMobile(panel);
    render();
    focusSelected(panel);
    return;
  }
  const wasVisible = isPanelVisible(state, dock);
  const animateClose = wasVisible && !state.maximized;
  setPanelShown(state, dock, !wasVisible);
  if (!wasVisible && state.maximized !== dock) state.maximized = null;
  persist();
  render(animateClose ? dock : undefined);
  if (!wasVisible) focusSelected(panel);
  else focusPanelOpener(panel);
}

export function moveActiveSurface(panel: SurfacePanel = state.focused): void {
  const id = state[panel].active;
  if (id !== 'launch') moveTab(panel, id);
}

function moveTab(panel: SurfacePanel, id: SurfaceId, destination: SurfacePanel = otherDock(panel)): void {
  openSurfaceTab(state, id, destination);
  persist();
  render();
  focusSelected(destination);
}

function splitSurfacePanel(panel?: SurfacePanel): boolean {
  const chat = getContextChat();
  if (!stage || !chat || usePhonePresentation()) return false;
  syncChat(chat);
  syncViewport();
  const source = panel ?? state.focused;
  const dock = getSurfaceDock(state, source);
  if (!isPanelVisible(state, source) || (state.split.dock && state.split.dock !== dock)) return false;
  const destination = source === 'split' ? dock : 'split';
  if (!state.split.dock) {
    splitSurfaceTabs(state, dock, state[dock].active);
  } else {
    const active = state[source].active;
    if (active !== 'launch' && getPanelTabs(state, source).length > 1) openSurfaceTab(state, active, destination);
    else state.focused = destination;
  }
  persist();
  render();
  focusSelected(destination);
  return true;
}

function closeSurfaceSplit(): void {
  const dock = mergeSurfaceTabs(state);
  if (!dock) return;
  persist();
  render();
  focusSelected(dock);
}

export function toggleSurfaceMaximize(panel: SurfacePanel = state.focused): void {
  if (usePhonePresentation()) return;
  toggleMaximizedPanel(state, getSurfaceDock(state, panel));
  persist();
  render();
  focusSelected(panel);
}

export function mountSurfacePanelToggles(host: HTMLElement): void {
  for (const panel of ['bottom', 'side'] as const) {
    const label = panel === 'side' ? 'Side panel' : 'Bottom panel';
    let button = panelToggles.get(panel);
    if (!button) {
      button = control(label, 'inspectorPanel', () => toggleSurfacePanel(panel));
      button.id = panel === 'side' ? 'btnSurfaceSide' : 'btnSurfaceBottom';
      button.classList.toggle('graphite-surface-icon--bottom', panel === 'bottom');
      button.setAttribute('aria-controls', panel === 'side' ? 'surfaceSide' : 'surfaceBottom');
      button.setAttribute('aria-pressed', 'false');
      if (panel === 'side') {
        const apple = /Mac|iPhone|iPad/.test(navigator.platform);
        button.title = `Side panel (${apple ? '⌘' : 'Ctrl+'}J)`;
      }
      panelToggles.set(panel, button);
    }
    if (button.parentElement !== host) host.append(button);
  }
  if (stage) renderPlacement();
}

function bindResize(panel: SurfaceDock, node: HTMLElement): void {
  const horizontal = panel === 'bottom';
  const coordinate = (event: PointerEvent) => horizontal ? event.clientY : event.clientX;
  let drag: {
    pointerId: number;
    origin: number;
    originSize: number;
    thread: ThreadSurfaceState;
  } | undefined;
  const frame = createPointerFrame(position => {
    if (!drag) return;
    dragSizes[panel] = drag.originSize + drag.origin - position;
    applySizes();
    schedulePreviewLayout();
  });
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    drag = {
      pointerId: event.pointerId,
      origin: coordinate(event),
      originSize: dockSize(panel, sizes[panel]),
      thread: state,
    };
    node.setPointerCapture(event.pointerId);
    node.classList.add('is-dragging');
    event.preventDefault();
  });
  node.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.pointerId) frame.schedule(coordinate(event));
  });
  function finish(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { originSize, origin, thread } = drag;
    drag = undefined;
    frame.flush();
    delete dragSizes[panel];
    node.classList.remove('is-dragging');
    const size = originSize + origin - coordinate(event);
    if (event.type !== 'pointerup' || size === originSize ||
      thread !== state || node.hidden || !isPanelVisible(state, panel)) {
      applySizes();
      schedulePreviewLayout();
      return;
    }
    if (!horizontal && size >= availableSize(panel) + SIDE_MAXIMIZE_OVERSHOOT) {
      toggleSurfaceMaximize(panel);
      return;
    }
    updateSize(panel, size);
  }
  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
  node.addEventListener('lostpointercapture', finish);
  node.addEventListener('dblclick', () => updateSize(panel, PANEL_SIZES[panel].default));
  node.addEventListener('keydown', event => {
    const available = availableSize(panel);
    const current = dockSize(panel, sizes[panel], available);
    const step = event.shiftKey ? 48 : 16;
    const grow = horizontal ? 'ArrowUp' : 'ArrowLeft';
    const shrink = horizontal ? 'ArrowDown' : 'ArrowRight';
    const value = ({
      [grow]: current + step, [shrink]: current - step, Home: PANEL_SIZES[panel].min,
      End: Math.min(PANEL_SIZES[panel].max, available), Enter: PANEL_SIZES[panel].default,
    })[event.key];
    if (value === undefined) return;
    event.preventDefault();
    updateSize(panel, value);
  });
}

function applySplitRatio(ratio: number): void {
  stage?.style.setProperty('--mn-graphite-split-ratio', String(ratio));
  mounted.get('split')?.resizer.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

function bindSplitResize(node: HTMLElement): void {
  const min = surfaceSplitRatio(0);
  const max = surfaceSplitRatio(1);
  node.setAttribute('aria-valuemin', String(min * 100));
  node.setAttribute('aria-valuemax', String(max * 100));
  let drag: { pointerId: number; x: number; width: number; ratio: number; thread: ThreadSurfaceState; dock: SurfaceDock } | undefined;
  const ratioAt = (x: number) => drag ? surfaceSplitRatio(drag.ratio + (x - drag.x) / drag.width) : state.split.ratio;
  const canResize = () => drag?.thread === state && drag.dock === state.split.dock && isPanelVisible(state, 'split');
  const frame = createPointerFrame(x => {
    if (!canResize()) return;
    applySplitRatio(ratioAt(x));
    schedulePreviewLayout();
  });
  const commit = (ratio: number) => {
    state.split.ratio = surfaceSplitRatio(ratio);
    applySplitRatio(state.split.ratio);
    persist();
    schedulePreviewLayout();
  };
  node.addEventListener('pointerdown', event => {
    const dock = state.split.dock;
    const width = dock && mounted.get(dock)?.root.clientWidth;
    if (event.button !== 0 || drag || !dock || !width) return;
    drag = { pointerId: event.pointerId, x: event.clientX, width, ratio: state.split.ratio, thread: state, dock };
    node.setPointerCapture(event.pointerId);
    node.classList.add('is-dragging');
    event.preventDefault();
  });
  node.addEventListener('pointermove', event => {
    if (event.pointerId === drag?.pointerId) frame.schedule(event.clientX);
  });
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== drag?.pointerId) return;
    const ratio = event.type === 'pointerup' && canResize() ? ratioAt(event.clientX) : undefined;
    drag = undefined;
    frame.flush();
    node.classList.remove('is-dragging');
    if (ratio !== undefined) commit(ratio);
    else {
      applySplitRatio(state.split.ratio);
      schedulePreviewLayout();
    }
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) node.addEventListener(type, finish);
  node.addEventListener('dblclick', () => commit(0.5));
  node.addEventListener('keydown', event => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const ratio = {
      ArrowLeft: state.split.ratio - step, ArrowRight: state.split.ratio + step, Home: min, End: max, Enter: 0.5,
    }[event.key];
    if (ratio === undefined) return;
    event.preventDefault();
    commit(ratio);
  });
}

function bindPanelKeys(panel: SurfacePanel, strip: HTMLElement): void {
  strip.addEventListener('keydown', event => {
    const chat = getContextChat();
    if (!chat || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    const tabs = tabsForPanel(panel, chat);
    const active = state[panel].active;
    const at = active === 'launch' ? -1 : tabs.indexOf(active);
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && tabs.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      setActiveTab(panel, tabs[at < 0 ? (step > 0 ? 0 : tabs.length - 1) : (at + step + tabs.length) % tabs.length]);
    } else if ((event.key === 'Delete' || event.key === 'Backspace' ||
      (event.key.toLowerCase() === 'w' && (event.metaKey || event.ctrlKey))) && active !== 'launch') {
      event.preventDefault();
      void closeTab(panel, active);
    }
  });
}

function bindContentTabDrop(panel: SurfacePanel, header: HTMLElement): void {
  header.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes(CONTENT_TAB_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  header.addEventListener('drop', event => {
    const id = event.dataTransfer?.getData(CONTENT_TAB_MIME);
    if (!contentTab(id) || !state.open.includes(id as ContentTabId)) return;
    event.preventDefault();
    endTabDrag();
    const tab = id as ContentTabId;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.graphite-surface-tab-wrap') : null;
    const before = target?.dataset.surfaceTab;
    openSurfaceTab(state, tab, panel);
    if (target && isSurfaceId(before) && before !== tab && state.open.includes(before)) {
      state.open.splice(state.open.indexOf(tab), 1);
      const insert = state.open.indexOf(before);
      const rect = target.getBoundingClientRect();
      state.open.splice(insert + Number(event.clientX > rect.left + rect.width / 2), 0, tab);
    }
    persist();
    render();
    focusSelected(panel);
  });
}

function bindLauncherKeys(panel: SurfacePanel, launcher: HTMLElement): void {
  launcher.addEventListener('keydown', event => {
    const options = Array.from(launcher.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLElement);
    const next = ({
      ArrowDown: (current + 1) % options.length,
      ArrowUp: current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length,
      Home: 0, End: options.length - 1,
    })[event.key];
    if (next !== undefined) {
      event.preventDefault();
      options[next].focus();
    } else if (event.key === 'Escape' && !usePhonePresentation()) {
      event.preventDefault();
      const chat = getContextChat();
      const previous = chat ? tabsForPanel(panel, chat).at(-1) : undefined;
      if (previous) setActiveTab(panel, previous);
      else toggleSurfacePanel(panel);
    }
  });
}

function createPanel(panel: SurfacePanel): PanelElements {
  const name = panelName(panel);
  const root = element('aside', `graphite-surface-panel graphite-surface-panel--${panel}`);
  root.id = { side: 'surfaceSide', bottom: 'surfaceBottom', split: 'surfaceSplit' }[panel];
  root.dataset.surfacePanel = panel;
  root.setAttribute('aria-label', name);
  root.hidden = true;
  const resizer = element('div', 'graphite-surface-resizer');
  resizer.tabIndex = 0;
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-label', panel === 'split' ? 'Resize split' : `Resize ${name.toLowerCase()}`);
  resizer.setAttribute('aria-orientation', panel === 'bottom' ? 'horizontal' : 'vertical');
  const head = element('header', 'graphite-surface-header');
  const title = element('h2', 'graphite-surface-sheet-title');
  title.textContent = 'Diff';
  title.hidden = true;
  const strip = element('div', 'graphite-surface-tabs');
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', name);
  const add = control('Open a surface here', 'plus', () => setActiveTab(panel, 'launch'));
  const controls = element('div', 'graphite-surface-controls');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', `${name} controls`);
  head.append(title, strip, add, controls);
  const body = element('div', 'graphite-surface-body');
  const launcher = element('div', 'graphite-surface-launcher');
  launcher.setAttribute('role', 'menu');
  launcher.setAttribute('aria-label', 'Open a surface');
  launcher.tabIndex = -1;
  const contentLimit = element('p', 'graphite-surface-content-limit');
  contentLimit.setAttribute('role', 'status');
  contentLimit.textContent = 'Select this tab to bring it into view. Up to two files or two browser tabs can be visible at once.';
  contentLimit.hidden = true;
  body.append(launcher, contentLimit);
  root.append(resizer, head, body);
  const focus = (event: Event) => {
    if ((event.target as Element | null)?.closest?.('[data-surface-panel]') !== root) return;
    if (state.focused === panel) return;
    state.focused = panel;
    if (content) refreshSurfacePanels();
  };
  root.addEventListener('focusin', focus);
  root.addEventListener('pointerdown', focus);
  bindPanelKeys(panel, strip);
  bindContentTabDrop(panel, head);
  bindLauncherKeys(panel, launcher);
  if (panel === 'split') bindSplitResize(resizer);
  else bindResize(panel, resizer);
  return { root, title, strip, add, controls, body, launcher, contentLimit, resizer, signature: '' };
}

function handleLegacyRequest(id: LauncherSurfaceId, action: 'show' | 'hide' | 'toggle' | 'maximize'): boolean {
  const chat = getContextChat();
  if (!chat) return false;
  syncChat(chat);
  syncViewport();
  const matches = (tab: SurfaceTab) => tab === id ||
    (id === 'preview' && contentTab(tab)?.kind === 'preview');
  const shownPanel = [state.focused, ...SURFACE_PANELS].find(panel => matches(state[panel].active) &&
    (usePhonePresentation() ? mobileShown === panel : isPanelVisible(state, panel)));
  const panel = shownPanel ?? getSurfacePanel(state, id);
  const shown = shownPanel !== undefined;
  if (action === 'show' && shown) return true;
  if (action === 'show' || (action === 'toggle' && !shown)) return openSurface(id, { force: true });
  if (action === 'maximize') {
    if (!shown && !openSurface(id, { force: true })) return false;
    toggleSurfaceMaximize(panel);
  } else if (shown) toggleSurfacePanel(panel);
  return true;
}

function onShortcut(event: KeyboardEvent): void {
  const host = mobilePortal?.host ?? stage;
  if (event.defaultPrevented || event.isComposing || !host?.getClientRects().length || isBoardsStageOpen()) return;
  const foreground = document.querySelector('.mn-os-app-layer.is-active');
  if (foreground && !mobilePortal && !foreground.contains(host)) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const key = event.key.toLowerCase();
  const panel = target?.closest<HTMLElement>('[data-surface-panel]')?.dataset.surfacePanel as SurfacePanel | undefined;
  if (event.key === 'Escape' && usePhonePresentation() && mobileShown) {
    event.preventDefault();
    toggleSurfacePanel(mobileShown);
  } else if (event.key === 'Tab' && usePhonePresentation() && mobileShown) {
    const root = mounted.get(mobileShown)?.root;
    const focusable = Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]') ?? [])
      .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (root && first && last && (!target || !root.contains(target) ||
      (event.shiftKey ? target === first : target === last))) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'j') {
    event.preventDefault();
    toggleSurfacePanel('side');
  } else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat && key === '\\' && panel) {
    event.preventDefault();
    splitSurfacePanel(panel);
  } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
    !target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, .cm-editor')) {
    const panel = usePhonePresentation() ? mobileShown ?? undefined : launcherPanelForKey(state);
    const item = SURFACES.find(surface => surface.key.toLowerCase() === key);
    if (panel && item && state[panel].active === 'launch') {
      event.preventDefault();
      if (openSurface(item.id, { panel }) && !(content && item.id === 'preview')) focusSelected(panel);
    }
  }
}

/** Move the live panel roots into the dedicated paired-phone thread, whose Code app is parked. */
export function mountMobileSurfacePortal(host: HTMLElement, chatId?: string): () => void {
  if (!stage) return () => {};
  const current = { host, chatId };
  mobilePortal = current;
  host.classList.add('graphite-mobile-surfaces');
  moveSurfaceNode(mobileBackdrop, host);
  for (const panel of SURFACE_DOCKS) moveSurfaceNode(mounted.get(panel)!.root, host);
  refreshSurfacePanels();
  return () => {
    if (mobilePortal !== current || !stage) return;
    host.classList.remove('graphite-mobile-surfaces');
    mobileShown = null;
    mobileReturnFocus = null;
    mobilePortal = undefined;
    moveSurfaceNode(mobileBackdrop, stage);
    for (const panel of SURFACE_DOCKS) moveSurfaceNode(mounted.get(panel)!.root, stage);
    refreshSurfacePanels();
  };
}

export function mountSurfacePanels(host: HTMLElement, options: {
  legacyOpen?: readonly SurfaceId[];
  content?: SurfaceContent;
} = {}): void {
  if (stage === host) return;
  if (stage) return;
  stage = host;
  content = options.content;
  legacySurfaces = options.legacyOpen ?? [];
  stage.classList.add('graphite-surfaces');
  mobileBackdrop = element('button', 'graphite-surface-backdrop');
  mobileBackdrop.type = 'button';
  mobileBackdrop.setAttribute('aria-label', 'Close surface');
  mobileBackdrop.hidden = true;
  mobileBackdrop.addEventListener('click', () => { if (mobileShown) toggleSurfacePanel(mobileShown); });
  host.append(mobileBackdrop);
  for (const panel of SURFACE_PANELS) {
    const view = createPanel(panel);
    mounted.set(panel, view);
    host.append(view.root);
  }
  const saved = read(SIZE_KEY) as Partial<Record<SurfaceDock, number>> | undefined;
  sizes = { side: surfaceSize('side', saved?.side), bottom: surfaceSize('bottom', saved?.bottom) };
  setGraphiteSurfaceBridge({
    request: handleLegacyRequest,
    refresh: refreshSurfacePanels,
    showContent: content ? (kind, key, forceLoad, into) => {
      const chat = getContextChat();
      if (!chat) return;
      syncChat(chat);
      syncViewport();
      const id: ContentTabId = `${kind}:${key}`;
      if (!content?.describe(id)) return;
      const panel = (into === 'split' && !state.split.dock ? undefined : into)
        ?? (state.open.includes(id) ? getSurfacePanel(state, id) : state.focused);
      openSurfaceTab(state, id, panel);
      openMobile(panel);
      persist();
      render();
      return content.ready(id, forceLoad);
    } : undefined,
    splitPanel: splitSurfacePanel,
    previewSlot: content?.previewSlot,
    cycleContent: direction => {
      const chat = getContextChat();
      const panel = state.focused;
      if (!chat || !contentTab(state[panel].active)) return false;
      const tabs = tabsForPanel(panel, chat);
      const index = tabs.indexOf(state[panel].active as SurfaceId);
      if (tabs.length > 1) setActiveTab(panel, tabs[(index + (direction === 'next' ? 1 : -1) + tabs.length) % tabs.length]);
      return true;
    },
  });
  document.addEventListener('keydown', onShortcut);
  window.addEventListener('hashchange', refreshSurfacePanels);
  window.addEventListener('minnow:managed-chat-change', refreshSurfacePanels);
  window.addEventListener('storage', event => {
    if (event.key === SIZE_KEY) {
      const saved = read(SIZE_KEY) as Partial<Record<SurfaceDock, number>> | undefined;
      sizes = { side: surfaceSize('side', saved?.side), bottom: surfaceSize('bottom', saved?.bottom) };
      applySizes();
      schedulePreviewLayout();
      return;
    }
    if (event.key !== activeKey) return;
    if (desktopState) desktopState = normalizeSurfaceState(read(activeKey));
    else state = normalizeSurfaceState(read(activeKey));
    refreshSurfacePanels();
  });
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      applySizes();
      schedulePreviewLayout();
    }).observe(host);
  }
  onPhoneLayoutChange(() => { mobileShown = null; refreshSurfacePanels(); });
  // The visible phone sheet is painted over the Code surface. Desktop panels
  // take their own space in the grid and never occlude an adjacent preview.
  const syncOcclusion = () => {
    for (const view of mounted.values()) {
      if (usePhonePresentation() && !view.root.hidden) markPreviewOccluder(view.root, 'panel');
      else unmarkPreviewOccluder(view.root);
    }
  };
  const observer = new MutationObserver(syncOcclusion);
  for (const view of mounted.values()) observer.observe(view.root, { attributes: true, attributeFilter: ['hidden'] });
  render();
}
