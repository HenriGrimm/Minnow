import { addCodeReferenceToComposer } from '../attachments/code-ref';
import { parseCodeSelectionDragData } from '../attachments/code-selection-drag';
import { addAttachments } from '../attachments/store';
import {
  classifyFileDrag,
  filesFromDataTransfer,
  hasWorkspaceFileDrag,
  readWorkspaceDragPath,
} from '../attachments/external-file-drop';
import { hasTabDrag, parseTabDragData, endTabDrag } from '../attachments/tab-drag';
import { addChatLinkToActiveChat } from '../chat/links';
import { getActiveComposerSurface } from './composer-surface';
import { attachWorkspacePathToComposer } from './workspace-composer-link';
import { syncChatLinkChipsFromActiveChat } from './chat-link-chips';

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
function hasComposerDrag(dataTransfer: DataTransfer | null): boolean {
  if (hasTabDrag(dataTransfer)) return true;
  return classifyFileDrag(dataTransfer) !== null;
}

/** Pin a dropped editor/browser tab as a standing chat link chip. */
function applyTabDrop(dataTransfer: DataTransfer): boolean {
  const payload = parseTabDragData(dataTransfer);
  endTabDrag();
  if (!payload) return false;
  const link =
    payload.kind === 'file'
      ? addChatLinkToActiveChat({
          kind: 'file',
          path: payload.path,
          label: payload.label,
        })
      : addChatLinkToActiveChat({
          kind: 'url',
          url: payload.url,
          label: payload.label,
        });
  if (!link) return false;
  syncChatLinkChipsFromActiveChat();
  return true;
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
): void {
  if (element.dataset.composerDropBound === '1') return;
  element.dataset.composerDropBound = '1';
  let dragDepth = 0;

  element.addEventListener('dragenter', (event) => {
    if (!hasComposerDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    setDropActive(dropTargets, true);
  });

  element.addEventListener('dragover', (event) => {
    if (!hasComposerDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setDropActive(dropTargets, true);
  });

  element.addEventListener('dragleave', (event) => {
    if (!hasComposerDrag(event.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      setDropActive(dropTargets, false);
    }
  });

  element.addEventListener('drop', (event) => {
    const tabDrag = hasTabDrag(event.dataTransfer);
    const kind = tabDrag ? 'tabLink' : classifyFileDrag(event.dataTransfer);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    setDropActive(dropTargets, false);

    if (kind === 'tabLink' && event.dataTransfer) {
      applyTabDrop(event.dataTransfer);
      return;
    }

    if (kind === 'external' && event.dataTransfer) {
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length) {
        void addAttachments(files);
      }
      return;
    }

    if (kind === 'codeSelection' && event.dataTransfer) {
      const payload = parseCodeSelectionDragData(event.dataTransfer);
      if (payload) {
        addCodeReferenceToComposer(payload);
      }
      return;
    }

    if (event.dataTransfer && hasWorkspaceFileDrag(event.dataTransfer)) {
      const path = readWorkspaceDragPath(event.dataTransfer);
      if (path) {
        const input = resolveComposerInputFromDropTarget(event.currentTarget as HTMLElement);
        attachWorkspacePathToComposer(path, input);
      }
    }
  });
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
