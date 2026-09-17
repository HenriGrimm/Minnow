import {
  CODE_SELECTION_MIME,
  parseCodeSelectionDragData,
} from '../attachments/code-selection-drag';
import { WORKSPACE_FILE_MIME } from '../attachments/workspace-ref';
import {
  getActiveNativeWorkspaceDrag,
  isNativeWorkspaceDrag,
} from '../attachments/native-file-drag';
import {
  ISSUE_CAPTURE_MIME,
  parseCaptureDragData,
  setCaptureDragData,
  type CapturePayload,
} from '../issues/capture-payload';
import { formatCodeRefLabel } from '../attachments/code-ref-format';
import { CHAT_DRAG_MIME } from '../attachments/chat-drag';
import { ISSUE_DRAG_MIME, dataTransferHasIssueDrag } from '../issues/issue-drag';

/** Active drag, or null. Read by drop targets during `dragover`. */
let activeDrag: CapturePayload | null = null;
let layerBound = false;

type Listener = (payload: CapturePayload | null) => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener(activeDrag);
    } catch {
    }
  }
}

/** Subscribe to drag start/end. Fires immediately with the current state. */
export function subscribeCaptureDrag(listener: Listener): () => void {
  listeners.add(listener);
  listener(activeDrag);
  return () => {
    listeners.delete(listener);
  };
}

/** The capture currently being dragged, or null. */
export function getActiveCaptureDrag(): CapturePayload | null {
  return activeDrag;
}

/** True while something droppable on an issue is in flight. */
export function isCaptureDragActive(): boolean {
  return activeDrag !== null;
}

/** Start a capture drag from a surface that built its own payload. */
export function beginCaptureDrag(
  dataTransfer: DataTransfer | null,
  payload: CapturePayload,
): void {
  if (dataTransfer) setCaptureDragData(dataTransfer, payload);
  activeDrag = payload;
  notify();
}

/** Clear the descriptor. Called on `dragend` and `drop`. */
export function endCaptureDrag(): void {
  if (!activeDrag) return;
  activeDrag = null;
  notify();
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function workspaceFilePayload(path: string): CapturePayload {
  return {
    sourceLabel: 'Workspace file',
    items: [
      {
        kind: 'file',
        label: basename(path),
        detail: path,
        codeRef: { path },
      },
    ],
  };
}

/** Optional chat-title resolver wired at boot (keeps sessions off this import graph). */
type ChatTitleLookup = (chatId: string) => string | null;
let chatTitleLookup: ChatTitleLookup | null = null;

/** Wire chat title lookup from the shell after sessions is available. */
export function registerCaptureChatTitleLookup(lookup: ChatTitleLookup): void {
  chatTitleLookup = lookup;
}

function chatLabelForId(chatId: string): string {
  const looked = chatTitleLookup?.(chatId)?.trim();
  if (looked) return looked;
  return 'Chat';
}

/** Plain-text drags Minnow uses internally — not user selections. */
function isInternalPlainTextPayload(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('file:') || trimmed.startsWith('preview:');
}

/** `text/plain` can mean a real selection or a filename on an OS file drag. */
function hasCapturablePlainText(types: readonly string[]): boolean {
  if (!types.includes('text/plain')) return false;
  if (types.includes('Files')) return false;
  if (types.includes(ISSUE_CAPTURE_MIME)) return false;
  if (types.includes(CODE_SELECTION_MIME)) return false;
  if (types.includes(WORKSPACE_FILE_MIME)) return false;
  if (types.includes(CHAT_DRAG_MIME)) return false;
  if (types.includes(ISSUE_DRAG_MIME)) return false;
  return true;
}

/** Build a capture payload out of a drag that was not started for us. */
export function capturePayloadFromDataTransfer(
  dataTransfer: DataTransfer | null,
): CapturePayload | null {
  if (!dataTransfer) return null;
  // Issue-row drags also set text/plain (the ids). Do not capture them.
  if (dataTransferHasIssueDrag(dataTransfer)) return null;

  const own = parseCaptureDragData(dataTransfer);
  if (own) return own;

  // A native drag-out only carries Files; the session knows which tree row it was.
  const native = getActiveNativeWorkspaceDrag();
  if (native && isNativeWorkspaceDrag(dataTransfer)) {
    return native.paths[0] ? workspaceFilePayload(native.paths[0]) : null;
  }

  const types = Array.from(dataTransfer.types);

  if (types.includes(CODE_SELECTION_MIME)) {
    const selection = parseCodeSelectionDragData(dataTransfer);
    if (selection) {
      const label = formatCodeRefLabel(
        selection.workspacePath,
        selection.startLine,
        selection.endLine,
      );
      return {
        sourceLabel: 'Editor selection',
        workspacePath: undefined,
        items: [
          {
            kind: 'code',
            label,
            codeRef: {
              path: selection.workspacePath,
              startLine: selection.startLine,
              endLine: selection.endLine,
              snippet: selection.text.slice(0, 2000),
            },
            text: selection.text,
          },
        ],
      };
    }
  }

  if (types.includes(WORKSPACE_FILE_MIME)) {
    const path = dataTransfer.getData(WORKSPACE_FILE_MIME).trim();
    if (path) return workspaceFilePayload(path);
  }

  if (types.includes(CHAT_DRAG_MIME)) {
    const chatId = dataTransfer.getData(CHAT_DRAG_MIME).trim();
    if (chatId) {
      return {
        sourceLabel: 'Chat',
        items: [
          {
            kind: 'chat',
            label: chatLabelForId(chatId),
            chatId,
          },
        ],
      };
    }
  }

  if (hasCapturablePlainText(types)) {
    const text = dataTransfer.getData('text/plain');
    if (!text.trim() || isInternalPlainTextPayload(text)) return null;
    const firstLine = text.split('\n').find((line) => line.trim())?.trim() ?? text.trim();
    return {
      sourceLabel: 'Selection',
      title: firstLine,
      items: [{ kind: 'text', label: 'Selection', text }],
    };
  }

  return null;
}

/** True when a drag *might* be capturable, judged from types alone (dragover-safe). */
export function dataTransferLooksCapturable(dataTransfer: DataTransfer | null): boolean {
  if (dataTransferHasIssueDrag(dataTransfer)) return false;
  if (isCaptureDragActive()) return true;
  if (!dataTransfer) return false;
  if (isNativeWorkspaceDrag(dataTransfer)) return true;
  const types = Array.from(dataTransfer.types);
  return (
    types.includes(ISSUE_CAPTURE_MIME) ||
    types.includes(CODE_SELECTION_MIME) ||
    types.includes(WORKSPACE_FILE_MIME) ||
    types.includes(CHAT_DRAG_MIME) ||
    hasCapturablePlainText(types)
  );
}

/** Bind the document-level listeners once. */
export function initCaptureDragLayer(): void {
  if (layerBound || typeof document === 'undefined') return;
  layerBound = true;

  document.addEventListener('dragstart', (event) => {
    if (activeDrag) return;
    const payload = capturePayloadFromDataTransfer(event.dataTransfer);
    if (!payload) return;
    activeDrag = payload;
    document.documentElement.classList.add('mn-capture-dragging');
    notify();
  });

  const clear = (): void => {
    document.documentElement.classList.remove('mn-capture-dragging');
    endCaptureDrag();
  };
  document.addEventListener('dragend', clear);
  document.addEventListener('drop', clear);
}

/** Reset module state (tests). */
export function resetCaptureDragForTests(): void {
  activeDrag = null;
  layerBound = false;
  listeners.clear();
  chatTitleLookup = null;
}
