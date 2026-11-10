import type { Chat } from '../../types';
import type { PaneSlotId } from '../../state/file-panel';
import type { IconName } from '../icon';
import type { ContentTabId, LauncherSurfaceId, SurfacePanel, ThreadSurfaceState } from './surface-state';

export interface SurfaceContext {
  chat: Chat;
  target: unknown;
  panel: SurfacePanel;
}

export interface SurfaceAvailability {
  available: boolean;
  reason?: string;
  hint?: string;
  tabCount?: number;
}

export interface SurfaceRegistration {
  render(context: SurfaceContext): HTMLElement | null;
  availability?(context: SurfaceContext): SurfaceAvailability;
  /** Called on an explicit open, including navigation to a new target. */
  open?(context: SurfaceContext): void | Promise<void>;
  /** Called when this surface becomes visible or hidden. */
  setVisible?(visible: boolean, context: SurfaceContext): void;
  close?(): void;
}

export interface SurfaceDefinition {
  id: LauncherSurfaceId;
  label: string;
  icon: IconName;
  key: string;
}

export interface ContentTabLabel {
  label: string;
  icon(): Element;
  title?: string;
  dirty?: boolean;
  loading?: boolean;
}

export interface ContentTabPlacement extends SurfaceContext {
  id: ContentTabId;
}

/** The file and browser stores own content. The surface panels own tab placement. */
export interface SurfaceContent {
  describe(id: ContentTabId): ContentTabLabel | undefined;
  layout(visible: ContentTabPlacement[], focused: SurfacePanel): void;
  render(id: ContentTabId): HTMLElement | null;
  ready(id: ContentTabId, forceLoad?: boolean): Promise<void>;
  close(id: ContentTabId): Promise<void>;
  closeFiles(paths: string[]): Promise<void>;
  drag(id: ContentTabId, transfer: DataTransfer): void;
  previewSlot(tabId: string): PaneSlotId | undefined;
  openBrowser(context: SurfaceContext): void | Promise<void>;
  restore(state: ThreadSurfaceState, saved: boolean): void;
}

export const SURFACE_GROUPS: ReadonlyArray<ReadonlyArray<SurfaceDefinition>> = [
  [
    { id: 'changes', label: 'Diff', icon: 'gitGraph', key: 'D' },
    { id: 'terminal', label: 'Terminal', icon: 'terminal', key: 'T' },
    { id: 'files', label: 'Files', icon: 'fileText', key: 'F' },
    { id: 'preview', label: 'Browser', icon: 'browser', key: 'B' },
  ],
  [
    { id: 'agents', label: 'Agents', icon: 'appAgentActivity', key: 'A' },
    { id: 'pr', label: 'Pull request', icon: 'pullRequest', key: 'P' },
    { id: 'issue', label: 'Issue', icon: 'appIssues', key: 'I' },
    { id: 'side', label: 'Side chat', icon: 'comment', key: 'S' },
  ],
];
export const SURFACES = SURFACE_GROUPS.flat();
