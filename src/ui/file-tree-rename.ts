import { createTextInput, setControlClassName } from './components';
import { setStatus } from './status';
import { basename, normalizeTreePath } from './file-tree-path';
import type { FileTreeEntryKind } from './file-tree-ops';
import { commitRename } from './file-tree-ops';

let activeRenamePath: string | null = null;

/** True while a tree row shows the rename input. */
export function isFileTreeRenameActive(): boolean {
  return activeRenamePath !== null;
}

function restoreLabelClass(row: HTMLElement): string {
  const flat = row.classList.contains('file-tree-row--flat');
  return flat ? 'file-tree-label file-tree-label--flat' : 'file-tree-label';
}

function buildLabelElement(
  row: HTMLElement,
  path: string,
  displayName: string,
): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = restoreLabelClass(row);
  const norm = normalizeTreePath(path);
  if (row.classList.contains('file-tree-row--flat') && norm.includes('/')) {
    const parentPath = norm.slice(0, norm.length - displayName.length - 1);
    const parentSpan = document.createElement('span');
    parentSpan.className = 'file-tree-path-parent';
    parentSpan.textContent = `${parentPath}/`;
    const baseSpan = document.createElement('span');
    baseSpan.className = 'file-tree-path-base';
    baseSpan.textContent = displayName;
    label.appendChild(parentSpan);
    label.appendChild(baseSpan);
  } else {
    label.textContent = displayName;
  }
  return label;
}

function findTreeRow(path: string): HTMLElement | null {
  const norm = normalizeTreePath(path);
  return document.querySelector<HTMLElement>(
    `.file-tree-row[data-path="${CSS.escape(norm)}"]`,
  );
}

function labelDisplayName(label: Element, path: string): string {
  const baseSpan = label.querySelector('.file-tree-path-base');
  if (baseSpan?.textContent) return baseSpan.textContent;
  const text = label.textContent?.trim();
  if (text) return text;
  return basename(path);
}

/** Cancel an in-progress inline rename and restore the row label. */
export function cancelInlineRename(showStatus = true): void {
  const path = activeRenamePath;
  if (!path) return;
  activeRenamePath = null;
  const row = findTreeRow(path);
  if (!row) return;
  const input = row.querySelector('.file-tree-rename-input');
  if (!input) return;
  const displayName = basename(path);
  input.replaceWith(buildLabelElement(row, path, displayName));
  if (showStatus) {
    setStatus('idle', 'Rename cancelled');
  }
}

/** Replace the row label with an input; commit via commitRename on Enter/blur. */
export function startInlineRename(path: string, kind: FileTreeEntryKind): void {
  void import('./file-tree-create').then((m) => m.cancelInlineCreate(false));

  const norm = normalizeTreePath(path);
  if (activeRenamePath && activeRenamePath !== norm) {
    cancelInlineRename(false);
  }
  if (activeRenamePath === norm) return;

  const row = findTreeRow(norm);
  if (!row) {
    setStatus(
      'err',
      'Could not find that item in the tree. Clear the filter or scroll it into view.',
    );
    return;
  }

  const label = row.querySelector('.file-tree-label');
  if (!label) return;

  const currentName = labelDisplayName(label, norm);
  const inp = createTextInput({ appearance: 'surface', type: 'text' });
  inp.type = 'text';
  setControlClassName(inp, 'file-tree-rename-input');
  inp.value = currentName;
  inp.maxLength = 255;
  inp.setAttribute(
    'aria-label',
    kind === 'dir' ? 'New folder name' : 'New file name',
  );

  const stopRowPointer = (e: Event) => {
    e.stopPropagation();
  };
  inp.addEventListener('mousedown', stopRowPointer);
  inp.addEventListener('click', stopRowPointer);
  inp.addEventListener('dblclick', stopRowPointer);

  label.replaceWith(inp);
  activeRenamePath = norm;
  inp.focus();
  inp.select();

  let finished = false;

  const restoreRowLabel = () => {
    const input = row.querySelector('.file-tree-rename-input');
    if (!input) return;
    input.replaceWith(buildLabelElement(row, norm, currentName));
  };

  const finish = (cancelled: boolean) => {
    if (finished) return;
    finished = true;
    activeRenamePath = null;

    if (cancelled) {
      restoreRowLabel();
      setStatus('idle', 'Rename cancelled');
      return;
    }

    const nextValue = inp.value;
    restoreRowLabel();
    void commitRename(norm, kind, nextValue);
  };

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
      return;
    }
    e.stopPropagation();
  });

  inp.addEventListener('blur', () => {
    if (!finished) finish(false);
  });
}
