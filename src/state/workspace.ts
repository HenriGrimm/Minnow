/**
 * Client-side workspace root — synced from /api/workspace when npm start is running.
 */

import { fetchWorkspace, type WorkspaceInfo, type WorkspaceRecentItem } from '../config/workspace-api';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { getViewWorkspacePath } from './view-workspace';
import { notifyPluginContextChanged } from '../plugins/events';

let workspacePath = '';
let workspaceLabel = '';
let workspaceIsDefault = true;
let workspaceRecent: WorkspaceRecentItem[] = [];

/** Absolute path of the AI workspace folder. */
export function getWorkspacePath(): string {
  return workspacePath;
}

/**
 * True when `targetPath` is already the folder this renderer is on.
 *
 * Bound Electron windows compare against `viewContext` (the window's real
 * folder). An unbound gate window is never a match, so the first pick still
 * retargets. Browser / tests fall back to the live `/api/workspace` path.
 */
export function isCurrentWindowWorkspace(targetPath: string): boolean {
  const trimmed = targetPath.trim();
  if (!trimmed) return true;
  const viewPath = getViewWorkspacePath();
  if (viewPath) return workspacePathsEqual(viewPath, trimmed);
  if (typeof window !== 'undefined' && window.minnow?.viewContext) return false;
  return workspacePathsEqual(getWorkspacePath(), trimmed);
}

/** Snapshot for callers that no-op a switch because this window is already on the folder. */
export function getCurrentWorkspaceInfo(): WorkspaceInfo {
  return {
    path: getWorkspacePath() || getViewWorkspacePath(),
    label: getWorkspaceLabel(),
    isDefault: isDefaultWorkspace(),
  };
}

/** Folder basename for compact UI. */
export function getWorkspaceLabel(): string {
  return workspaceLabel;
}

/** True when workspace equals the Minnow app directory. */
export function isDefaultWorkspace(): boolean {
  return workspaceIsDefault;
}

function applyWorkspaceInfo(info: WorkspaceInfo): void {
  workspacePath = info.path ?? '';
  workspaceLabel = info.label ?? '';
  workspaceIsDefault = info.isDefault === true;
  notifyPluginContextChanged();
  if (Array.isArray(info.recent)) {
    workspaceRecent = info.recent;
  }
  if (info.scratchPath?.trim()) {
    void import('../state/sessions').then((m) =>
      m.migrateScratchWorkspacePathsForLoadedSession(info.scratchPath!.trim()),
    );
  }
}

/** MRU rows last seen from GET/PUT workspace (instant workspace menu paint). */
export function getWorkspaceRecentItems(): readonly WorkspaceRecentItem[] {
  return workspaceRecent;
}

/** Load workspace from server; leaves prior values if unavailable. */
export async function loadWorkspaceFromServer(): Promise<WorkspaceInfo | null> {
  const info = await fetchWorkspace();
  if (!info?.path) return null;
  applyWorkspaceInfo(info);
  return info;
}

/** Update in-memory workspace after a successful pick or PUT. */
export function setWorkspaceFromServer(info: WorkspaceInfo): void {
  applyWorkspaceInfo(info);
}

/** Test helper — reset module state. */
export function resetWorkspaceStateForTests(): void {
  workspacePath = '';
  workspaceLabel = '';
  workspaceIsDefault = true;
  workspaceRecent = [];
}
