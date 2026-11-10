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
  SURFACES, SURFACE_GROUPS, type ContentTabPlacement, type SurfaceAvailability, type SurfaceContent,
  type SurfaceContext, type SurfaceRegistration,
} from './surface-registry';
import {
  activateSurfaceTab, closeSurfaceTab, contentTab, getPanelTabs, getSurfacePanel, isPanelVisible, isSurfaceId,
  launcherPanelForKey, normalizeSurfaceState, openSurfaceTab, PANEL_SIZES, setPanelShown,
  surfaceSize, toggleMaximizedPanel, type ContentTabId, type LauncherSurfaceId,
  type SurfaceId, type SurfacePanel, type SurfaceTab, type ThreadSurfaceState,
} from './surface-state';

export type { SurfaceId, SurfacePanel } from './surface-state';
export type { SurfaceContext, SurfaceRegistration } from './surface-registry';

const PANELS = ['side', 'bottom'] as const;
const PREFIX = 'minnow.graphite.surfaces.v1';
const SIZE_KEY = `${PREFIX}.sizes`;
const CONTENT_TAB_MIME = 'application/x-minnow-surface-tab';

interface PanelElements {
  root: HTMLElement;
  title: HTMLElement;
  strip: HTMLElement;
  add: HTMLButtonElement;
  controls: HTMLElement;
  body: HTMLElement;
  launcher: HTMLElement;
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
let mobileShown: SurfacePanel | null = null;
let mobileReturnFocus: HTMLElement | null = null;
let mobileBackdrop: HTMLButtonElement;
let mobilePortal: { host: HTMLElement; chatId?: string } | undefined;
let legacySurfaces: readonly SurfaceId[] = [];
let legacyMigrated = false;
let sizes: Record<SurfacePanel, number> = { side: PANEL_SIZES.side.default, bottom: PANEL_SIZES.bottom.default };
const mounted = new Map<SurfacePanel, PanelElements>();
const registrations = new Map<SurfaceId, SurfaceRegistration>();
const visible = new Map<SurfaceId, ActiveSurface>();
const wrappers = new Map<SurfaceId, HTMLElement>();
const targets = new Map<SurfaceId, unknown>();
const panelToggles = new Map<SurfacePanel, HTMLButtonElement>();

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

function isAlternateThreadViewOpen(): boolean {
  return Boolean(stage?.classList.contains('graphite-archive-open') ||
    stage?.querySelector('#mainColumn:is(.graphite-archive-open, .graphite-new-thread)'));
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
      getChatMessageCount(chat) > 0 && !usePhonePresentation() && !isAlternateThreadViewOpen()) {
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

function switchPanel(panel: SurfacePanel): SurfacePanel {
  return panel === 'side' ? 'bottom' : 'side';
}

function syncViewport(): void {
  if (usePhonePresentation() && !desktopState) {
    desktopState = state;
    state = normalizeSurfaceState(state);
  } else if (!usePhonePresentation() && desktopState) {
    state = desktopState;
    desktopState = undefined;
  }
}

function renderPlacement(): void {
  if (!stage) return;
  const isPhone = usePhonePresentation();
  const alternateView = isAlternateThreadViewOpen();
  const side = !alternateView && (isPhone ? mobileShown === 'side' : isPanelVisible(state, 'side'));
  const bottom = !alternateView && (isPhone ? mobileShown === 'bottom' : isPanelVisible(state, 'bottom'));
  stage.dataset.surfaceSide = String(side);
  stage.dataset.surfaceBottom = String(bottom);
  stage.dataset.surfaceMax = isPhone || alternateView ? '' : state.maximized ?? '';
  stage.classList.toggle('graphite-surfaces--phone', isPhone);
  mobileBackdrop.hidden = !(isPhone && (side || bottom));
  document.getElementById('mainColumn')?.toggleAttribute('inert', isPhone && (side || bottom));
  for (const panel of PANELS) {
    const open = panel === 'side' ? side : bottom;
    const root = mounted.get(panel)?.root;
    root?.toggleAttribute('hidden', !open);
    if (isPhone && open) {
      root?.setAttribute('role', 'dialog');
      root?.setAttribute('aria-modal', 'true');
    } else {
      root?.removeAttribute('role');
      root?.removeAttribute('aria-modal');
    }
    panelToggles.get(panel)?.setAttribute('aria-pressed', String(open));
  }
  applySizes();
}

function updateSize(panel: SurfacePanel, value: number, save: boolean): void {
  sizes[panel] = surfaceSize(panel, value, availableSize(panel));
  if (save) write(SIZE_KEY, sizes);
  applySizes();
  schedulePreviewLayout();
}

function availableSize(panel: SurfacePanel): number {
  const dimension = panel === 'side' ? stage?.clientWidth : stage?.clientHeight;
  if (!dimension) return Infinity;
  return dimension - (panel === 'side' ? 240 : 180);
}

function applySizes(): void {
  for (const panel of PANELS) {
    const available = availableSize(panel);
    const applied = surfaceSize(panel, sizes[panel], available);
    const resizer = mounted.get(panel)?.resizer;
    stage?.style.setProperty(`--mn-graphite-${panel}-size`, `${applied}px`);
    resizer?.setAttribute('aria-valuemin', String(surfaceSize(panel, PANEL_SIZES[panel].min, available)));
    resizer?.setAttribute('aria-valuemax', String(surfaceSize(panel, PANEL_SIZES[panel].max, available)));
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
  const target = panelToggles.get(panel);
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
  const includeHeading = panel === 'side' || state.maximized === panel || usePhonePresentation();
  const options = SURFACE_GROUPS.map(group => group.map(item => ({
    item, availability: getAvailability(item.id, context(chat, item.id, panel)),
  })));
  const signature = JSON.stringify([includeHeading, options.map(group => group.map(({ availability }) => availability))]);
  if (view.launcher.dataset.signature !== signature) {
    view.launcher.dataset.signature = signature;
    const heading = element('span', 'graphite-surface-launcher-title');
    heading.textContent = 'Open a surface';
    heading.hidden = !includeHeading;
    view.launcher.replaceChildren(heading);
    for (const group of options) {
      const list = element('div', 'graphite-surface-launcher-group');
      list.setAttribute('role', 'group');
      for (const { item, availability } of group) {
        const button = element('button', 'graphite-surface-choice');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-disabled', String(!availability.available));
        button.title = availability.reason ?? '';
        if (availability.reason) button.setAttribute('aria-description', availability.reason);
        const label = element('span', 'graphite-surface-choice-label');
        label.textContent = item.label;
        const hint = element('span', 'graphite-surface-choice-hint');
        hint.textContent = availability.available ? availability.hint ?? '' : '';
        const key = element('kbd', 'graphite-surface-key');
        key.textContent = item.key;
        button.append(createIcon(item.icon, { size: 14 }), label, hint, key);
        button.addEventListener('click', () => {
          if (openSurface(item.id, { panel }) && !(content && item.id === 'preview')) focusSelected(panel);
        });
        list.append(button);
      }
      view.launcher.append(list);
    }
  }
}

function surfaceDomKey(id: SurfaceId): string {
  return encodeURIComponent(id);
}

function renderPanelChrome(panel: SurfacePanel, view: PanelElements, chat: Chat): void {
  const tabs = tabsForPanel(panel, chat);
  const active = state[panel].active;
  const launcher = active === 'launch' || !tabs.includes(active);
  const maximized = state.maximized === panel;
  const isPhone = usePhonePresentation();
  const phoneChanges = isPhone && active === 'changes' && !launcher;
  const name = panel === 'side' ? 'Side panel' : 'Bottom panel';
  view.root.classList.toggle('graphite-surface-panel--changes-sheet', phoneChanges);
  view.root.setAttribute('aria-label', phoneChanges ? 'Changes' : name);
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
  const signature = JSON.stringify([tabs, active, maximized, isPhone, Array.from(counts),
    labels.map(label => label && [label.label, label.title, label.dirty, label.loading])]);
  if (view.signature !== signature) {
    view.signature = signature;
    const focusId = view.strip.contains(document.activeElement) ? document.activeElement?.id : undefined;
    view.strip.replaceChildren();
    let activeWrap: HTMLElement | undefined;
    for (const [index, id] of tabs.entries()) {
      const item = SURFACES.find(surface => surface.id === id);
      const details = labels[index];
      const label = details?.label ?? item?.label ?? (id === 'review' ? 'Review' : id);
      const tabWrap = element('span', 'graphite-surface-tab-wrap');
      tabWrap.dataset.surfaceTab = id;
      const tab = element('button', 'graphite-surface-tab');
      tab.type = 'button';
      tab.id = `graphiteTab-${panel}-${surfaceDomKey(id)}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `graphitePanel-${surfaceDomKey(id)}`);
      tab.setAttribute('aria-selected', String(selected(id, panel)));
      tab.tabIndex = selected(id, panel) || (launcher && id === tabs[0]) ? 0 : -1;
      tab.title = details?.title ?? (item ? `${label} (${item.key})` : label);
      const name = element('span', 'graphite-surface-tab-label');
      name.textContent = label;
      tab.append(details?.icon() ?? createIcon(item?.icon ?? (id === 'review' ? 'gitGraph' : 'fileText'), { size: 14 }), name);
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
            label: panel === 'side' ? 'Move to bottom panel' : 'Move to side panel',
            onSelect: () => moveTab(panel, id),
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
      const move = control(panel === 'side' ? 'Move to bottom panel' : 'Move to side panel',
        'inspectorPanel', () => moveActiveSurface(panel));
      move.classList.toggle('graphite-surface-icon--bottom', panel === 'side');
      view.controls.append(move);
    }
    if (!isPhone) {
      const maximize = control(maximized ? 'Restore' : 'Maximize', maximized ? 'restore' : 'expand',
        () => toggleSurfaceMaximize(panel));
      maximize.setAttribute('aria-pressed', String(maximized));
      view.controls.append(maximize);
    }
    view.controls.append(control(phoneChanges ? 'Close Changes' : panel === 'side' ? 'Hide side panel' : 'Hide bottom panel',
      'close', () => toggleSurfacePanel(panel)));
    if (activeWrap) {
      const strip = view.strip.getBoundingClientRect();
      const tab = activeWrap.getBoundingClientRect();
      if (tab.left < strip.left) view.strip.scrollLeft -= strip.left - tab.left;
      else if (tab.right > strip.right) view.strip.scrollLeft += tab.right - strip.right;
    }
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }
  view.resizer.hidden = maximized || isPhone;
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
  for (const panel of PANELS) {
    const view = mounted.get(panel)!;
    if (view.root.hidden) continue;
    renderPanelChrome(panel, view, chat);
    const id = state[panel].active;
    if (id === 'launch') continue;
    const ctx = context(chat, id, panel);
    if (contentTab(id)) workbench.push({ id: id as ContentTabId, ...ctx });
    if (registrations.has(id) || contentTab(id)) next.set(id, { view, context: ctx });
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

function render(): void {
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
    renderPlacement();
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
  for (const panel of PANELS) {
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
  mobileShown = panel;
}

export function openSurface(id: LauncherSurfaceId, options: OpenSurfaceOptions = {}): boolean {
  if (!stage || isAlternateThreadViewOpen()) return false;
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
  if (!stage || isAlternateThreadViewOpen()) return;
  const chat = getContextChat();
  if (!chat) return;
  syncChat(chat);
  syncViewport();
  if (usePhonePresentation()) {
    if (mobileShown === panel) {
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
  const wasVisible = isPanelVisible(state, panel);
  setPanelShown(state, panel, !wasVisible);
  if (!wasVisible && state.maximized !== panel) state.maximized = null;
  persist();
  render();
  if (!wasVisible) focusSelected(panel);
  else focusPanelOpener(panel);
}

export function moveActiveSurface(panel: SurfacePanel = state.focused): void {
  const id = state[panel].active;
  if (id !== 'launch') moveTab(panel, id);
}

function moveTab(panel: SurfacePanel, id: SurfaceId): void {
  const destination = switchPanel(panel);
  openSurfaceTab(state, id, destination);
  persist();
  render();
  focusSelected(destination);
}

export function toggleSurfaceMaximize(panel: SurfacePanel = state.focused): void {
  if (usePhonePresentation()) return;
  toggleMaximizedPanel(state, panel);
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

function bindResize(panel: SurfacePanel, node: HTMLElement): void {
  const horizontal = panel === 'bottom';
  const coordinate = (event: PointerEvent) => horizontal ? event.clientY : event.clientX;
  let origin = 0;
  let originSize = 0;
  let pointer: number | null = null;
  const frame = createPointerFrame(position => updateSize(panel, originSize + origin - position, false));
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || pointer !== null) return;
    pointer = event.pointerId;
    origin = coordinate(event);
    originSize = surfaceSize(panel, sizes[panel], availableSize(panel));
    node.setPointerCapture(pointer);
    node.classList.add('is-dragging');
    event.preventDefault();
  });
  node.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) frame.schedule(coordinate(event));
  });
  function finish(): void {
    if (pointer === null) return;
    frame.flush();
    pointer = null;
    node.classList.remove('is-dragging');
    write(SIZE_KEY, sizes);
  }
  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
  node.addEventListener('lostpointercapture', finish);
  node.addEventListener('dblclick', () => updateSize(panel, PANEL_SIZES[panel].default, true));
  node.addEventListener('keydown', event => {
    const current = surfaceSize(panel, sizes[panel], availableSize(panel));
    const step = event.shiftKey ? 48 : 16;
    const grow = horizontal ? 'ArrowUp' : 'ArrowLeft';
    const shrink = horizontal ? 'ArrowDown' : 'ArrowRight';
    const value = ({
      [grow]: current + step, [shrink]: current - step, Home: PANEL_SIZES[panel].min,
      End: PANEL_SIZES[panel].max, Enter: PANEL_SIZES[panel].default,
    })[event.key];
    if (value === undefined) return;
    event.preventDefault();
    updateSize(panel, value, true);
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
  const name = panel === 'side' ? 'Side panel' : 'Bottom panel';
  const root = element('aside', `graphite-surface-panel graphite-surface-panel--${panel}`);
  root.id = panel === 'side' ? 'surfaceSide' : 'surfaceBottom';
  root.setAttribute('aria-label', name);
  root.hidden = true;
  const resizer = element('div', 'graphite-surface-resizer');
  resizer.tabIndex = 0;
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-label', `Resize ${name.toLowerCase()}`);
  resizer.setAttribute('aria-orientation', panel === 'side' ? 'vertical' : 'horizontal');
  const head = element('header', 'graphite-surface-header');
  const title = element('h2', 'graphite-surface-sheet-title');
  title.textContent = 'Changes';
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
  body.append(launcher);
  root.append(resizer, head, body);
  const focus = () => {
    if (state.focused === panel) return;
    state.focused = panel;
    if (content) refreshSurfacePanels();
  };
  root.addEventListener('focusin', focus);
  root.addEventListener('pointerdown', focus);
  bindPanelKeys(panel, strip);
  bindContentTabDrop(panel, head);
  bindLauncherKeys(panel, launcher);
  bindResize(panel, resizer);
  return { root, title, strip, add, controls, body, launcher, resizer, signature: '' };
}

function handleLegacyRequest(id: LauncherSurfaceId, action: 'show' | 'hide' | 'toggle' | 'maximize'): boolean {
  if (isAlternateThreadViewOpen()) return true;
  const chat = getContextChat();
  if (!chat) return false;
  syncChat(chat);
  syncViewport();
  const matches = (tab: SurfaceTab) => tab === id ||
    (id === 'preview' && contentTab(tab)?.kind === 'preview');
  const panel = [state.focused, switchPanel(state.focused)].find(panel => matches(state[panel].active))
    ?? getSurfacePanel(state, id);
  const shown = (usePhonePresentation() ? mobileShown === panel : isPanelVisible(state, panel)) && matches(state[panel].active);
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
  if (event.defaultPrevented || event.isComposing || isAlternateThreadViewOpen() || !host?.getClientRects().length) return;
  const foreground = document.querySelector('.mn-os-app-layer.is-active');
  if (foreground && !mobilePortal && !foreground.contains(host)) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const key = event.key.toLowerCase();
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
  for (const view of mounted.values()) moveSurfaceNode(view.root, host);
  refreshSurfacePanels();
  return () => {
    if (mobilePortal !== current || !stage) return;
    host.classList.remove('graphite-mobile-surfaces');
    mobileShown = null;
    mobileReturnFocus = null;
    mobilePortal = undefined;
    moveSurfaceNode(mobileBackdrop, stage);
    for (const view of mounted.values()) moveSurfaceNode(view.root, stage);
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
  for (const panel of PANELS) {
    const view = createPanel(panel);
    mounted.set(panel, view);
    host.append(view.root);
  }
  const saved = read(SIZE_KEY) as Partial<Record<SurfacePanel, number>> | undefined;
  sizes = { side: surfaceSize('side', saved?.side), bottom: surfaceSize('bottom', saved?.bottom) };
  setGraphiteSurfaceBridge({
    request: handleLegacyRequest,
    refresh: refreshSurfacePanels,
    showContent: content ? (kind, key, forceLoad, into) => {
      const chat = getContextChat();
      if (!chat || isAlternateThreadViewOpen()) return;
      syncChat(chat);
      syncViewport();
      const id: ContentTabId = `${kind}:${key}`;
      if (!content?.describe(id)) return;
      const panel = into ?? (state.open.includes(id) ? getSurfacePanel(state, id) : state.focused);
      openSurfaceTab(state, id, panel);
      openMobile(panel);
      persist();
      render();
      return content.ready(id, forceLoad);
    } : undefined,
    moveContent: () => {
      if (usePhonePresentation() || !contentTab(state[state.focused].active)) return false;
      moveActiveSurface();
      return true;
    },
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
      const saved = read(SIZE_KEY) as Partial<Record<SurfacePanel, number>> | undefined;
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
  const mainColumn = host.querySelector('#mainColumn');
  if (mainColumn) {
    let alternateView = isAlternateThreadViewOpen();
    new MutationObserver(() => {
      const next = isAlternateThreadViewOpen();
      if (next === alternateView) return;
      alternateView = next;
      refreshSurfacePanels();
    }).observe(mainColumn, { attributes: true, attributeFilter: ['class'] });
  }
  render();
}
