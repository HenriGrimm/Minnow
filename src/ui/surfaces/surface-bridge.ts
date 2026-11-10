import type { ContentTabKind, LauncherSurfaceId, SurfacePanel } from './surface-state';
import type { PaneSlotId } from '../../state/file-panel';

interface GraphiteSurfaceBridge {
  request(id: LauncherSurfaceId, action: 'show' | 'hide' | 'toggle' | 'maximize'): boolean;
  refresh(): void;
  showContent?(kind: ContentTabKind, key: string, forceLoad?: boolean, panel?: SurfacePanel): Promise<void> | undefined;
  moveContent?(): boolean;
  previewSlot?(tabId: string): PaneSlotId | undefined;
  cycleContent?(direction: 'next' | 'prev'): boolean;
}

let bridge: GraphiteSurfaceBridge | undefined;

export function setGraphiteSurfaceBridge(value: GraphiteSurfaceBridge): void {
  bridge = value;
}

export function isGraphiteSurfaceLayout(): boolean {
  return bridge !== undefined;
}

export function requestGraphiteSurface(id: LauncherSurfaceId, action: 'show' | 'hide' | 'toggle' | 'maximize'): boolean {
  return bridge?.request(id, action) ?? false;
}

export function showGraphiteContent(
  kind: ContentTabKind, key: string, forceLoad?: boolean, panel?: SurfacePanel,
): Promise<void> | undefined {
  return bridge?.showContent?.(kind, key, forceLoad, panel);
}

export function moveGraphiteContent(): boolean {
  return bridge?.moveContent?.() ?? false;
}

export function usesGraphiteContentTabs(): boolean {
  return Boolean(bridge?.showContent);
}

export function getGraphitePreviewSlot(tabId: string): PaneSlotId | undefined {
  return bridge?.previewSlot?.(tabId);
}

export function cycleGraphiteContent(direction: 'next' | 'prev'): boolean {
  return bridge?.cycleContent?.(direction) ?? false;
}

export function refreshGraphiteSurfaceLayout(): void {
  bridge?.refresh();
}

/** Graphite mounts the primary browser in its selected surface panel. */
export function isGraphiteIndependentBrowser(): boolean {
  return Boolean(bridge && document.getElementById('previewPane')?.classList.contains('graphite-browser-detached'));
}
