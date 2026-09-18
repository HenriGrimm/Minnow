import { collectDroppedTreeEntries } from '../attachments/directory-drop';
import { classifyFileDrag, readWorkspaceDragPaths } from '../attachments/external-file-drop';
import { getActiveNativeWorkspaceDrag } from '../attachments/native-file-drag';
import { computeMoveDestination, isAncestorPath } from './file-tree-path';
import { getLocalServerAvailable } from '../tools/client';
import { expandDir } from './file-tree';
import { importDroppedEntriesToWorkspace } from './import-external-files';
import { movePath, movePaths } from './file-tree-ops';
import {
  getSelectedTreePaths,
  isTreePathSelected,
  treeSelectionCount,
} from './file-tree-selection';
import { setStatus } from './status';

const DROP_TARGET_CLASS = 'file-tree-row--drop-target';
const HOST_DROP_CLASS = 'file-tree-host--drop-target';

let hostBound: HTMLElement | null = null;
let moveInFlight = false;
/** Set on dragstart; dragover cannot read DataTransfer.getData in most browsers. */
let activeDragSourcePath: string | null = null;
/** Every path the drag carries — the whole tree selection for a multi-row drag. */
let activeDragSourcePaths: string[] = [];
/** Set when the `drop` handler dispatches a move/import; the dragend fallback skips when true. */
let dropHandled = false;

// ── Detect ───────────────────────────────────────────────────────────────────

function hasWorkspaceDrag(dataTransfer: DataTransfer | null): boolean {
  return classifyFileDrag(dataTransfer) === 'workspace';
}

function hasExternalDrag(dataTransfer: DataTransfer | null): boolean {
  return classifyFileDrag(dataTransfer) === 'external';
}

function hasTreeDrag(dataTransfer: DataTransfer | null): boolean {
  return classifyFileDrag(dataTransfer) !== null;
}

/** The row being dragged: the native drag-out session wins over a stale dragstart path. */
function dragSourcePath(): string {
  return getActiveNativeWorkspaceDrag()?.paths[0] ?? activeDragSourcePath?.trim() ?? '';
}

/** Every dragged path, for a batch move. Falls back to the single dragged row. */
function dragSourcePaths(): string[] {
  const native = getActiveNativeWorkspaceDrag()?.paths;
  if (native?.length) return [...native];
  if (activeDragSourcePaths.length > 0) return [...activeDragSourcePaths];
  const single = dragSourcePath();
  return single ? [single] : [];
}

function folderRowFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const row = target.closest('.file-tree-row--dir');
  return row instanceof HTMLElement ? row : null;
}

function clearDropHighlight(host: HTMLElement): void {
  host.classList.remove(HOST_DROP_CLASS);
  for (const row of host.querySelectorAll(`.${DROP_TARGET_CLASS}`)) {
    row.classList.remove(DROP_TARGET_CLASS);
  }
}

// ── Drop ─────────────────────────────────────────────────────────────────────

/** Core internal move: validate + move `sources` into `destDir`. */
async function performTreeMove(sources: string[], destDir: string): Promise<void> {
  const movable = sources.filter((source) => computeMoveDestination(source, destDir) !== null);
  if (movable.length === 0) {
    // Dropping a folder on itself, or anything on the folder it already sits in,
    // is a no-op; only a drop *inside* the dragged folder is worth complaining about.
    const intoOwnSubfolder = sources.some(
      (source) => destDir !== source && isAncestorPath(source, destDir),
    );
    if (intoOwnSubfolder) {
      setStatus('err', 'Cannot move a folder into itself or its subfolder.');
    }
    return;
  }

  moveInFlight = true;
  try {
    const ok =
      movable.length === 1
        ? await movePath(movable[0]!, computeMoveDestination(movable[0]!, destDir)!, 'move')
        : (await movePaths(movable, destDir)) > 0;
    if (ok) {
      void expandDir(destDir);
    }
  } finally {
    moveInFlight = false;
  }
}

async function handleTreeDrop(
  event: DragEvent,
  targetRow: HTMLElement,
): Promise<void> {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;

  const sources = dragSourcePaths().length
    ? dragSourcePaths()
    : readWorkspaceDragPaths(dataTransfer);
  const destDir = targetRow.dataset.path;
  if (sources.length === 0 || !destDir) return;

  dropHandled = true;
  await performTreeMove(sources, destDir);
}

async function handleExternalTreeDrop(
  event: DragEvent,
  destDir: string,
): Promise<void> {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;

  const { entries, error } = await collectDroppedTreeEntries(dataTransfer);
  if (!entries.length) {
    setStatus('err', error ?? 'Nothing to import from this drop.');
    return;
  }

  moveInFlight = true;
  try {
    const result = await importDroppedEntriesToWorkspace(entries, destDir);
    if (result.imported > 0 || result.directories > 0) {
      void expandDir(destDir);
    }
  } finally {
    moveInFlight = false;
  }
}

/**
 * Paths a drag off `path` carries: the whole tree selection when that row belongs
 * to it, otherwise just the row. Read at dragstart, because dragover and drop
 * cannot see the DataTransfer contents.
 */
function selectedDragPathsForRow(path: string | null): string[] {
  const row = path?.trim();
  if (!row) return [];
  if (treeSelectionCount() > 1 && isTreePathSelected(row)) return getSelectedTreePaths();
  return [row];
}

function pathFromDragRow(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const row = target.closest('.file-tree-row[data-path]');
  if (!(row instanceof HTMLElement)) return null;
  const path = row.dataset.path?.trim();
  return path || null;
}

// ── Bind ─────────────────────────────────────────────────────────────────────

function bindHost(host: HTMLElement): void {
  host.addEventListener(
    'dragstart',
    (event) => {
      activeDragSourcePath = pathFromDragRow(event.target);
      activeDragSourcePaths = selectedDragPathsForRow(activeDragSourcePath);
      dropHandled = false;
    },
    true,
  );

  host.addEventListener('dragover', (event) => {
    if (moveInFlight || !getLocalServerAvailable()) return;
    if (!hasTreeDrag(event.dataTransfer)) return;

    if (hasExternalDrag(event.dataTransfer)) {
      const row = folderRowFromTarget(event.target);
      const destDir = row?.dataset.path ?? '.';
      if (!destDir) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      clearDropHighlight(host);
      if (row) {
        row.classList.add(DROP_TARGET_CLASS);
      } else {
        host.classList.add(HOST_DROP_CLASS);
      }
      return;
    }

    if (!hasWorkspaceDrag(event.dataTransfer)) return;

    const row = folderRowFromTarget(event.target);
    if (!row?.dataset.path) return;

    const destDir = row.dataset.path;
    const sources = dragSourcePaths();
    // Highlight as long as at least one dragged row can land here.
    if (!sources.some((source) => computeMoveDestination(source, destDir) !== null)) return;

    event.preventDefault();
    if (event.dataTransfer) {
      // A native drag-out only offers copy | link; the drop still moves.
      event.dataTransfer.dropEffect = getActiveNativeWorkspaceDrag() ? 'copy' : 'move';
    }
    clearDropHighlight(host);
    row.classList.add(DROP_TARGET_CLASS);
  });

  host.addEventListener('dragleave', (event) => {
    const row = folderRowFromTarget(event.target);
    if (row) {
      const related = event.relatedTarget;
      if (related instanceof Node && row.contains(related)) return;
      row.classList.remove(DROP_TARGET_CLASS);
      return;
    }
    if (event.target === host) {
      host.classList.remove(HOST_DROP_CLASS);
    }
  });

  host.addEventListener('drop', (event) => {
    clearDropHighlight(host);
    if (moveInFlight || !getLocalServerAvailable()) return;
    if (!hasTreeDrag(event.dataTransfer)) return;

    event.preventDefault();
    event.stopPropagation();

    if (hasExternalDrag(event.dataTransfer)) {
      const row = folderRowFromTarget(event.target);
      const destDir = row?.dataset.path ?? '.';
      dropHandled = true;
      void handleExternalTreeDrop(event, destDir);
      return;
    }

    if (!hasWorkspaceDrag(event.dataTransfer)) return;

    const row = folderRowFromTarget(event.target);
    if (!row?.dataset.path) return;

    void handleTreeDrop(event, row);
  });

  host.addEventListener('dragend', (event) => {
    const sources = dragSourcePaths();
    if (!dropHandled && sources.length > 0) {
      const under = (typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(event.clientX, event.clientY)
        : null) as HTMLElement | null;
      const destRow = (under?.closest('.file-tree-row--dir') as HTMLElement | null) ?? null;
      if (
        destRow?.dataset.path &&
        host.contains(destRow) &&
        getLocalServerAvailable() &&
        !moveInFlight
      ) {
        void performTreeMove(sources, destRow.dataset.path);
      }
    }

    activeDragSourcePath = null;
    activeDragSourcePaths = [];
    dropHandled = false;
    clearDropHighlight(host);
  });
}

/**
 * Wire folder drop targets on the file tree host (idempotent).
 */
export function initFileTreeDnD(): void {
  const host = document.getElementById('fileTreeHost');
  if (!host || host === hostBound) return;
  hostBound = host;
  bindHost(host);
}

/** Clear binding state (tests). */
export function resetFileTreeDnDForTests(): void {
  hostBound = null;
  moveInFlight = false;
  activeDragSourcePath = null;
  activeDragSourcePaths = [];
  dropHandled = false;
}
