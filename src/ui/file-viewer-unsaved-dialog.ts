import { adoptControls } from './components';
export type ViewerUnsavedChoice = 'save' | 'discard' | 'cancel';

const DIALOG_ID = 'fileViewerUnsavedDialog';

let dialogEl: HTMLElement | null = null;
let messageEl: HTMLElement | null = null;
let saveBtn: HTMLButtonElement | null = null;
let discardBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;

function ensureDialog(): void {
  if (dialogEl) return;

  const existing = document.getElementById(DIALOG_ID);
  if (existing instanceof HTMLElement) {
    dialogEl = existing;
    messageEl = existing.querySelector('[data-unsaved-message]');
    saveBtn = existing.querySelector('[data-unsaved-save]');
    discardBtn = existing.querySelector('[data-unsaved-discard]');
    cancelBtn = existing.querySelector('[data-unsaved-cancel]');
    return;
  }

  const host =
    document.getElementById('fileViewerPane') ??
    document.getElementById('workspaceSplit') ??
    document.body;

  const overlay = document.createElement('div');
  overlay.id = DIALOG_ID;
  overlay.className = 'file-viewer-unsaved-dialog hidden';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'fileViewerUnsavedTitle');
  overlay.innerHTML = `
    <div class="file-viewer-unsaved-dialog__panel">
      <p id="fileViewerUnsavedTitle" class="file-viewer-unsaved-dialog__title">Unsaved changes</p>
      <p class="file-viewer-unsaved-dialog__message" data-unsaved-message></p>
      <div class="file-viewer-unsaved-dialog__actions">
        <button type="button" class="file-viewer-unsaved-dialog__btn" data-unsaved-cancel>Cancel</button>
        <button type="button" class="file-viewer-unsaved-dialog__btn" data-unsaved-discard>Discard</button>
        <button type="button" class="file-viewer-unsaved-dialog__btn file-viewer-unsaved-dialog__btn--primary" data-unsaved-save>Save</button>
      </div>
    </div>
  `;
  adoptControls(overlay, { appearance: 'surface', variants: {"primary":".file-viewer-unsaved-dialog__btn--primary"} });
  host.appendChild(overlay);

  dialogEl = overlay;
  messageEl = overlay.querySelector('[data-unsaved-message]');
  saveBtn = overlay.querySelector('[data-unsaved-save]');
  discardBtn = overlay.querySelector('[data-unsaved-discard]');
  cancelBtn = overlay.querySelector('[data-unsaved-cancel]');
}

function showDialog(): void {
  if (!dialogEl) return;
  dialogEl.hidden = false;
  dialogEl.classList.remove('hidden');
}

function hideDialog(): void {
  if (!dialogEl) return;
  dialogEl.hidden = true;
  dialogEl.classList.add('hidden');
}

/** Ask whether to save, discard, or cancel when leaving a dirty tab. */
export function showViewerUnsavedDialog(message: string): Promise<ViewerUnsavedChoice> {
  ensureDialog();
  if (!dialogEl || !messageEl || !saveBtn || !discardBtn || !cancelBtn) {
    return Promise.resolve('cancel');
  }

  messageEl.textContent = message;
  showDialog();

  const saveButton = saveBtn;
  const discardButton = discardBtn;
  const cancelButton = cancelBtn;

  return new Promise((resolve) => {
    const finish = (choice: ViewerUnsavedChoice): void => {
      hideDialog();
      cleanup();
      resolve(choice);
    };

    const onSave = (): void => finish('save');
    const onDiscard = (): void => finish('discard');
    const onCancel = (): void => finish('cancel');

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish('cancel');
      }
    };

    const cleanup = (): void => {
      saveButton.removeEventListener('click', onSave);
      discardButton.removeEventListener('click', onDiscard);
      cancelButton.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKeyDown, true);
    };

    saveButton.addEventListener('click', onSave);
    discardButton.addEventListener('click', onDiscard);
    cancelButton.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKeyDown, true);
    cancelButton.focus();
  });
}
