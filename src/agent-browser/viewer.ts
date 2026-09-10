import '../styles/agent-browser-viewer.css';
import { iconHtml } from '../ui/icon';
import { MINNOW_GLYPH_HEADER_HTML } from '../ui/minnow-glyph';
import { markAppReady, markChromeReady } from '../boot/app-ready';
import { initRenderIdleTracking } from '../boot/render-idle';
import { withSessionToken } from '../api/session-token';

const API_ROOT = '/api/browser-agent';
const FRAME_INTERVAL_MS = 500;
const TAB_REFRESH_INTERVAL_MS = 3_000;

export type AgentBrowserMode = 'watch' | 'guide' | 'control';

export interface AgentBrowserViewport {
  width: number;
  height: number;
}

export interface AgentBrowserTab {
  tabId?: string;
  id?: string;
  title?: string;
  url?: string;
  status?: string;
  activity?: string;
  owner?: string | { label?: string; name?: string; kind?: string } | null;
  controlMode?: AgentBrowserMode;
  viewport?: Partial<AgentBrowserViewport>;
}

interface TabsResponse {
  tabs?: AgentBrowserTab[];
  error?: string;
  browser?: { available?: boolean; error?: string };
  available?: boolean;
}

interface AgentBrowserTarget {
  targetId: string;
  label?: string;
  status?: string;
}

interface ViewerState {
  tabs: AgentBrowserTab[];
  targets: AgentBrowserTarget[];
  activeTabId: string | null;
  mode: AgentBrowserMode;
  visible: boolean;
  unavailableMessage: string | null;
  errorMessage: string | null;
  noticeMessage: string | null;
  frameUrl: string | null;
  viewport: AgentBrowserViewport;
  selectedGuide: {
    point: { x: number; y: number };
    selectionToken: string;
    owner?: string;
    documentRevision?: string | number;
    element?: string;
  } | null;
  frameRevision: string | null;
}

const state: ViewerState = {
  tabs: [],
  targets: [],
  activeTabId: null,
  mode: 'watch',
  visible: true,
  unavailableMessage: null,
  errorMessage: null,
  noticeMessage: null,
  frameUrl: null,
  viewport: { width: 1440, height: 900 },
  selectedGuide: null,
  frameRevision: null,
};

let frameTimer: ReturnType<typeof setTimeout> | null = null;
let tabsTimer: ReturnType<typeof setTimeout> | null = null;
let frameLoading = false;
let tabsLoading = false;
let eventSource: EventSource | null = null;
let stopIdleTracking: (() => void) | null = null;
let frameAbort: AbortController | null = null;
let frameGeneration = 0;
let nextFrameAt = 0;
let stageResizeObserver: ResizeObserver | null = null;
let guideFrameFrozen = false;

function tabId(tab: AgentBrowserTab | null | undefined): string {
  return typeof tab?.tabId === 'string' ? tab.tabId : typeof tab?.id === 'string' ? tab.id : '';
}

function tabStructure(tabs: AgentBrowserTab[]): string {
  return tabs.map((tab) => tabId(tab)).join('\u0000');
}

function targetsEqual(a: AgentBrowserTarget[], b: AgentBrowserTarget[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function activeTab(): AgentBrowserTab | null {
  return state.tabs.find((tab) => tabId(tab) === state.activeTabId) ?? null;
}

function ownerLabel(owner: AgentBrowserTab['owner']): string {
  if (!owner) return 'Unassigned';
  if (typeof owner === 'string') return owner;
  return owner.label || owner.name || owner.kind || 'Assigned agent';
}

function modeLabel(mode: AgentBrowserMode): string {
  return mode === 'control' ? 'Take control' : mode[0]!.toUpperCase() + mode.slice(1);
}

function isVisibleForFrames(): boolean {
  return state.visible && document.visibilityState !== 'hidden' && Boolean(state.activeTabId);
}

/** Map a point inside a scaled frame to the headless tab's actual CSS viewport. */
export function mapViewerPointToViewport(
  clientX: number,
  clientY: number,
  frame: DOMRect,
  viewport: AgentBrowserViewport,
): { x: number; y: number } | null {
  if (frame.width <= 0 || frame.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const relativeX = clientX - frame.left;
  const relativeY = clientY - frame.top;
  if (relativeX < 0 || relativeY < 0 || relativeX >= frame.width || relativeY >= frame.height) return null;
  return {
    x: Math.min(viewport.width - 1, Math.round((relativeX / frame.width) * viewport.width)),
    y: Math.min(viewport.height - 1, Math.round((relativeY / frame.height) * viewport.height)),
  };
}

/** Frames are expensive captures, so hidden/minimised windows must request none. */
export function shouldPollAgentBrowserFrames(visible: boolean, tabIdValue: string | null): boolean {
  return visible && Boolean(tabIdValue);
}

function apiUrl(path = ''): string {
  return `${API_ROOT}${path}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: 'no-store', ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Agent Browser request failed (HTTP ${response.status})`);
  return body;
}

function clearFrameUrl(): void {
  if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
  state.frameUrl = null;
  state.frameRevision = null;
}

function invalidateFrame(): void {
  frameGeneration += 1;
  frameAbort?.abort();
  frameAbort = null;
  frameLoading = false;
  clearFrameUrl();
  const image = document.querySelector<HTMLImageElement>('[data-agent-browser-frame]');
  if (image) image.remove();
}

/** A tab-scoped frame/Guide message must never leak into another tab's empty state. */
function clearActiveTabStatus(): boolean {
  const hadStatus = Boolean(state.errorMessage || state.noticeMessage);
  state.errorMessage = null;
  state.noticeMessage = null;
  return hadStatus;
}

function stopFramePolling(): void {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
}

function scheduleFramePolling(delay = 0): void {
  stopFramePolling();
  if (guideFrameFrozen) return;
  if (!shouldPollAgentBrowserFrames(isVisibleForFrames(), state.activeTabId)) return;
  frameTimer = setTimeout(() => void refreshFrame(), Math.max(delay, nextFrameAt - Date.now()));
}

function scheduleTabsRefresh(delay = TAB_REFRESH_INTERVAL_MS): void {
  if (tabsTimer) clearTimeout(tabsTimer);
  if (!state.visible) return;
  tabsTimer = setTimeout(() => void refreshTabs(), delay);
}

async function refreshTabs(): Promise<void> {
  if (tabsLoading || !state.visible) return;
  tabsLoading = true;
  let needsRender = false;
  let needsModePatch = false;
  try {
    const payload = await requestJson<TabsResponse>('/tabs');
    if (payload.available === false || payload.browser?.available === false) {
      const message = payload.browser?.error || payload.error || 'No supported browser was found.';
      needsRender = state.unavailableMessage !== message || state.tabs.length > 0 || clearActiveTabStatus();
      state.unavailableMessage = message;
      state.tabs = [];
      state.activeTabId = null;
      invalidateFrame();
    } else {
      const priorStructure = tabStructure(state.tabs);
      const priorActiveTabId = state.activeTabId;
      const priorMode = state.mode;
      state.unavailableMessage = null;
      state.tabs = Array.isArray(payload.tabs) ? payload.tabs : [];
      if (!state.tabs.some((tab) => tabId(tab) === state.activeTabId)) {
        state.activeTabId = tabId(state.tabs[0]);
        state.selectedGuide = null;
        clearActiveTabStatus();
        invalidateFrame();
      }
      const tab = activeTab();
      state.mode = tab?.controlMode ?? state.mode;
      if (state.mode !== 'guide') guideFrameFrozen = false;
      needsRender = priorStructure !== tabStructure(state.tabs) || priorActiveTabId !== state.activeTabId;
      needsModePatch = priorMode !== state.mode;
      if (state.selectedGuide?.owner && tab && ownerLabel(tab.owner) !== state.selectedGuide.owner) {
        state.selectedGuide = null;
        state.noticeMessage = 'Guide selection cleared because this tab was reassigned.';
        needsRender = true;
      }
      if (tab?.viewport?.width && tab?.viewport?.height) {
        state.viewport = { width: tab.viewport.width, height: tab.viewport.height };
      }
    }
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    tabsLoading = false;
    if (needsRender) render();
    else {
      patchTabMetadata();
      if (needsModePatch) updateModeSurface();
    }
    void refreshTargets();
    scheduleFramePolling();
    scheduleTabsRefresh();
  }
}

async function refreshTargets(): Promise<void> {
  try {
    const payload = await requestJson<{ targets?: AgentBrowserTarget[] }>('/targets');
    const next = Array.isArray(payload.targets) ? payload.targets : [];
    if (!targetsEqual(state.targets, next)) {
      state.targets = next;
      patchTargetOptions();
    }
  } catch {
    // A target picker is an enhancement. Existing tabs still remain operable
    // when no assignment candidates are currently available.
    state.targets = [];
  }
}

async function refreshFrame(): Promise<void> {
  if (frameLoading || !shouldPollAgentBrowserFrames(isVisibleForFrames(), state.activeTabId)) return;
  const id = state.activeTabId;
  if (!id) return;
  const generation = frameGeneration;
  const controller = new AbortController();
  frameAbort?.abort();
  frameAbort = controller;
  frameLoading = true;
  nextFrameAt = Date.now() + FRAME_INTERVAL_MS;
  try {
    const response = await fetch(apiUrl(`/tabs/${encodeURIComponent(id)}/frame`), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Live frame unavailable (HTTP ${response.status})`);
    const width = Number(response.headers.get('X-Minnow-Agent-Browser-Viewport-Width'));
    const height = Number(response.headers.get('X-Minnow-Agent-Browser-Viewport-Height'));
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      state.viewport = { width, height };
    }
    const revision = response.headers.get('X-Minnow-Agent-Browser-Frame-Revision');
    const nextUrl = URL.createObjectURL(await response.blob());
    if (generation !== frameGeneration || id !== state.activeTabId || controller.signal.aborted) {
      URL.revokeObjectURL(nextUrl);
      return;
    }
    clearFrameUrl();
    state.frameUrl = nextUrl;
    state.frameRevision = revision;
  } catch (error) {
    if (!controller.signal.aborted && generation === frameGeneration && id === state.activeTabId) {
      state.errorMessage = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (frameAbort === controller) frameAbort = null;
    if (generation === frameGeneration) frameLoading = false;
    updateFrameSurface();
    scheduleFramePolling(FRAME_INTERVAL_MS);
  }
}

async function setMode(mode: AgentBrowserMode): Promise<void> {
  const id = state.activeTabId;
  if (!id) return;
  await requestJson(`/tabs/${encodeURIComponent(id)}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  state.mode = mode;
  state.selectedGuide = null;
  guideFrameFrozen = false;
  updateModeSurface();
  scheduleFramePolling();
}

async function sendOperator(path: string, payload?: unknown, targetTabId = state.activeTabId): Promise<void> {
  const id = targetTabId;
  if (!id) return;
  await requestJson(`/tabs/${encodeURIComponent(id)}${path}`, {
    method: 'POST',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  scheduleFramePolling();
}

async function sendGuide(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-agent-browser-guide-message]');
  const message = input?.value.trim() ?? '';
  const selection = state.selectedGuide;
  if (!message || !selection) return;
  try {
    const outcome = await requestJson<{ outcome?: string; owner?: string }>(
      `/tabs/${encodeURIComponent(state.activeTabId ?? '')}/guide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          selectionToken: selection.selectionToken,
          owner: selection.owner,
          documentRevision: selection.documentRevision,
        }),
      },
    );
    state.noticeMessage = outcome.owner
      ? `Guide note ${outcome.outcome ?? 'delivered'} to ${outcome.owner}.`
      : `Guide note ${outcome.outcome ?? 'delivered'}.`;
    state.selectedGuide = null;
    guideFrameFrozen = false;
    if (input) input.value = '';
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
  }
  render();
  scheduleFramePolling();
}

async function selectGuidePoint(point: { x: number; y: number }): Promise<void> {
  const id = state.activeTabId;
  if (!id || state.mode !== 'guide') return;
  // The service validates this exact displayed revision. Stop a newer capture
  // from invalidating it between the pointer selection and request dispatch.
  guideFrameFrozen = true;
  stopFramePolling();
  frameAbort?.abort();
  try {
    const selection = await requestJson<{
      selectionToken?: string;
      owner?: string;
      documentRevision?: string | number;
      element?: string;
    }>(`/tabs/${encodeURIComponent(id)}/guide/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ point, frameRevision: state.frameRevision, viewport: state.viewport }),
    });
    if (!selection.selectionToken || id !== state.activeTabId) return;
    state.selectedGuide = { point, ...selection, selectionToken: selection.selectionToken };
    state.noticeMessage = selection.element ? `Selected ${selection.element}.` : 'Selected page element.';
    render();
  } catch (error) {
    guideFrameFrozen = false;
    state.errorMessage = error instanceof Error ? error.message : String(error);
    render();
    scheduleFramePolling();
  }
}

async function reassign(): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('[data-agent-browser-target]');
  const target = select?.value ?? '';
  try {
    if (!target) await sendOperator('/unassign');
    else await sendOperator('/reassign', { targetId: target });
    await refreshTabs();
  } catch (error) {
    state.errorMessage = error instanceof Error ? error.message : String(error);
    render();
  }
}

function sendControlInput(payload: Record<string, unknown>): void {
  if (state.mode !== 'control') return;
  void sendOperator('/input', payload).catch((error) => {
    state.errorMessage = error instanceof Error ? error.message : String(error);
    render();
  });
}

function controlModifiers(event: KeyboardEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function windowsVirtualKeyCode(event: KeyboardEvent): number {
  if (event.key.length === 1) return event.key.toUpperCase().charCodeAt(0);
  const keyCodes: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32,
    PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Insert: 45, Delete: 46,
  };
  return keyCodes[event.key] ?? 0;
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusedSelector = focused?.matches('[data-agent-browser-address]')
    ? '[data-agent-browser-address]'
    : focused?.matches('[data-agent-browser-guide-message]')
      ? '[data-agent-browser-guide-message]'
      : null;
  const priorAddress = root.querySelector<HTMLInputElement>('[data-agent-browser-address]');
  const addressDraft = priorAddress?.value;
  const addressDraftTabId = priorAddress?.dataset.agentBrowserAddressTab;
  const guideDraft = root.querySelector<HTMLInputElement>('[data-agent-browser-guide-message]')?.value;
  const targetDraft = root.querySelector<HTMLSelectElement>('[data-agent-browser-target]')?.value;
  const tab = activeTab();
  const point = state.selectedGuide?.point;
  const pointStyle = point
    ? `left:${(point.x / state.viewport.width) * 100}%;top:${(point.y / state.viewport.height) * 100}%;`
    : '';
  const tabs = state.tabs.map((entry) => {
    const id = tabId(entry);
    const active = id === state.activeTabId ? ' is-active' : '';
    return `<div class="agent-browser-tab${active}">
      <button class="agent-browser-tab__select" type="button" data-agent-browser-tab="${escapeHtml(id)}">
      <span class="agent-browser-tab__title" data-agent-browser-tab-title>${escapeHtml(entry.title || entry.url || 'Untitled tab')}</span>
      <span class="agent-browser-tab__meta" data-agent-browser-tab-meta>${escapeHtml(ownerLabel(entry.owner))} · ${escapeHtml(entry.activity || entry.status || 'Idle')}</span>
      </button>
      <button class="agent-browser-tab__close" type="button" data-agent-browser-close="${escapeHtml(id)}" aria-label="Close ${escapeAttribute(entry.title || 'tab')}">${iconHtml('close', { size: 12 })}</button>
    </div>`;
  }).join('');
  const empty = state.unavailableMessage
    ? `<section class="agent-browser-empty"><h2>Agent Browser is unavailable</h2><p>${escapeHtml(state.unavailableMessage)}</p><p>Install Chrome, Edge, or Chromium, then set its path in Settings → Tools → Browser. Minnow does not download a browser automatically.</p></section>`
    : state.tabs.length === 0
      ? `<section class="agent-browser-empty"><span class="agent-browser-empty__icon">${iconHtml('globe', { size: 32 })}</span><h2>No agent tabs</h2><p>Ask an agent to browse a page. Its tabs will appear here.</p></section>`
      : `<div class="agent-browser-canvas" data-agent-browser-canvas tabindex="0" aria-label="Live agent browser page">
          ${state.frameUrl ? `<img data-agent-browser-frame draggable="false" src="${state.frameUrl}" alt="Live page for ${escapeHtml(tab?.title || tab?.url || 'agent tab')}" />` : '<p class="agent-browser-canvas__loading">Waiting for live page…</p>'}
          ${point ? `<span class="agent-browser-target" style="${pointStyle}" aria-hidden="true"></span>` : ''}
        </div>`;
  root.innerHTML = `<main class="agent-browser-viewer${state.tabs.length ? '' : ' is-empty'}">
    <header class="agent-browser-titlebar">
      <div class="agent-browser-titlebar__name"><span class="logo-mark">${MINNOW_GLYPH_HEADER_HTML}</span><span>Agent Browser</span><span class="agent-browser-titlebar__status">${state.tabs.length} tab${state.tabs.length === 1 ? '' : 's'}</span></div>
      <div class="agent-browser-titlebar__actions">
        <button type="button" data-agent-browser-clear ${state.tabs.length ? '' : 'disabled'}>Clear tabs</button>
        <button class="mn-os-window-btn" type="button" data-agent-browser-window="minimize" aria-label="Minimize">${iconHtml('windowMinimize')}</button>
        <button class="mn-os-window-btn" type="button" data-agent-browser-window="maximize" aria-label="Maximize">${iconHtml('windowMaximize')}</button>
        <button class="mn-os-window-btn" type="button" data-agent-browser-window="close" aria-label="Close Agent Browser">${iconHtml('windowClose')}</button>
      </div>
    </header>
    <section class="agent-browser-tabs" aria-label="Agent tabs">${tabs}</section>
    <section class="agent-browser-toolbar">
      <div class="agent-browser-nav">
        <button type="button" data-agent-browser-nav="back" ${state.mode === 'control' && tab ? '' : 'disabled'} aria-label="Back">${iconHtml('chevronLeft', { size: 16 })}</button>
        <button type="button" data-agent-browser-nav="forward" ${state.mode === 'control' && tab ? '' : 'disabled'} aria-label="Forward">${iconHtml('chevronRight', { size: 16 })}</button>
        <button type="button" data-agent-browser-nav="reload" ${state.mode === 'control' && tab ? '' : 'disabled'} aria-label="Reload">${iconHtml('refresh', { size: 16 })}</button>
        <input data-agent-browser-address data-agent-browser-address-tab="${escapeAttribute(tabId(tab))}" data-agent-browser-address-url="${escapeAttribute(tab?.url || '')}" value="${escapeAttribute(tab?.url || '')}" ${state.mode === 'control' && tab ? '' : 'disabled'} aria-label="Page address" />
      </div>
      <div class="agent-browser-modes" role="group" aria-label="Agent tab control mode">
        ${(['watch', 'guide', 'control'] as AgentBrowserMode[]).map((mode) => `<button type="button" data-agent-browser-mode="${mode}" class="${state.mode === mode ? 'is-active' : ''}" aria-pressed="${state.mode === mode ? 'true' : 'false'}" ${tab ? '' : 'disabled'}>${modeLabel(mode)}</button>`).join('')}
      </div>
    </section>
    <section class="agent-browser-workspace">
      <aside class="agent-browser-details" ${state.tabs.length ? '' : 'hidden'}>
        <p class="agent-browser-details__label">Owner</p><p data-agent-browser-owner>${escapeHtml(ownerLabel(tab?.owner))}</p>
        <p class="agent-browser-details__label">Activity</p><p data-agent-browser-activity>${escapeHtml(tab?.activity || tab?.status || 'Waiting')}</p>
        <p class="agent-browser-details__label">Viewport</p><p data-agent-browser-viewport>${state.viewport.width} × ${state.viewport.height}</p>
        <div class="agent-browser-details__actions">
          <select data-agent-browser-target ${tab ? '' : 'disabled'} aria-label="Assign tab to agent"><option value="">Unassigned</option>${state.targets.map((target) => `<option value="${escapeAttribute(target.targetId)}">${escapeHtml(target.label || target.targetId)}${target.status ? ` · ${escapeHtml(target.status)}` : ''}</option>`).join('')}</select>
          <button type="button" data-agent-browser-reassign ${tab ? '' : 'disabled'}>Assign</button>
          <button type="button" data-agent-browser-close-tab ${tab ? '' : 'disabled'}>Close tab</button>
        </div>
        ${state.mode === 'guide' && tab ? `<div class="agent-browser-guide"><label for="agentBrowserGuide">Guide note</label><input id="agentBrowserGuide" data-agent-browser-guide-message placeholder="Select a page element, then add context" /><button type="button" data-agent-browser-send-guide ${point ? '' : 'disabled'}>Send to owner</button></div>` : ''}
      </aside>
      <section class="agent-browser-stage">${empty}</section>
    </section>
    ${state.errorMessage ? `<p class="agent-browser-notice agent-browser-notice--error" role="status">${escapeHtml(state.errorMessage)}</p>` : ''}
    ${state.noticeMessage ? `<p class="agent-browser-notice" role="status">${escapeHtml(state.noticeMessage)}</p>` : ''}
  </main>`;
  const address = root.querySelector<HTMLInputElement>('[data-agent-browser-address]');
  if (addressDraft != null && address && addressDraftTabId === tabId(tab)) address.value = addressDraft;
  const guide = root.querySelector<HTMLInputElement>('[data-agent-browser-guide-message]');
  if (guideDraft != null && guide) guide.value = guideDraft;
  const target = root.querySelector<HTMLSelectElement>('[data-agent-browser-target]');
  if (targetDraft != null && target) target.value = targetDraft;
  bindControls(root);
  observeFrameStage(root);
  if (focusedSelector) root.querySelector<HTMLElement>(focusedSelector)?.focus();
}

/** Patch tab labels and details without invalidating active controls or canvas input. */
function patchTabMetadata(): void {
  const root = document.getElementById('app');
  const tab = activeTab();
  if (!root || !tab) return;
  root.querySelectorAll<HTMLElement>('[data-agent-browser-tab]').forEach((button) => {
    const entry = state.tabs.find((candidate) => tabId(candidate) === button.dataset.agentBrowserTab);
    if (!entry) return;
    const title = entry.title || entry.url || 'Untitled tab';
    const titleNode = button.querySelector<HTMLElement>('[data-agent-browser-tab-title]');
    const metaNode = button.querySelector<HTMLElement>('[data-agent-browser-tab-meta]');
    if (titleNode) titleNode.textContent = title;
    if (metaNode) metaNode.textContent = `${ownerLabel(entry.owner)} · ${entry.activity || entry.status || 'Idle'}`;
  });
  const owner = root.querySelector<HTMLElement>('[data-agent-browser-owner]');
  const activity = root.querySelector<HTMLElement>('[data-agent-browser-activity]');
  const viewport = root.querySelector<HTMLElement>('[data-agent-browser-viewport]');
  if (owner) owner.textContent = ownerLabel(tab.owner);
  if (activity) activity.textContent = tab.activity || tab.status || 'Waiting';
  if (viewport) viewport.textContent = `${state.viewport.width} × ${state.viewport.height}`;
  const address = root.querySelector<HTMLInputElement>('[data-agent-browser-address]');
  if (address) {
    const previousUrl = address.dataset.agentBrowserAddressUrl ?? '';
    if (address.value === previousUrl) address.value = tab.url ?? '';
    address.dataset.agentBrowserAddressUrl = tab.url ?? '';
  }
}

function patchTargetOptions(): void {
  const select = document.querySelector<HTMLSelectElement>('[data-agent-browser-target]');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren(new Option('Unassigned', ''));
  for (const target of state.targets) {
    select.add(new Option(`${target.label || target.targetId}${target.status ? ` · ${target.status}` : ''}`, target.targetId));
  }
  select.value = selected;
}

/** Update stable mode controls in place. Guide adds its note field, other modes do not rebuild. */
function updateModeSurface(): void {
  const root = document.getElementById('app');
  const tab = activeTab();
  if (!root) return;
  const hasGuideEditor = Boolean(root.querySelector('[data-agent-browser-guide-message]'));
  if ((state.mode === 'guide') !== hasGuideEditor) {
    render();
    return;
  }
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-mode]').forEach((button) => {
    const active = button.dataset.agentBrowserMode === state.mode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const controlEnabled = state.mode === 'control' && Boolean(tab);
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-nav]').forEach((button) => {
    button.disabled = !controlEnabled;
  });
  const address = root.querySelector<HTMLInputElement>('[data-agent-browser-address]');
  if (address) address.disabled = !controlEnabled;
}

/** Swap only the live image. Frame polling must never rebuild operator controls. */
function updateFrameSurface(): void {
  const canvas = document.querySelector<HTMLElement>('[data-agent-browser-canvas]');
  if (!canvas) return;
  let image = canvas.querySelector<HTMLImageElement>('[data-agent-browser-frame]');
  if (!state.frameUrl) {
    image?.remove();
    return;
  }
  if (!image) {
    canvas.querySelector('.agent-browser-canvas__loading')?.remove();
    image = document.createElement('img');
    image.dataset.agentBrowserFrame = '';
    image.draggable = false;
    image.alt = `Live page for ${activeTab()?.title || activeTab()?.url || 'agent tab'}`;
    canvas.prepend(image);
  }
  image.src = state.frameUrl;
  fitFrameSurface(canvas);
}

/** Fit the full captured viewport inside the available stage without cropping. */
export function fitAgentBrowserFrame(
  stage: { width: number; height: number },
  viewport: AgentBrowserViewport,
  padding: { horizontal: number; vertical: number } = { horizontal: 0, vertical: 0 },
): { width: number; height: number } | null {
  const availableWidth = stage.width - padding.horizontal;
  const availableHeight = stage.height - padding.vertical;
  if (availableWidth <= 0 || availableHeight <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const scale = Math.min(availableWidth / viewport.width, availableHeight / viewport.height);
  return { width: Math.max(1, Math.floor(viewport.width * scale)), height: Math.max(1, Math.floor(viewport.height * scale)) };
}

function fitFrameSurface(canvas: HTMLElement): void {
  const stage = canvas.closest<HTMLElement>('.agent-browser-stage');
  if (!stage) return;
  const style = window.getComputedStyle(stage);
  const size = fitAgentBrowserFrame(stage.getBoundingClientRect(), state.viewport, {
    horizontal: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight),
    vertical: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
  });
  if (!size) return;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
}

function observeFrameStage(root: HTMLElement): void {
  stageResizeObserver?.disconnect();
  stageResizeObserver = null;
  const stage = root.querySelector<HTMLElement>('.agent-browser-stage');
  const canvas = root.querySelector<HTMLElement>('[data-agent-browser-canvas]');
  if (!stage || !canvas) return;
  fitFrameSurface(canvas);
  if (typeof ResizeObserver !== 'function') return;
  stageResizeObserver = new ResizeObserver(() => fitFrameSurface(canvas));
  stageResizeObserver.observe(stage);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function bindControls(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-agent-browser-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.agentBrowserTab;
      if (!id) return;
      state.activeTabId = id;
      state.selectedGuide = null;
      state.noticeMessage = null;
      invalidateFrame();
      state.mode = activeTab()?.controlMode ?? 'watch';
      render();
      scheduleFramePolling();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.agentBrowserClose;
      if (id) void sendOperator('/close', undefined, id).then(refreshTabs).catch(showError);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-mode]').forEach((button) => {
    button.addEventListener('click', () => void setMode(button.dataset.agentBrowserMode as AgentBrowserMode).catch(showError));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-nav]').forEach((button) => {
    button.addEventListener('click', () => void sendOperator(`/${button.dataset.agentBrowserNav}`).catch(showError));
  });
  root.querySelector<HTMLInputElement>('[data-agent-browser-address]')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const url = (event.currentTarget as HTMLInputElement).value.trim();
    if (url) void sendOperator('/navigate', { url }).catch(showError);
  });
  root.querySelector<HTMLButtonElement>('[data-agent-browser-reassign]')?.addEventListener('click', () => void reassign());
  root.querySelector<HTMLButtonElement>('[data-agent-browser-close-tab]')?.addEventListener('click', () => void sendOperator('/close').then(refreshTabs).catch(showError));
  root.querySelector<HTMLButtonElement>('[data-agent-browser-clear]')?.addEventListener('click', () => void requestJson('/clear', { method: 'POST' }).then(refreshTabs).catch(showError));
  root.querySelector<HTMLButtonElement>('[data-agent-browser-send-guide]')?.addEventListener('click', () => void sendGuide());
  root.querySelectorAll<HTMLButtonElement>('[data-agent-browser-window]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.agentBrowserWindow;
      if (action === 'minimize') void window.minnow?.window?.minimize();
      if (action === 'maximize') void window.minnow?.window?.maximize();
      if (action === 'close') void window.minnow?.window?.close();
    });
  });
  const canvas = root.querySelector<HTMLElement>('[data-agent-browser-canvas]');
  if (!canvas) return;
  canvas.addEventListener('click', (event) => {
    const image = canvas.querySelector<HTMLImageElement>('[data-agent-browser-frame]');
    const point = image
      ? mapViewerPointToViewport(event.clientX, event.clientY, image.getBoundingClientRect(), state.viewport)
      : null;
    if (!point) return;
    if (state.mode === 'guide') {
      void selectGuidePoint(point);
      return;
    }
    sendControlInput({ type: 'pointer', phase: 'click', ...point, button: event.button });
  });
  canvas.addEventListener('pointerdown', () => {
    if (state.mode === 'control') canvas.focus();
  });
  canvas.addEventListener('wheel', (event) => {
    if (state.mode !== 'control') return;
    const image = canvas.querySelector<HTMLImageElement>('[data-agent-browser-frame]');
    const point = image
      ? mapViewerPointToViewport(event.clientX, event.clientY, image.getBoundingClientRect(), state.viewport)
      : null;
    if (!point) return;
    event.preventDefault();
    sendControlInput({ type: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY });
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    if (state.mode !== 'control') return;
    event.preventDefault();
    const modifiers = controlModifiers(event);
    sendControlInput({
      type: 'key',
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: windowsVirtualKeyCode(event),
      modifiers,
      text: event.key.length === 1 && modifiers === 0 ? event.key : undefined,
    });
  });
  canvas.addEventListener('beforeinput', (event) => {
    if (state.mode !== 'control' || !event.data) return;
    event.preventDefault();
    sendControlInput({ type: 'text', text: event.data });
  });
  canvas.addEventListener('paste', (event) => {
    if (state.mode !== 'control') return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    event.preventDefault();
    sendControlInput({ type: 'text', text });
  });
  canvas.addEventListener('compositionend', (event) => {
    if (state.mode !== 'control' || !event.data) return;
    sendControlInput({ type: 'text', text: event.data });
  });
}

function showError(error: unknown): void {
  state.errorMessage = error instanceof Error ? error.message : String(error);
  render();
}

function openEvents(): void {
  eventSource?.close();
  if (!state.visible) return;
  eventSource = new EventSource(withSessionToken(apiUrl('/events')));
  eventSource.onmessage = () => void refreshTabs();
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
  };
}

function updateVisibility(visible: boolean): void {
  state.visible = visible;
  if (!visible) {
    stopFramePolling();
    invalidateFrame();
    if (tabsTimer) clearTimeout(tabsTimer);
    tabsTimer = null;
    eventSource?.close();
    eventSource = null;
    return;
  }
  openEvents();
  void refreshTabs();
}

/** Minimal, session-free renderer for the dedicated Agent Browser window. */
export async function initAgentBrowserViewer(): Promise<void> {
  document.documentElement.dataset.agentBrowserViewer = 'true';
  const platform = window.minnow?.app?.platform;
  if (platform) document.documentElement.dataset.platform = platform;
  // The shared index contains the shell scaffold, not a generic app mount.
  // A viewer owns its document body and never initializes that shell.
  mountAgentBrowserViewerRoot();
  stopIdleTracking = initRenderIdleTracking();
  // The shared loader is intentionally removed with the shell scaffold above.
  // Reveal the new root immediately instead of waiting for the shell's dual gate.
  markAppReady();
  markChromeReady();
  render();
  const fromDocument = () => updateVisibility(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', fromDocument);
  window.minnow?.window?.onVisibilityChanged?.(updateVisibility);
  window.addEventListener('beforeunload', () => {
    stopFramePolling();
    if (tabsTimer) clearTimeout(tabsTimer);
    eventSource?.close();
    stageResizeObserver?.disconnect();
    stageResizeObserver = null;
    clearFrameUrl();
    stopIdleTracking?.();
  }, { once: true });
  updateVisibility(document.visibilityState !== 'hidden');
}

/** Mount the minimal viewer against Minnow's shared shell document. */
export function mountAgentBrowserViewerRoot(doc: Document = document): HTMLElement {
  const root = doc.createElement('div');
  root.id = 'app';
  doc.body.replaceChildren(root);
  return root;
}

/** Test-only cleanup for the singleton renderer module. */
export function resetAgentBrowserViewerForTests(): void {
  stopFramePolling();
  if (tabsTimer) clearTimeout(tabsTimer);
  tabsTimer = null;
  frameAbort?.abort();
  frameAbort = null;
  guideFrameFrozen = false;
  eventSource?.close();
  eventSource = null;
  stageResizeObserver?.disconnect();
  stageResizeObserver = null;
  clearFrameUrl();
  Object.assign(state, {
    tabs: [],
    targets: [],
    activeTabId: null,
    mode: 'watch',
    visible: true,
    unavailableMessage: null,
    errorMessage: null,
    noticeMessage: null,
    frameUrl: null,
    viewport: { width: 1440, height: 900 },
    selectedGuide: null,
    frameRevision: null,
  } satisfies ViewerState);
}
