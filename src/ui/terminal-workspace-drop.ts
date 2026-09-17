import { hasWorkspaceFileDrag, readWorkspaceDragPath } from '../attachments/external-file-drop';
import { insertTextAtTerminalInput } from './terminal-xterm';

const DROP_ACTIVE_CLASS = 'terminal-xterm-host--drop-active';

/**
 * Wire dragover/drop on the outer xterm host (#terminalXtermHost). Idempotent.
 */
export function initTerminalWorkspaceDrop(host: HTMLElement): void {
  if (host.dataset.terminalWorkspaceDropBound === '1') return;
  host.dataset.terminalWorkspaceDropBound = '1';

  let dragDepth = 0;

  host.addEventListener('dragenter', (event) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    host.classList.add(DROP_ACTIVE_CLASS);
  });

  host.addEventListener('dragover', (event) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    host.classList.add(DROP_ACTIVE_CLASS);
  });

  host.addEventListener('dragleave', (event) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      host.classList.remove(DROP_ACTIVE_CLASS);
    }
  });

  host.addEventListener('drop', (event) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    host.classList.remove(DROP_ACTIVE_CLASS);

    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const path = readWorkspaceDragPath(dataTransfer);
    if (!path) return;
    insertTextAtTerminalInput(path);
  });
}
