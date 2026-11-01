import { createTextInput, setControlClassName } from './components';
import { getFilterQuery } from './file-tree-filter';
import { getFilePanelState } from '../state/file-panel';
import { setStatus } from './status';
import { normalizeTreePath } from './file-tree-path';
import {
  dirRowPaddingLeftPx,
  fileRowPaddingLeftPx,
} from './file-tree-indent';
import { commitCreate, type FileTreeEntryKind } from './file-tree-ops';

const CREATE_ROW_CLASS = 'file-tree-row--creating';
const CREATE_INPUT_CLASS = 'file-tree-rename-input';

let activeCreateParent: string | null = null;
let activeCreateRow: HTMLElement | null = null;

// ── State ────────────────────────────────────────────────────────────────────

/** True while the tree shows the new file/folder name input. */
export function isFileTreeCreateActive(): boolean {
  return activeCreateParent !== null;
}

function childDepth(parentDir: string): number {
  const norm = normalizeTreePath(parentDir);
  return norm === '.' ? 0 : norm.split('/').filter(Boolean).length;
}

function removeCreateRow(): void {
  activeCreateRow?.remove();
  activeCreateRow = null;
  activeCreateParent = null;
}

/** Cancel an in-progress inline create and remove the phantom row. */
export function cancelInlineCreate(showStatus = true): void {
  if (!activeCreateParent) return;
  removeCreateRow();
  if (showStatus) {
    setStatus('idle', 'Create cancelled');
  }
}

// ── Row ──────────────────────────────────────────────────────────────────────

function buildCreateRow(kind: FileTreeEntryKind, depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className =
    `file-tree-row file-tree-row--${kind === 'dir' ? 'dir' : 'file'} ${CREATE_ROW_CLASS}`;
  row.setAttribute('role', 'treeitem');
  row.dataset.creating = 'true';

  if (kind === 'dir') {
    row.style.paddingLeft = `${dirRowPaddingLeftPx(depth)}px`;
    const expandSpacer = document.createElement('span');
    expandSpacer.className = 'file-tree-expand';
    expandSpacer.setAttribute('role', 'presentation');
    expandSpacer.setAttribute('aria-hidden', 'true');
    row.appendChild(expandSpacer);
  } else {
    row.style.paddingLeft = `${fileRowPaddingLeftPx(depth)}px`;
  }

  const inp = createTextInput({ appearance: 'surface', type: 'text' });
  inp.type = 'text';
  setControlClassName(inp, CREATE_INPUT_CLASS);
  inp.value = kind === 'dir' ? 'new-folder' : 'untitled.txt';
  inp.maxLength = 255;
  inp.setAttribute(
    'aria-label',
    kind === 'dir' ? 'New folder name' : 'New file name',
  );
  row.appendChild(inp);
  return row;
}

function findChildrenHost(parentDir: string): HTMLElement | null {
  const norm = normalizeTreePath(parentDir);
  const treeHost = document.getElementById('fileTreeHost');
  if (!treeHost) return null;

  const root = normalizeTreePath(getFilePanelState().treeRoot || '.');
  if (norm === '.' || norm === root) {
    return treeHost;
  }

  const row = treeHost.querySelector<HTMLElement>(
    `.file-tree-row[data-path="${CSS.escape(norm)}"]`,
  );
  if (!row) return null;

  let sibling = row.nextElementSibling;
  while (sibling) {
    if (sibling.classList.contains('file-tree-children')) {
      return sibling as HTMLElement;
    }
    if (sibling.classList.contains('file-tree-row')) break;
    sibling = sibling.nextElementSibling;
  }
  return null;
}

// ── Start ────────────────────────────────────────────────────────────────────

/** Expand parent if needed, then show an inline name field for a new file or folder. */
export async function startInlineCreate(
  parentDir: string,
  kind: FileTreeEntryKind,
): Promise<void> {
  if (getFilterQuery().trim()) {
    setStatus(
      'err',
      'Clear the file filter to create files or folders.',
    );
    return;
  }

  void import('./file-tree-rename').then((m) => m.cancelInlineRename(false));

  const normParent = normalizeTreePath(parentDir);

  if (activeCreateParent && activeCreateParent !== normParent) {
    cancelInlineCreate(false);
  }
  if (activeCreateParent === normParent) {
    const existing = document.querySelector(
      `.${CREATE_ROW_CLASS} .${CREATE_INPUT_CLASS}`,
    ) as HTMLInputElement | null;
    existing?.focus();
    existing?.select();
    return;
  }

  const { expandDir } = await import('./file-tree');
  if (normParent !== '.') {
    const expanded = getFilePanelState().expandedDirs.includes(normParent);
    if (!expanded) {
      await expandDir(normParent);
    }
  }

  const host = findChildrenHost(normParent);
  if (!host) {
    setStatus(
      'err',
      'Could not find that folder in the tree. Expand it or refresh the tree.',
    );
    return;
  }

  removeCreateRow();

  const depth = childDepth(normParent);
  const row = buildCreateRow(kind, depth);
  const inp = row.querySelector(`.${CREATE_INPUT_CLASS}`) as HTMLInputElement;
  host.appendChild(row);
  activeCreateParent = normParent;
  activeCreateRow = row;

  const stopRowPointer = (e: Event) => {
    e.stopPropagation();
  };
  inp.addEventListener('mousedown', stopRowPointer);
  inp.addEventListener('click', stopRowPointer);
  inp.addEventListener('dblclick', stopRowPointer);

  let ignoreBlur = true;
  requestAnimationFrame(() => {
    inp.focus();
    inp.select();
    requestAnimationFrame(() => {
      ignoreBlur = false;
    });
  });

  let finished = false;

  const finish = (cancelled: boolean) => {
    if (finished) return;
    finished = true;
    const parent = activeCreateParent;
    removeCreateRow();

    if (cancelled) {
      setStatus('idle', 'Create cancelled');
      return;
    }
    if (!parent) return;
    void commitCreate(parent, kind, inp.value);
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
    if (ignoreBlur || finished) return;
    finish(false);
  });
}
