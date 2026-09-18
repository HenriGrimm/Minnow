/**
 * Native OS drag-out for workspace files (Electron).
 *
 * A tree row drag is handed to `webContents.startDrag`, which replaces the HTML5
 * drag with a real OS file drag — Explorer, Finder, the desktop and other apps
 * receive the files. The catch: when that drag comes back over Minnow it only
 * carries `Files`, not the workspace MIME. This module remembers the session so
 * in-app targets (tree move, composer, terminal, Issues capture) still read it as
 * a workspace drag, and keeps unhandled spots from treating it as an OS import
 * (CodeMirror would paste file contents, Chromium would navigate to the file).
 */

export interface NativeWorkspaceDrag {
  /** Workspace-relative tree paths, as the drag source knows them. */
  paths: string[];
}

let active: NativeWorkspaceDrag | null = null;
let endCallbacks: Array<() => void> = [];
let unbindSession: (() => void) | null = null;

/** True when the Electron preload can start a native file drag. */
export function isNativeFileDragAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.minnow?.shell?.startFileDrag === 'function';
}

/** The native drag Minnow started, or null. */
export function getActiveNativeWorkspaceDrag(): NativeWorkspaceDrag | null {
  return active;
}

function fileItemCount(dataTransfer: DataTransfer): number | null {
  const items = dataTransfer.items;
  if (!items || typeof items.length !== 'number') return null;
  let count = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]?.kind === 'file') count += 1;
  }
  return count;
}

/**
 * True when this drag is Minnow's own native drag coming back over the window.
 * The file count must match, so an Explorer drag during a stale session is not
 * mistaken for a workspace drag.
 */
export function isNativeWorkspaceDrag(dataTransfer: DataTransfer | null): boolean {
  if (!active || !dataTransfer) return false;
  if (!Array.from(dataTransfer.types ?? []).includes('Files')) return false;
  const count = fileItemCount(dataTransfer);
  return count === null || count === 0 || count === active.paths.length;
}

/** First workspace path of the active native drag when `dataTransfer` is that drag. */
export function nativeWorkspaceDragPath(dataTransfer: DataTransfer | null): string | null {
  if (!isNativeWorkspaceDrag(dataTransfer)) return null;
  return active?.paths[0] ?? null;
}

/** End the session and notify the drag source. Idempotent. */
export function endNativeWorkspaceDrag(): void {
  if (!active) return;
  active = null;
  const callbacks = endCallbacks;
  endCallbacks = [];
  unbindSession?.();
  unbindSession = null;
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
    }
  }
}

/**
 * Replace an HTML5 `dragstart` with a native OS drag of `paths` (relative to
 * `root`). Returns false — leaving the HTML5 drag untouched — when not running
 * in Electron or the main process could not resolve the paths.
 */
export function startNativeWorkspaceDrag(
  event: DragEvent,
  root: string,
  paths: string[],
  onEnd?: () => void,
): boolean {
  if (!isNativeFileDragAvailable() || !root.trim() || paths.length === 0) return false;
  endNativeWorkspaceDrag();
  if (!window.minnow!.shell!.startFileDrag!(root, paths)) return false;

  event.preventDefault();
  active = { paths: [...paths] };
  endCallbacks = onEnd ? [onEnd] : [];
  unbindSession = bindSessionListeners();
  return true;
}

// ── Session listeners ────────────────────────────────────────────────────────

function isEditableCodeMirror(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const editor = target.closest('.cm-editor');
  const content = editor?.querySelector('.cm-content');
  if (!(editor instanceof HTMLElement) || content?.getAttribute('contenteditable') !== 'true') {
    return null;
  }
  return editor;
}

function textFieldTarget(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement && !target.readOnly && !target.disabled) return target;
  if (
    target instanceof HTMLInputElement &&
    !target.readOnly &&
    !target.disabled &&
    ['text', 'search', 'url', ''].includes(target.type)
  ) {
    return target;
  }
  return null;
}

/** Same result as the HTML5 drag's `text/plain`: the path lands at the caret. */
function insertIntoTextField(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
}

async function insertIntoCodeMirror(editor: HTMLElement, event: DragEvent, text: string): Promise<void> {
  const { EditorView } = await import('@codemirror/view');
  const view = EditorView.findFromDOM(editor);
  if (!view) return;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  view.focus();
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: 'input.drop',
  });
}

function bindSessionListeners(): () => void {
  const onFileDragEnded = window.minnow?.shell?.onFileDragEnded?.(() => endNativeWorkspaceDrag());

  // Capture: CodeMirror reads dropped files as text, so answer before it does.
  const onEditorDragOver = (event: DragEvent): void => {
    if (!isNativeWorkspaceDrag(event.dataTransfer) || !isEditableCodeMirror(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onEditorDrop = (event: DragEvent): void => {
    const editor = isEditableCodeMirror(event.target);
    const path = nativeWorkspaceDragPath(event.dataTransfer);
    if (!editor || !path) return;
    event.preventDefault();
    event.stopPropagation();
    void insertIntoCodeMirror(editor, event, path);
  };

  // Bubble: whatever no in-app target claimed.
  const onUnclaimedDragOver = (event: DragEvent): void => {
    if (event.defaultPrevented || !isNativeWorkspaceDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = textFieldTarget(event.target) ? 'copy' : 'none';
    }
  };
  const onUnclaimedDrop = (event: DragEvent): void => {
    if (!isNativeWorkspaceDrag(event.dataTransfer)) return;
    if (!event.defaultPrevented) {
      event.preventDefault();
      const field = textFieldTarget(event.target);
      const path = active?.paths[0];
      if (field && path) insertIntoTextField(field, path);
    }
  };

  // In-app targets stop propagation, so watch every drop from the top.
  const onAnyDrop = (event: DragEvent): void => {
    if (isNativeWorkspaceDrag(event.dataTransfer)) scheduleEnd();
  };

  // A drop outside the window never reaches the page. Windows and Linux report
  // the end over IPC; macOS does not, so there the button coming back up or focus
  // moving to another app ends it. A new press ends it everywhere.
  const macOS = window.minnow?.app?.platform === 'darwin';
  const onPointerMove = (event: MouseEvent): void => {
    if (event.buttons === 0) endNativeWorkspaceDrag();
  };
  const onEnd = (): void => endNativeWorkspaceDrag();

  window.addEventListener('drop', onAnyDrop, true);
  document.addEventListener('dragover', onEditorDragOver, true);
  document.addEventListener('drop', onEditorDrop, true);
  document.addEventListener('dragover', onUnclaimedDragOver);
  document.addEventListener('drop', onUnclaimedDrop);
  window.addEventListener('mousedown', onEnd, true);
  if (macOS) {
    window.addEventListener('mousemove', onPointerMove, true);
    window.addEventListener('blur', onEnd);
  }

  return () => {
    onFileDragEnded?.();
    window.removeEventListener('drop', onAnyDrop, true);
    document.removeEventListener('dragover', onEditorDragOver, true);
    document.removeEventListener('drop', onEditorDrop, true);
    document.removeEventListener('dragover', onUnclaimedDragOver);
    document.removeEventListener('drop', onUnclaimedDrop);
    window.removeEventListener('mousemove', onPointerMove, true);
    window.removeEventListener('mousedown', onEnd, true);
    window.removeEventListener('blur', onEnd);
  };
}

/** Drop handlers read the session synchronously; end it once they have all run. */
function scheduleEnd(): void {
  const session = active;
  setTimeout(() => {
    if (active === session) endNativeWorkspaceDrag();
  }, 0);
}

/** Reset module state (tests). */
export function resetNativeFileDragForTests(): void {
  unbindSession?.();
  unbindSession = null;
  active = null;
  endCallbacks = [];
}
