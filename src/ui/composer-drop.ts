import { addCodeReferenceToComposer } from '../attachments/code-ref';
import { parseCodeSelectionDragData } from '../attachments/code-selection-drag';
import { addAttachments } from '../attachments/store';
import {
  classifyFileDrag,
  filesFromDataTransfer,
  readWorkspaceDragPath,
} from '../attachments/external-file-drop';
import { hasTabDrag, parseTabDragData, endTabDrag, type TabDragPayload } from '../attachments/tab-drag';
import { addChatLinkToActiveChat } from '../chat/links';
import { getActiveComposerSurface } from './composer-surface';
import { attachWorkspacePathToComposer } from './workspace-composer-link';
import { syncChatLinkChipsFromActiveChat } from './chat-link-chips';
import { hasChatDrag, insertChatReferenceDraft, readChatReferenceDrag } from './chat-reference-drop';

const DROP_ACTIVE_CLASS = 'composer-drop-active';

// ── Detect ───────────────────────────────────────────────────────────────────

/** Map a drop target element to its composer textarea. */
function resolveComposerInputFromDropTarget(target: HTMLElement): HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target;

  const byId = (id: string): HTMLTextAreaElement | null =>
    document.getElementById(id) as HTMLTextAreaElement | null;

  if (
    target.id === 'desktopInput' ||
    target.closest('.mn-os-desktop-composer, .mn-os-desktop-input-row')
  ) {
    return byId('desktopInput');
  }
  if (target.id === 'chatAppInput' || target.closest('.chat-app-composer')) {
    return byId('chatAppInput');
  }
  if (
    target.id === 'emailAssistantInput' ||
    target.closest('.email-assistant-composer')
  ) {
    return byId('emailAssistantInput');
  }
  if (target.id === 'msgInput' || target.closest('.input-bar, .input-bar-composer')) {
    return byId('msgInput');
  }

  const nested = target.querySelector('textarea');
  if (nested instanceof HTMLTextAreaElement) return nested;

  return getActiveComposerSurface().inputEl;
}

function setDropActive(targets: HTMLElement[], active: boolean): void {
  for (const el of targets) {
    if (active) el.classList.add(DROP_ACTIVE_CLASS);
    else el.classList.remove(DROP_ACTIVE_CLASS);
  }
}

/** True when this drag can land on the composer or chat transcript. */
function composerDragKind(dataTransfer: DataTransfer | null) {
  if (hasChatDrag(dataTransfer)) return 'chatLink';
  if (hasTabDrag(dataTransfer)) return 'tabLink';
  return classifyFileDrag(dataTransfer);
}

/** Pin a dropped editor/browser tab as a standing chat link chip. */
function applyTabDrop(payload: TabDragPayload): void {
  if (addChatLinkToActiveChat(payload)) syncChatLinkChipsFromActiveChat();
}

export type ComposerDrop = (input: HTMLTextAreaElement | null) => void;

/** Capture transfer data synchronously; the browser protects it after drop dispatch. */
function captureComposerDrop(
  transfer: DataTransfer,
  kind: NonNullable<ReturnType<typeof composerDragKind>>,
): ComposerDrop | undefined {
  switch (kind) {
    case 'chatLink': {
      const id = readChatReferenceDrag(transfer);
      if (id) return input => { insertChatReferenceDraft(id, undefined, input); };
      break;
    }
    case 'tabLink': {
      const payload = parseTabDragData(transfer);
      endTabDrag();
      if (payload) return () => applyTabDrop(payload);
      break;
    }
    case 'external': {
      const files = filesFromDataTransfer(transfer);
      if (files.length) return () => { void addAttachments(files); };
      break;
    }
    case 'codeSelection': {
      const payload = parseCodeSelectionDragData(transfer);
      if (payload) return () => addCodeReferenceToComposer(payload);
      break;
    }
    case 'workspace': {
      const path = readWorkspaceDragPath(transfer);
      if (path) return input => attachWorkspacePathToComposer(path, input);
      break;
    }
  }
}

/** One handler per composer surface — nested targets would each see the same bubbling drop. */
function outermostDropTargets(targets: HTMLElement[]): HTMLElement[] {
  return targets.filter(
    (el) => !targets.some((other) => other !== el && other.contains(el)),
  );
}

// ── Bind ─────────────────────────────────────────────────────────────────────

function bindDropTarget(
  element: HTMLElement,
  dropTargets: HTMLElement[],
  openNewThread?: (drop: ComposerDrop) => void,
): void {
  if (element.dataset.composerDropBound === '1') return;
  element.dataset.composerDropBound = '1';
  let dragDepth = 0;

  element.addEventListener('dragenter', (event) => {
    if (!composerDragKind(event.dataTransfer)) return;
    event.preventDefault();
    const input = openNewThread ? null : resolveComposerInputFromDropTarget(element);
    if (input?.disabled || input?.readOnly) return;
    dragDepth += 1;
    setDropActive(dropTargets, true);
  });

  element.addEventListener('dragover', (event) => {
    const kind = composerDragKind(event.dataTransfer);
    if (!kind) return;
    event.preventDefault();
    const input = openNewThread ? null : resolveComposerInputFromDropTarget(element);
    if (input?.disabled || input?.readOnly) { if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = kind === 'chatLink' ? 'link' : 'copy';
    }
    setDropActive(dropTargets, true);
  });

  element.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setDropActive(dropTargets, false);
    }
  });

  element.addEventListener('drop', (event) => {
    dragDepth = 0;
    setDropActive(dropTargets, false);
    const kind = composerDragKind(event.dataTransfer);
    if (!kind || !event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    const input = openNewThread ? null : resolveComposerInputFromDropTarget(element);
    if (input?.disabled || input?.readOnly) return;

    const drop = captureComposerDrop(event.dataTransfer, kind);
    if (!drop) return;
    if (openNewThread) openNewThread(drop);
    else drop(input);
  });
}

/** Route a composer drop to a fresh thread, without consulting the old composer. */
export function bindNewThreadDrop(button: HTMLButtonElement, openNewThread: (drop: ComposerDrop) => void): void {
  bindDropTarget(button, [button], openNewThread);
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wires dragover/drop on Code, Chat app, and desktop composer surfaces. */
export function initComposerDrop(): void {
  const selectors = [
    '#msgInput',
    '.input-bar',
    '.input-bar-composer',
    '#chatAppInput',
    '.chat-app-composer',
    '#chatAppArea',
    '.chat-app-viewport',
    '#chatAppMessageCol',
    '#emailAssistantInput',
    '.email-assistant-composer',
    '#desktopInput',
    '.mn-os-desktop-composer',
    '.mn-os-desktop-input-row',
    '#desktopChatCol',
    '#chatArea',
    '.chat-viewport',
  ];

  const targets: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (el instanceof HTMLElement && !seen.has(el)) {
        seen.add(el);
        targets.push(el);
      }
    }
  }

  if (targets.length === 0) return;

  const dropRoots = outermostDropTargets(targets);
  for (const target of dropRoots) {
    bindDropTarget(target, targets);
  }
}
