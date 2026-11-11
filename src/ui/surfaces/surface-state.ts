export const SURFACE_IDS = [
  'changes', 'terminal', 'files', 'preview', 'agents', 'pr', 'issue', 'side', 'review', 'issues',
] as const;
export type LauncherSurfaceId = (typeof SURFACE_IDS)[number];
export type ContentTabKind = 'file' | 'preview';
export type ContentTabId = `${ContentTabKind}:${string}`;
export type SurfaceId = LauncherSurfaceId | ContentTabId;
export const SURFACE_DOCKS = ['side', 'bottom'] as const;
export const SURFACE_PANELS = [...SURFACE_DOCKS, 'split'] as const;
export type SurfaceDock = (typeof SURFACE_DOCKS)[number];
export type SurfacePanel = (typeof SURFACE_PANELS)[number];
export type SurfaceTab = SurfaceId | 'launch';

export interface PanelState {
  shown: boolean;
  active: SurfaceTab;
}

export interface ThreadSurfaceState {
  open: SurfaceId[];
  panelOf: Partial<Record<SurfaceId, SurfacePanel>>;
  side: PanelState;
  bottom: PanelState;
  split: { dock: SurfaceDock | null; active: SurfaceTab; ratio: number };
  maximized: SurfaceDock | null;
  focused: SurfacePanel;
}

export const PANEL_SIZES = {
  side: { min: 340, max: Infinity, default: 440 },
  bottom: { min: 160, max: 560, default: 320 },
} satisfies Record<SurfaceDock, { min: number; max: number; default: number }>;

export function isSurfaceId(value: unknown): value is SurfaceId {
  return SURFACE_IDS.includes(value as LauncherSurfaceId) || contentTab(value) !== undefined;
}

export function contentTab(value: unknown): { kind: ContentTabKind; key: string } | undefined {
  if (typeof value !== 'string') return;
  const index = value.indexOf(':');
  const kind = value.slice(0, index);
  if (index >= 0 && index < value.length - 1 && (kind === 'file' || kind === 'preview')) {
    return { kind, key: value.slice(index + 1) };
  }
}

function isDock(value: unknown): value is SurfaceDock {
  return value === 'side' || value === 'bottom';
}

export function getSurfaceDock(state: ThreadSurfaceState, panel: SurfacePanel): SurfaceDock {
  return panel === 'split' ? state.split.dock ?? 'side' : panel;
}

export function surfaceSplitRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0.25, Math.min(0.75, value)) : 0.5;
}

export function getSurfacePanel(state: ThreadSurfaceState, id: SurfaceId): SurfacePanel {
  return state.panelOf[id] ?? (id === 'terminal' ? 'bottom' : 'side');
}

export function getPanelTabs(state: ThreadSurfaceState, panel: SurfacePanel): SurfaceId[] {
  return state.open.filter(id => getSurfacePanel(state, id) === panel);
}

export function isPanelVisible(state: ThreadSurfaceState, panel: SurfacePanel): boolean {
  if (panel === 'split') return state.split.dock !== null && isPanelVisible(state, state.split.dock);
  return state[panel].shown && (!state.maximized || state.maximized === panel);
}

function normalizePanel(value: Partial<PanelState> | null | undefined): PanelState {
  return {
    shown: value?.shown === true,
    active: isSurfaceId(value?.active) ? value.active : 'launch',
  };
}

export function normalizeSurfaceState(value?: unknown): ThreadSurfaceState {
  const raw = value && typeof value === 'object' ? value as Partial<ThreadSurfaceState> : {};
  const dock = isDock(raw.split?.dock) ? raw.split.dock : null;
  const focused = raw.focused;
  const state: ThreadSurfaceState = {
    open: Array.isArray(raw.open) ? [...new Set(raw.open.filter(isSurfaceId))] : [],
    panelOf: {},
    side: normalizePanel(raw.side),
    bottom: normalizePanel(raw.bottom),
    split: { dock, active: normalizePanel(raw.split).active, ratio: surfaceSplitRatio(raw.split?.ratio) },
    maximized: null,
    focused: isDock(focused) || (focused === 'split' && dock) ? focused : 'side',
  };
  for (const id of [...SURFACE_IDS, ...state.open]) {
    const panel = raw.panelOf?.[id];
    if (isDock(panel) || (panel === 'split' && dock)) state.panelOf[id] = panel;
  }
  for (const panel of SURFACE_PANELS) {
    const tabs = getPanelTabs(state, panel);
    const savedTab: unknown = raw[panel]?.active;
    if (savedTab === 'brain' || savedTab === 'phone') {
      state[panel].active = tabs.at(-1) ?? 'launch';
      if (!tabs.length && panel !== 'split') state[panel].shown = false;
    } else if (state[panel].active !== 'launch' && !tabs.includes(state[panel].active)) {
      state[panel].active = tabs.at(-1) ?? 'launch';
    }
  }
  if (isDock(raw.maximized) && state[raw.maximized].shown) state.maximized = raw.maximized;
  return state;
}

export function setPanelShown(state: ThreadSurfaceState, panel: SurfaceDock, shown: boolean): void {
  state[panel].shown = shown;
  if (shown) state.focused = panel;
  if (!shown && state.maximized === panel) state.maximized = null;
}

export function activateSurfaceTab(state: ThreadSurfaceState, panel: SurfacePanel, id: SurfaceTab): void {
  state[panel].active = id;
  const dock = getSurfaceDock(state, panel);
  setPanelShown(state, dock, true);
  state.focused = panel;
  if (state.maximized !== dock) state.maximized = null;
}

function removeTabFromPanel(state: ThreadSurfaceState, panel: SurfacePanel, id: SurfaceId, tabs: SurfaceId[]): void {
  if (state[panel].active !== id) return;
  const index = tabs.indexOf(id);
  state[panel].active = tabs[index + 1] ?? tabs[index - 1] ?? 'launch';
}

export function openSurfaceTab(state: ThreadSurfaceState, id: SurfaceId, into?: SurfacePanel): void {
  const current = getSurfacePanel(state, id);
  const panel = into ?? current;
  if (!state.open.includes(id)) {
    state.open.push(id);
  } else if (current !== panel) {
    const tabs = getPanelTabs(state, current);
    removeTabFromPanel(state, current, id, tabs);
    if (tabs.length === 1 && current !== 'split' && current !== state.split.dock) setPanelShown(state, current, false);
  }
  state.panelOf[id] = panel;
  activateSurfaceTab(state, panel, id);
}

export function closeSurfaceTab(state: ThreadSurfaceState, id: SurfaceId): void {
  if (!state.open.includes(id)) return;
  const panel = getSurfacePanel(state, id);
  removeTabFromPanel(state, panel, id, getPanelTabs(state, panel));
  state.open = state.open.filter(open => open !== id);
  if (contentTab(id)) delete state.panelOf[id];
}

export function toggleMaximizedPanel(state: ThreadSurfaceState, panel: SurfaceDock): void {
  if (state[panel].shown) state.maximized = state.maximized === panel ? null : panel;
}

export function launcherPanelForKey(state: ThreadSurfaceState): SurfacePanel | undefined {
  const panels = SURFACE_PANELS.filter(panel =>
    isPanelVisible(state, panel) && state[panel].active === 'launch');
  return panels.includes(state.focused) ? state.focused : panels[0];
}

export function splitSurfaceTabs(state: ThreadSurfaceState, dock: SurfaceDock, tab: SurfaceTab): void {
  state.split.dock = dock;
  if (tab !== 'launch' && getPanelTabs(state, dock).length > 1) openSurfaceTab(state, tab, 'split');
  else activateSurfaceTab(state, 'split', 'launch');
}

export function mergeSurfaceTabs(state: ThreadSurfaceState): SurfaceDock | undefined {
  const dock = state.split.dock;
  if (!dock) return;
  for (const id of getPanelTabs(state, 'split')) state.panelOf[id] = dock;
  if ((state.focused === 'split' || state[dock].active === 'launch') && state.split.active !== 'launch') {
    state[dock].active = state.split.active;
  }
  if (state.focused === 'split') state.focused = dock;
  state.split = { dock: null, active: 'launch', ratio: state.split.ratio };
  return dock;
}

export function surfaceSize(panel: SurfaceDock, size: unknown, available = Infinity): number {
  const limits = PANEL_SIZES[panel];
  const max = Math.min(limits.max, Math.max(0, available));
  const min = Math.min(limits.min, max);
  return Math.max(min, Math.min(max, typeof size === 'number' && Number.isFinite(size) ? Math.round(size) : limits.default));
}
