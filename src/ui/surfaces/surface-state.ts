export const SURFACE_IDS = [
  'changes', 'terminal', 'files', 'preview', 'agents', 'pr', 'issue', 'side', 'review',
] as const;
export type LauncherSurfaceId = (typeof SURFACE_IDS)[number];
export type ContentTabKind = 'file' | 'preview';
export type ContentTabId = `${ContentTabKind}:${string}`;
export type SurfaceId = LauncherSurfaceId | ContentTabId;
export type SurfacePanel = 'side' | 'bottom';
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
  maximized: SurfacePanel | null;
  focused: SurfacePanel;
}

export const PANEL_SIZES = {
  side: { min: 340, max: 720, default: 440 },
  bottom: { min: 160, max: 560, default: 320 },
} satisfies Record<SurfacePanel, { min: number; max: number; default: number }>;

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

function isPanel(value: unknown): value is SurfacePanel {
  return value === 'side' || value === 'bottom';
}

export function getSurfacePanel(state: ThreadSurfaceState, id: SurfaceId): SurfacePanel {
  return state.panelOf[id] ?? (id === 'terminal' ? 'bottom' : 'side');
}

export function getPanelTabs(state: ThreadSurfaceState, panel: SurfacePanel): SurfaceId[] {
  return state.open.filter(id => getSurfacePanel(state, id) === panel);
}

export function isPanelVisible(state: ThreadSurfaceState, panel: SurfacePanel): boolean {
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
  const state: ThreadSurfaceState = {
    open: Array.isArray(raw.open) ? [...new Set(raw.open.filter(isSurfaceId))] : [],
    panelOf: {},
    side: normalizePanel(raw.side),
    bottom: normalizePanel(raw.bottom),
    maximized: null,
    focused: isPanel(raw.focused) ? raw.focused : 'side',
  };
  for (const id of [...SURFACE_IDS, ...state.open]) {
    const panel = raw.panelOf?.[id];
    if (isPanel(panel)) state.panelOf[id] = panel;
  }
  for (const panel of ['side', 'bottom'] as const) {
    const tabs = getPanelTabs(state, panel);
    const savedTab: unknown = raw[panel]?.active;
    if (savedTab === 'brain' || savedTab === 'phone') {
      state[panel].active = tabs.at(-1) ?? 'launch';
      if (!tabs.length) state[panel].shown = false;
    } else if (state[panel].active !== 'launch' && !tabs.includes(state[panel].active)) {
      state[panel].active = tabs.at(-1) ?? 'launch';
    }
  }
  if (isPanel(raw.maximized) && state[raw.maximized].shown) state.maximized = raw.maximized;
  return state;
}

export function setPanelShown(state: ThreadSurfaceState, panel: SurfacePanel, shown: boolean): void {
  state[panel].shown = shown;
  if (shown) state.focused = panel;
  if (!shown && state.maximized === panel) state.maximized = null;
}

export function activateSurfaceTab(state: ThreadSurfaceState, panel: SurfacePanel, id: SurfaceTab): void {
  state[panel].active = id;
  setPanelShown(state, panel, true);
  if (state.maximized !== panel) state.maximized = null;
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
    if (tabs.length === 1) setPanelShown(state, current, false);
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

export function toggleMaximizedPanel(state: ThreadSurfaceState, panel: SurfacePanel): void {
  if (state[panel].shown) state.maximized = state.maximized === panel ? null : panel;
}

export function launcherPanelForKey(state: ThreadSurfaceState): SurfacePanel | undefined {
  const panels = (['side', 'bottom'] as const).filter(panel =>
    isPanelVisible(state, panel) && state[panel].active === 'launch');
  return panels.includes(state.focused) ? state.focused : panels[0];
}

export function surfaceSize(panel: SurfacePanel, size: unknown, available = Infinity): number {
  const limits = PANEL_SIZES[panel];
  const max = Math.min(limits.max, Math.max(0, available));
  const min = Math.min(limits.min, max);
  return Math.max(min, Math.min(max, typeof size === 'number' && Number.isFinite(size) ? Math.round(size) : limits.default));
}
