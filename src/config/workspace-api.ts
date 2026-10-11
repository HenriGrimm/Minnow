/**
 * Workspace folder API — directory where AI tools operate.
 */

export interface WorkspaceRecentItem {
  path: string;
  label: string;
  exists: boolean;
  isCurrent: boolean;
}

export interface WorkspaceInfo {
  ok?: boolean;
  path: string;
  label: string;
  isDefault: boolean;
  recent?: WorkspaceRecentItem[];
  /** Pinned Sandbox home; not stored in the recents MRU. */
  sandbox?: WorkspaceRecentItem;
  /** Configured parent directory for new projects (defaults to ~/Projects). */
  newProjectParent?: string;
  /** Absolute path to the Minnow Scratch sandbox (~/.minnow/workspace). */
  scratchPath?: string;
}

export interface WorkspacePickResult {
  ok: boolean;
  cancelled: boolean;
  path: string | null;
  label?: string;
  isDefault?: boolean;
  error?: string;
}

export interface WorkspaceBrowseEntry {
  name: string;
  path: string;
}

export interface WorkspaceBrowseResult {
  ok?: boolean;
  path: string;
  parent: string | null;
  entries: WorkspaceBrowseEntry[];
  error?: string;
}

/** Fetch the current workspace from the dev server. */
export async function fetchWorkspace(): Promise<WorkspaceInfo | null> {
  try {
    const res = await fetch('/api/workspace', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as WorkspaceInfo;
  } catch {
    return null;
  }
}

export interface WorkspaceMkdirResult {
  ok?: boolean;
  path: string;
  name: string;
  error?: string;
}

/** Change the new-project default without switching workspaces. Empty restores ~/Projects. */
export async function saveProjectLocation(path: string): Promise<string> {
  const res = await fetch('/api/workspace/project-location', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const json = await res.json() as { newProjectParent: string; error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.newProjectParent;
}

/** List directories for the in-app workspace folder picker. */
export async function browseWorkspaceFolders(
  browsePath = '',
): Promise<WorkspaceBrowseResult> {
  const query = browsePath.trim()
    ? `?path=${encodeURIComponent(browsePath.trim())}`
    : '';
  const res = await fetch(`/api/workspace/browse${query}`, { cache: 'no-store' });
  const json = (await res.json()) as WorkspaceBrowseResult & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/** Create a subfolder under parentPath for the in-app workspace folder picker. */
export async function createWorkspaceSubfolder(
  parentPath: string,
  name: string,
): Promise<WorkspaceMkdirResult> {
  const res = await fetch('/api/workspace/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name }),
  });
  const json = (await res.json()) as WorkspaceMkdirResult & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/** Clone a repository without changing the active workspace. */
export async function cloneWorkspaceRepository(
  parentPath: string,
  name: string,
  remoteUrl: string,
): Promise<WorkspaceMkdirResult> {
  const res = await fetch('/api/workspace/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name, remoteUrl }),
  });
  const json = await res.json() as WorkspaceMkdirResult;
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

/** Open the native folder picker and set workspace when a folder is chosen. */
export async function pickWorkspaceFolder(): Promise<WorkspacePickResult> {
  const res = await fetch('/api/workspace/pick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const json = (await res.json()) as WorkspacePickResult & { error?: string };
  if (!res.ok) {
    return {
      ok: false,
      cancelled: false,
      path: null,
      error: json.error ?? `HTTP ${res.status}`,
    };
  }
  return json;
}

/** Set workspace by absolute path (validated on server). */
export async function setWorkspacePath(absPath: string): Promise<WorkspaceInfo> {
  const res = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: absPath }),
  });
  const json = (await res.json()) as WorkspaceInfo & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

/** Remove one path from the MRU list without changing the active workspace. */
export async function removeRecentWorkspace(
  absPath: string,
): Promise<WorkspaceRecentItem[]> {
  const res = await fetch('/api/workspace/recent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: absPath }),
  });
  const json = (await res.json()) as { recent?: WorkspaceRecentItem[]; error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json.recent ?? [];
}
