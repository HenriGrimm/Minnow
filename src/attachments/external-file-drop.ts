/**
 * Detect OS file drags (Windows Explorer, Finder, etc.) vs internal workspace drags.
 */

import { hasCodeSelectionDrag } from './code-selection-drag';
import {
  getActiveNativeWorkspaceDrag,
  isNativeWorkspaceDrag,
  nativeWorkspaceDragPath,
} from './native-file-drag';
import { WORKSPACE_FILE_MIME, WORKSPACE_FILES_MIME } from './workspace-ref';

export type DragKind = 'external' | 'workspace' | 'codeSelection';

/** Heuristic: plain-text fallback for file-tree drags must not match code lines like `x = 1`. */
export function looksLikeWorkspaceRelativePath(plain: string): boolean {
  const trimmed = plain.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.length > 512) return false;
  if (trimmed.startsWith('file:') || trimmed.startsWith('preview:')) return false;
  if (/[=;{}()]/.test(trimmed)) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  return /\.[a-zA-Z0-9]{1,12}$/.test(trimmed);
}

/** True when the drag carries native OS files (Explorer, Finder, desktop). */
export function hasExternalFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  // Minnow's own native drag-out carries Files too, but it is a workspace drag.
  if (isNativeWorkspaceDrag(dataTransfer)) return false;
  const types = dataTransfer.types;
  if (types.includes('Files')) return true;
  return dataTransfer.files.length > 0;
}

/** True when the drag originated from the Minnow file tree (workspace-relative path). */
export function hasWorkspaceFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if (isNativeWorkspaceDrag(dataTransfer)) return true;
  if (hasCodeSelectionDrag(dataTransfer)) return false;
  if (dataTransfer.types.includes(WORKSPACE_FILE_MIME)) return true;
  const plain = dataTransfer.getData('text/plain').trim();
  return looksLikeWorkspaceRelativePath(plain);
}

/**
 * Workspace-relative path carried by a file-tree drag: the native drag-out
 * session, the workspace MIME, or a single-line `text/plain` fallback.
 */
export function readWorkspaceDragPath(dataTransfer: DataTransfer): string | null {
  const native = nativeWorkspaceDragPath(dataTransfer);
  if (native) return native;
  const typed = dataTransfer.getData(WORKSPACE_FILE_MIME).trim();
  if (typed) return typed;
  const plain = dataTransfer.getData('text/plain').trim();
  if (!plain || plain.includes('\n') || plain.length > 512) return null;
  return plain;
}

/**
 * Every workspace path carried by a file-tree drag. A multi-select drag of N rows
 * yields all N; anything else yields the single path (or nothing).
 */
export function readWorkspaceDragPaths(dataTransfer: DataTransfer): string[] {
  const native = getActiveNativeWorkspaceDrag();
  if (native && isNativeWorkspaceDrag(dataTransfer) && native.paths.length > 0) {
    return [...native.paths];
  }
  const many = dataTransfer
    .getData(WORKSPACE_FILES_MIME)
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  if (many.length > 0) return many;
  const single = readWorkspaceDragPath(dataTransfer);
  return single ? [single] : [];
}

/**
 * Classify an incoming drag. External OS files take precedence over plain-text paths
 * (Explorer often sets both `Files` and `text/plain` / `text/uri-list`).
 */
export function classifyFileDrag(dataTransfer: DataTransfer | null): DragKind | null {
  if (!dataTransfer) return null;
  if (hasCodeSelectionDrag(dataTransfer)) return 'codeSelection';
  if (hasExternalFileDrag(dataTransfer) && !dataTransfer.types.includes(WORKSPACE_FILE_MIME)) {
    return 'external';
  }
  if (hasWorkspaceFileDrag(dataTransfer)) return 'workspace';
  return null;
}

/** File list from a completed drop event (folder trees use webkitGetAsEntry instead). */
export function filesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const out: File[] = [];
  for (let i = 0; i < dataTransfer.files.length; i += 1) {
    const file = dataTransfer.files[i];
    if (file) out.push(file);
  }
  return out;
}

/** Skip directory entries when the platform exposes them as zero-byte File items. */
export function isLikelyDirectoryDrop(file: File): boolean {
  const type = file.type.toLowerCase();
  if (
    type === 'application/x-directory' ||
    type === 'inode/directory'
  ) {
    return true;
  }
  if (file.size === 0 && file.type === '') {
    const name = file.name;
    if (!name.includes('.') || name.endsWith('.')) return true;
  }
  return false;
}
