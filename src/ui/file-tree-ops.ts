import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * File tree CRUD — executes workspace tools, updates panel state, syncs viewer.
 */

import { getActiveChat, scheduleSaveSessions } from '../state/sessions';
import { isLocalServerAvailable } from '../tools/config';
import { getFilePanelState, patchFilePanelState } from '../state/file-panel';
import { setStatus } from './status';
import {
  clearFileTreeClipboard,
  getFileTreeClipboard,
  setFileTreeClipboard,
} from './file-tree-clipboard';
import { parseToolResult } from './file-tree-parse-result';
import { refreshFileTreeViaBridge } from './file-tree-refresh-bridge';
import {
  clearTreeSelection,
  remapTreeSelectionAfterPathChange,
  type FileTreeSelectionEntry,
} from './file-tree-selection';
import { copyTextToClipboard } from './terminal-copy-shortcut';
import {
  basename,
  computeMoveDestination,
  dirname,
  dropNestedEntries,
  isAncestorPath,
  isValidEntryName,
  joinTreePath,
  normalizeTreePath,
  pruneExpandedDirs,
  remapExpandedDirs,
} from './file-tree-path';

export type FileTreeEntryKind = 'file' | 'dir';

export type { FileTreeClipboard } from './file-tree-clipboard';
export { parseToolResult } from './file-tree-parse-result';
export {
  clearFileTreeClipboard,
  getFileTreeClipboard,
  setFileTreeClipboard,
} from './file-tree-clipboard';

export type FileTreeMutationOp = 'delete' | 'rename' | 'move' | 'create';

// ── Tools ────────────────────────────────────────────────────────────────────

/** Run a server file tool and surface status for the file tree UI. */
export async function runFileTreeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  if (!isLocalServerAvailable()) {
    return { ok: false, message: 'Open Minnow to use file tools.' };
  }
  try {
    const { executeTool } = await import('../tools/client');
    const { buildFileTreeToolContext } = await import('./file-tree-listing-root');
    const chatId = getActiveChat()?.id;
    const toolContext = {
      ...buildFileTreeToolContext(),
      ...(chatId ? { chatId } : {}),
    };
    const { content } = await executeTool(name, args, toolContext);
    if (chatId) scheduleSaveSessions();
    const parsed = parseToolResult(content);
    if (parsed.ok) {
      setStatus('ok', parsed.message);
    } else {
      setStatus('err', parsed.message);
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('err', message);
    return { ok: false, message };
  }
}

/** Update expandedDirs and selectedPath after delete/rename/move. */
export function applyPathChangeToFilePanelState(
  oldPath: string | null,
  newPath: string | null,
): void {
  if (!oldPath) return;
  const state = getFilePanelState();
  let expandedDirs = remapExpandedDirs(state.expandedDirs, oldPath, newPath);
  let selectedPath = state.selectedPath;

  const oldNorm = normalizeTreePath(oldPath);
  if (selectedPath) {
    const selNorm = normalizeTreePath(selectedPath);
    if (newPath === null) {
      if (selNorm === oldNorm || isAncestorPath(oldNorm, selNorm)) {
        selectedPath = null;
      }
    } else {
      const newNorm = normalizeTreePath(newPath);
      if (selNorm === oldNorm) {
        selectedPath = newNorm;
      } else if (isAncestorPath(oldNorm, selNorm)) {
        selectedPath = newNorm + selNorm.slice(oldNorm.length);
      }
    }
  }

  if (newPath === null) {
    expandedDirs = pruneExpandedDirs(expandedDirs, oldPath);
  }

  patchFilePanelState({ expandedDirs, selectedPath });
}

/** Align viewer tabs with deleted, renamed, or moved paths. */
export function syncViewerAfterPathChange(
  oldPath: string | null,
  newPath: string | null,
  operation: FileTreeMutationOp,
): void {
  void (async () => {
    if (!oldPath) return;
    const viewer = await import('./file-viewer');
    const tabStore = await import('./file-viewer-tab-store');
    const oldNorm = normalizeTreePath(oldPath);

    const recent = await import('../state/recent-viewer-files');
    const { getFileTreeListingWorkspaceRoot } = await import('./file-tree-listing-root');
    const workspaceRoot = getFileTreeListingWorkspaceRoot();

    const split = await import('./right-pane-split');

    if (operation === 'delete') {
      tabStore.closeViewerTabsUnderAncestor(oldNorm);
      recent.pruneRecentViewerFilesUnderAncestor(oldNorm, workspaceRoot);
      if (tabStore.listViewerTabs().length === 0) {
        viewer.closeFileViewerForce();
      } else {
        split.collapseEmptySlots();
        viewer.invalidatePrimaryViewerRender();
        viewer.renderViewerSlots();
      }
      return;
    }

    if (!newPath) return;
    const newNorm = normalizeTreePath(newPath);
    tabStore.remapViewerTabsUnderAncestor(oldNorm, newNorm);
    const slotTabs = await import('./right-pane-slot-tabs');
    slotTabs.remapSlotViewerPathsUnderAncestor(oldNorm, newNorm);
    recent.remapRecentViewerFilesUnderAncestor(oldNorm, newNorm, workspaceRoot);
    viewer.invalidatePrimaryViewerRender();
    viewer.renderViewerSlots();
  })();
}

// ── Confirm ──────────────────────────────────────────────────────────────────

/** Panel state, tree selection and viewer tabs — everything but the tree refresh. */
function applyMutationLocally(
  oldPath: string | null,
  newPath: string | null,
  operation: FileTreeMutationOp,
): void {
  applyPathChangeToFilePanelState(oldPath, newPath);
  if (oldPath) remapTreeSelectionAfterPathChange(oldPath, newPath);
  syncViewerAfterPathChange(oldPath, newPath, operation);
}

async function finishMutation(
  oldPath: string | null,
  newPath: string | null,
  operation: FileTreeMutationOp,
): Promise<void> {
  applyMutationLocally(oldPath, newPath, operation);
  await refreshFileTreeViaBridge();
}

async function confirmRenameIfDirty(path: string): Promise<boolean> {
  const tabStore = await import('./file-viewer-tab-store');
  const norm = normalizeTreePath(path);
  if (tabStore.isViewerTabDirty(norm)) {
    return await appConfirm(
      'This file has unsaved changes. Rename anyway? The editor will follow the new path.',
    );
  }
  return true;
}

async function confirmDelete(path: string, kind: FileTreeEntryKind): Promise<boolean> {
  const tabStore = await import('./file-viewer-tab-store');
  const norm = normalizeTreePath(path);
  if (tabStore.isViewerTabDirty(norm)) {
    const ok = await appConfirm(
      'This file has unsaved changes. Delete anyway? Changes will be lost.',
    );
    if (!ok) return false;
  }
  if (kind === 'dir') {
    return await appConfirm(
      `Delete folder "${basename(path)}" and everything inside it? This cannot be undone.`,
    );
  }
  return await appConfirm(`Delete "${basename(path)}"?`);
}

/** One confirm for a whole selection; names the folders because those recurse. */
async function confirmDeleteMany(entries: FileTreeSelectionEntry[]): Promise<boolean> {
  const tabStore = await import('./file-viewer-tab-store');
  const dirty = entries.filter((entry) => tabStore.isViewerTabDirty(normalizeTreePath(entry.path)));
  if (dirty.length > 0) {
    const ok = await appConfirm(
      dirty.length === 1
        ? `"${basename(dirty[0]!.path)}" has unsaved changes. Delete anyway? Changes will be lost.`
        : `${dirty.length} of these files have unsaved changes. Delete anyway? Changes will be lost.`,
    );
    if (!ok) return false;
  }

  const folders = entries.filter((entry) => entry.kind === 'dir');
  const files = entries.length - folders.length;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (folders.length > 0) {
    parts.push(`${folders.length} folder${folders.length === 1 ? '' : 's'}`);
  }
  const what = parts.join(' and ');
  const recurses = folders.length > 0 ? ' Folders are deleted with everything inside them.' : '';
  return await appConfirm(`Delete ${what}?${recurses} This cannot be undone.`);
}

// ── Mutations ────────────────────────────────────────────────────────────────

/** Delete a file or directory via delete_path. */
export async function deletePath(path: string, kind: FileTreeEntryKind): Promise<boolean> {
  if (!(await confirmDelete(path, kind))) return false;
  setStatus('spin', 'Deleting…');
  const result = await runFileTreeTool('delete_path', { path: normalizeTreePath(path) });
  if (!result.ok) return false;
  await finishMutation(path, null, 'delete');
  return true;
}

/**
 * Delete a whole tree selection: one confirm, one refresh, and a count in the
 * status line. Entries nested under another selected folder are skipped — the
 * folder's own delete already removed them.
 */
export async function deletePaths(entries: FileTreeSelectionEntry[]): Promise<number> {
  const targets = dropNestedEntries(
    entries.map((entry) => ({ ...entry, path: normalizeTreePath(entry.path) })),
  );
  if (targets.length === 0) return 0;
  if (targets.length === 1) {
    const only = targets[0]!;
    return (await deletePath(only.path, only.kind)) ? 1 : 0;
  }
  if (!(await confirmDeleteMany(targets))) return 0;

  let deleted = 0;
  let failed = 0;
  for (const target of targets) {
    setStatus('spin', `Deleting ${deleted + failed + 1} of ${targets.length}…`);
    const result = await runFileTreeTool('delete_path', { path: target.path });
    if (!result.ok) {
      failed += 1;
      continue;
    }
    deleted += 1;
    applyMutationLocally(target.path, null, 'delete');
  }

  clearTreeSelection();
  await refreshFileTreeViaBridge();
  if (failed > 0) {
    setStatus('err', `Deleted ${deleted} of ${targets.length} — ${failed} failed.`);
  } else {
    setStatus('ok', `Deleted ${deleted} items`);
  }
  return deleted;
}

/** Start inline rename on the matching tree row (context menu / F2). */
export function renamePath(path: string, kind: FileTreeEntryKind): void {
  void import('./file-tree-rename').then((m) => m.startInlineRename(path, kind));
}

/** Apply rename after inline edit (or tests) via move_file. */
export async function commitRename(
  path: string,
  kind: FileTreeEntryKind,
  nextName: string,
): Promise<boolean> {
  const currentName = basename(path);
  const trimmed = nextName.trim();
  if (!trimmed) {
    setStatus('err', 'Name cannot be empty.');
    return false;
  }
  if (!isValidEntryName(trimmed)) {
    setStatus('err', 'Invalid name. Use a single name without / or \\.');
    return false;
  }
  if (trimmed === currentName) {
    setStatus('idle', 'Name unchanged');
    return false;
  }
  if (!(await confirmRenameIfDirty(path))) {
    setStatus('idle', 'Rename cancelled');
    return false;
  }

  const parent = dirname(path);
  const destination = joinTreePath(parent, trimmed);
  return movePath(path, destination, 'rename');
}

/** Move or rename with move_file. */
export async function movePath(
  source: string,
  destination: string,
  operation: 'rename' | 'move' = 'move',
): Promise<boolean> {
  setStatus('spin', operation === 'rename' ? 'Renaming…' : 'Moving…');
  const result = await runFileTreeTool('move_file', {
    source: normalizeTreePath(source),
    destination: normalizeTreePath(destination),
  });
  if (!result.ok) return false;
  await finishMutation(source, destination, operation);
  return true;
}

/**
 * Move a whole tree selection into `destDir`: one refresh, a count in the status
 * line, and sources that cannot land there (already in it, or the folder being
 * dropped into itself) skipped rather than failing the batch.
 */
export async function movePaths(
  sources: string[],
  destDir: string,
): Promise<number> {
  const dir = normalizeTreePath(destDir);
  const targets = dropNestedEntries(
    sources.map((path) => ({ path: normalizeTreePath(path) })),
  )
    .map(({ path }) => ({ path, destination: computeMoveDestination(path, dir) }))
    .filter((item): item is { path: string; destination: string } => item.destination !== null);

  if (targets.length === 0) {
    setStatus('idle', 'Nothing to move there');
    return 0;
  }
  if (targets.length === 1) {
    const only = targets[0]!;
    return (await movePath(only.path, only.destination, 'move')) ? 1 : 0;
  }

  let moved = 0;
  let failed = 0;
  for (const target of targets) {
    setStatus('spin', `Moving ${moved + failed + 1} of ${targets.length}…`);
    const result = await runFileTreeTool('move_file', {
      source: target.path,
      destination: target.destination,
    });
    if (!result.ok) {
      failed += 1;
      continue;
    }
    moved += 1;
    applyMutationLocally(target.path, target.destination, 'move');
  }

  await refreshFileTreeViaBridge();
  if (failed > 0) {
    setStatus('err', `Moved ${moved} of ${targets.length} — ${failed} failed.`);
  } else {
    setStatus('ok', `Moved ${moved} items`);
  }
  return moved;
}

/** Copy or cut every clipboard item into target directory. */
export async function pasteInto(targetDir: string): Promise<boolean> {
  const clip = getFileTreeClipboard();
  if (!clip || clip.paths.length === 0) {
    setStatus('err', 'Nothing to paste. Copy or cut a file first.');
    return false;
  }

  const dir = normalizeTreePath(targetDir === '.' ? '.' : targetDir);
  const sources = dropNestedEntries(clip.paths.map((path) => ({ path: normalizeTreePath(path) })));
  const toolName = clip.mode === 'cut' ? 'move_file' : 'copy_file';
  const op: FileTreeMutationOp = clip.mode === 'cut' ? 'move' : 'create';
  const verb = clip.mode === 'cut' ? 'Moving' : 'Copying';

  let done = 0;
  let failed = 0;
  for (const { path: source } of sources) {
    const dest = joinTreePath(dir, basename(source));
    setStatus(
      'spin',
      sources.length === 1 ? `${verb}…` : `${verb} ${done + failed + 1} of ${sources.length}…`,
    );
    const result = await runFileTreeTool(toolName, { source, destination: dest });
    if (!result.ok) {
      failed += 1;
      continue;
    }
    done += 1;
    if (clip.mode === 'cut') applyMutationLocally(source, dest, op);
  }

  if (done === 0) return false;
  if (clip.mode === 'cut') clearFileTreeClipboard();
  await refreshFileTreeViaBridge();
  if (failed > 0) {
    setStatus('err', `${done} of ${sources.length} pasted — ${failed} failed.`);
  } else if (sources.length > 1) {
    setStatus('ok', `Pasted ${done} items`);
  }
  return true;
}

/** Open inline name field for a new file under parentDir (context menu). */
export function createFileInDir(parentDir: string): void {
  void import('./file-tree-create').then((m) => m.startInlineCreate(parentDir, 'file'));
}

/** Open inline name field for a new folder under parentDir (context menu). */
export function createFolderInDir(parentDir: string): void {
  void import('./file-tree-create').then((m) => m.startInlineCreate(parentDir, 'dir'));
}

/** Create file or folder after inline name entry. */
export async function commitCreate(
  parentDir: string,
  kind: FileTreeEntryKind,
  name: string,
): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) {
    setStatus('err', 'Name cannot be empty.');
    return false;
  }
  if (!isValidEntryName(trimmed)) {
    setStatus('err', 'Invalid name. Use a single name without / or \\.');
    return false;
  }
  const path = joinTreePath(parentDir, trimmed);
  setStatus('spin', kind === 'dir' ? 'Creating folder…' : 'Creating file…');
  const result = await runFileTreeTool(
    kind === 'dir' ? 'make_directory' : 'save_file',
    kind === 'dir' ? { path } : { path, content: '' },
  );
  if (!result.ok) return false;
  await finishMutation(null, null, 'create');
  return true;
}

// ── Clipboard ────────────────────────────────────────────────────────────────

/** Copy path to in-memory clipboard. */
export function copyPathToClipboard(path: string): void {
  setFileTreeClipboard('copy', [normalizeTreePath(path)]);
  setStatus('ok', `Copied ${basename(path)}`);
}

/** Copy a whole tree selection to the in-memory clipboard. */
export function copyPathsToClipboard(paths: string[]): void {
  if (paths.length === 0) return;
  if (paths.length === 1) {
    copyPathToClipboard(paths[0]!);
    return;
  }
  setFileTreeClipboard('copy', paths.map((path) => normalizeTreePath(path)));
  setStatus('ok', `Copied ${paths.length} items`);
}

/** Cut a whole tree selection to the in-memory clipboard (paste = batch move). */
export function cutPathsToClipboard(paths: string[]): void {
  if (paths.length === 0) return;
  if (paths.length === 1) {
    cutPathToClipboard(paths[0]!);
    return;
  }
  setFileTreeClipboard('cut', paths.map((path) => normalizeTreePath(path)));
  setStatus('ok', `Cut ${paths.length} items`);
}

/** Copy workspace-relative path string to the OS clipboard. */
export async function copyWorkspacePathStringToClipboard(path: string): Promise<void> {
  const normalized = normalizeTreePath(path);
  await copyTextToClipboard(normalized);
  setStatus('ok', `Copied path ${basename(path)}`);
}

/** Cut path to in-memory clipboard. */
export function cutPathToClipboard(path: string): void {
  setFileTreeClipboard('cut', [normalizeTreePath(path)]);
  setStatus('ok', `Cut ${basename(path)}`);
}

export { pasteTargetDirForPath } from './file-tree-path';
