/**
 * Multi-select for the file tree (MIN: Ctrl/Cmd-click toggle, Shift-click range).
 *
 * Kept apart from `filePanel.selectedPath`, which means "this file is open in the
 * viewer" and is persisted. Tree selection is transient UI state: an ordered list
 * of rows the user has marked for a batch delete / move / drag.
 *
 * Range selection reads the rendered rows rather than a model, so it follows
 * whatever the tree currently shows — nested subtrees in tree mode, the flat hit
 * list while a filter is active — with no second ordering to keep in sync.
 */

import { isAncestorPath, normalizeTreePath } from './file-tree-path';

export type FileTreeEntryKind = 'file' | 'dir';

export interface FileTreeSelectionEntry {
  path: string;
  kind: FileTreeEntryKind;
}

/** What a click did, so the row handler knows whether to also open the file. */
export type RowSelectionOutcome = 'activate' | 'selection-only';

export const MULTISELECT_CLASS = 'file-tree-row--multiselected';

/** Insertion-ordered; the order rows were added is the order batch ops apply in. */
let selection: FileTreeSelectionEntry[] = [];
/** Row a Shift-click measures its range from. */
let anchorPath: string | null = null;

// ── Read ─────────────────────────────────────────────────────────────────────

export function getTreeSelection(): FileTreeSelectionEntry[] {
  return selection.map((entry) => ({ ...entry }));
}

export function getSelectedTreePaths(): string[] {
  return selection.map((entry) => entry.path);
}

export function treeSelectionCount(): number {
  return selection.length;
}

export function isTreePathSelected(path: string): boolean {
  const norm = normalizeTreePath(path);
  return selection.some((entry) => entry.path === norm);
}

export function getTreeSelectionAnchor(): string | null {
  return anchorPath;
}

/**
 * Entries a batch op should act on for a row the user invoked it from: the whole
 * selection when that row is part of it, otherwise just that row. A context menu
 * on an unselected row must not silently operate on a selection elsewhere.
 */
export function selectionForRow(
  path: string,
  kind: FileTreeEntryKind,
): FileTreeSelectionEntry[] {
  const norm = normalizeTreePath(path);
  if (selection.length > 1 && isTreePathSelected(norm)) return getTreeSelection();
  return [{ path: norm, kind }];
}

// ── Write ────────────────────────────────────────────────────────────────────

export function clearTreeSelection(): void {
  if (selection.length === 0 && anchorPath === null) return;
  selection = [];
  anchorPath = null;
  applyTreeSelectionToRows();
}

export function replaceTreeSelection(entries: FileTreeSelectionEntry[]): void {
  const seen = new Set<string>();
  const next: FileTreeSelectionEntry[] = [];
  for (const entry of entries) {
    const norm = normalizeTreePath(entry.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    next.push({ path: norm, kind: entry.kind });
  }
  selection = next;
  applyTreeSelectionToRows();
}

export function setTreeSelectionAnchor(path: string | null): void {
  anchorPath = path === null ? null : normalizeTreePath(path);
}

/** Add or remove one row; returns true when it ended up selected. */
export function toggleTreeSelection(entry: FileTreeSelectionEntry): boolean {
  const norm = normalizeTreePath(entry.path);
  const index = selection.findIndex((item) => item.path === norm);
  if (index >= 0) {
    selection.splice(index, 1);
    applyTreeSelectionToRows();
    return false;
  }
  selection.push({ path: norm, kind: entry.kind });
  applyTreeSelectionToRows();
  return true;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function treeHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById('fileTreeHost');
}

/** Rendered rows top to bottom — the order Shift-click ranges run in. */
export function visibleTreeRowEntries(): FileTreeSelectionEntry[] {
  const host = treeHost();
  if (!host) return [];
  const out: FileTreeSelectionEntry[] = [];
  for (const el of host.querySelectorAll<HTMLElement>('.file-tree-row[data-path]')) {
    const path = el.dataset.path?.trim();
    if (!path) continue;
    out.push({
      path: normalizeTreePath(path),
      kind: el.classList.contains('file-tree-row--dir') ? 'dir' : 'file',
    });
  }
  return out;
}

/** Contiguous rendered rows from `fromPath` to `toPath` inclusive (either order). */
export function rangeTreeSelection(
  fromPath: string,
  toPath: string,
): FileTreeSelectionEntry[] {
  const rows = visibleTreeRowEntries();
  const from = normalizeTreePath(fromPath);
  const to = normalizeTreePath(toPath);
  const start = rows.findIndex((row) => row.path === from);
  const end = rows.findIndex((row) => row.path === to);
  if (start < 0 || end < 0) return [];
  return start <= end ? rows.slice(start, end + 1) : rows.slice(end, start + 1).reverse();
}

/**
 * Paint `--multiselected` and `aria-selected` onto the rendered rows. Called after
 * every selection change and at the end of every render, so the classes survive
 * the tree rebuilding itself.
 */
export function applyTreeSelectionToRows(): void {
  const host = treeHost();
  if (!host) return;
  const selected = new Set(selection.map((entry) => entry.path));
  for (const el of host.querySelectorAll<HTMLElement>('.file-tree-row[data-path]')) {
    const path = el.dataset.path?.trim();
    const on = Boolean(path) && selected.has(normalizeTreePath(path!));
    el.classList.toggle(MULTISELECT_CLASS, on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

/** Drop selected rows that no longer exist in the tree (collapse, refresh, delete). */
export function pruneTreeSelectionToVisibleRows(): void {
  if (selection.length === 0) return;
  const host = treeHost();
  if (!host) return;
  const visible = new Set(visibleTreeRowEntries().map((row) => row.path));
  const next = selection.filter((entry) => visible.has(entry.path));
  if (next.length !== selection.length) {
    selection = next;
    if (anchorPath && !visible.has(anchorPath)) anchorPath = null;
  }
}

/** Follow a delete (newPath null), rename or move so the selection stays truthful. */
export function remapTreeSelectionAfterPathChange(
  oldPath: string,
  newPath: string | null,
): void {
  const oldNorm = normalizeTreePath(oldPath);
  const remapOne = (path: string): string | null => {
    if (newPath === null) {
      return path === oldNorm || isAncestorPath(oldNorm, path) ? null : path;
    }
    const newNorm = normalizeTreePath(newPath);
    if (path === oldNorm) return newNorm;
    if (isAncestorPath(oldNorm, path)) return newNorm + path.slice(oldNorm.length);
    return path;
  };

  const next: FileTreeSelectionEntry[] = [];
  for (const entry of selection) {
    const mapped = remapOne(entry.path);
    if (mapped !== null) next.push({ path: mapped, kind: entry.kind });
  }
  selection = next;
  if (anchorPath) anchorPath = remapOne(anchorPath);
}

// ── Click ────────────────────────────────────────────────────────────────────

export interface RowSelectionModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Apply standard selection semantics for a row click.
 *
 * - plain: selection becomes this row, anchor moves here, caller activates it
 *   (open the file / toggle the folder).
 * - Ctrl/Cmd: toggle this row, anchor moves here, nothing is activated.
 * - Shift: replace the selection with the range from the anchor, nothing is
 *   activated. With no anchor there is no range, so it falls back to plain.
 */
export function applyRowClickSelection(
  path: string,
  kind: FileTreeEntryKind,
  modifiers: RowSelectionModifiers,
): RowSelectionOutcome {
  const norm = normalizeTreePath(path);
  const additive = Boolean(modifiers.ctrlKey || modifiers.metaKey);

  if (modifiers.shiftKey && anchorPath && anchorPath !== norm) {
    const range = rangeTreeSelection(anchorPath, norm);
    if (range.length > 0) {
      replaceTreeSelection(range);
      return 'selection-only';
    }
  }

  if (additive) {
    toggleTreeSelection({ path: norm, kind });
    anchorPath = norm;
    return 'selection-only';
  }

  replaceTreeSelection([{ path: norm, kind }]);
  anchorPath = norm;
  return 'activate';
}

/** Ctrl/Cmd+A over the tree. */
export function selectAllVisibleTreeRows(): void {
  const rows = visibleTreeRowEntries();
  if (rows.length === 0) return;
  replaceTreeSelection(rows);
  anchorPath = rows[rows.length - 1]!.path;
}

/** Reset module state (tests). */
export function resetTreeSelectionForTests(): void {
  selection = [];
  anchorPath = null;
}
