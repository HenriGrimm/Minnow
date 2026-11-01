import { adoptControls } from './components';
import { basename, joinTreePath } from './file-tree-path';

export interface MoveConfirmDialogOptions {
  source: string;
  destinationDir: string;
  sourceKind: 'file' | 'dir';
}

const CONFIRM_ID = 'fileTreeMoveConfirm';

let bannerEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let pathsEl: HTMLElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;

function getSidebarHost(): HTMLElement | null {
  return document.getElementById('fileSidebar');
}

function bindBannerElements(root: HTMLElement): void {
  bannerEl = root;
  titleEl = root.querySelector('[data-move-title]');
  bodyEl = root.querySelector('[data-move-body]');
  pathsEl = root.querySelector('[data-move-paths]');
  confirmBtn = root.querySelector('[data-move-confirm]');
  cancelBtn = root.querySelector('[data-move-cancel]');
}

function ensureBanner(): void {
  if (bannerEl) return;

  const existing = document.getElementById(CONFIRM_ID);
  if (existing instanceof HTMLElement) {
    bindBannerElements(existing);
    return;
  }

  const host = getSidebarHost();
  if (!host) return;

  const banner = document.createElement('div');
  banner.id = CONFIRM_ID;
  banner.className = 'file-tree-move-confirm hidden';
  banner.hidden = true;
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-labelledby', 'fileTreeMoveConfirmTitle');
  banner.innerHTML = `
    <div class="file-tree-move-confirm__content">
      <p id="fileTreeMoveConfirmTitle" class="file-tree-move-confirm__title" data-move-title>Move file?</p>
      <p class="file-tree-move-confirm__body" data-move-body></p>
      <p class="file-tree-move-confirm__paths" data-move-paths></p>
    </div>
    <div class="file-tree-move-confirm__actions">
      <button type="button" class="file-tree-move-confirm__btn" data-move-cancel>Cancel</button>
      <button type="button" class="file-tree-move-confirm__btn file-tree-move-confirm__btn--primary" data-move-confirm>Move</button>
    </div>
  `;
  adoptControls(banner, { appearance: 'surface', variants: {"primary":".file-tree-move-confirm__btn--primary"} });

  const treeHost = document.getElementById('fileTreeHost');
  if (treeHost) {
    host.insertBefore(banner, treeHost);
  } else {
    host.appendChild(banner);
  }

  bindBannerElements(banner);
}

function showBanner(): void {
  if (!bannerEl) return;
  bannerEl.hidden = false;
  bannerEl.classList.remove('hidden');
}

function hideBanner(): void {
  if (!bannerEl) return;
  bannerEl.hidden = true;
  bannerEl.classList.add('hidden');
}

/** Ask the user to confirm moving `source` into `destinationDir`. */
export function showMoveConfirmDialog(
  opts: MoveConfirmDialogOptions,
): Promise<boolean> {
  ensureBanner();
  if (!bannerEl || !titleEl || !bodyEl || !pathsEl || !confirmBtn || !cancelBtn) {
    return Promise.resolve(false);
  }

  const destDisplay = opts.destinationDir === '.' ? './' : `${opts.destinationDir}/`;
  const destination = joinTreePath(opts.destinationDir, basename(opts.source));

  titleEl.textContent =
    opts.sourceKind === 'dir' ? 'Move folder?' : 'Move file?';
  bodyEl.innerHTML = `Move <strong>${basename(opts.source)}</strong> into <strong>${destDisplay}</strong>?`;
  pathsEl.textContent = `${opts.source} → ${destination}`;

  const confirmButton = confirmBtn;
  const cancelButton = cancelBtn;

  return new Promise((resolve) => {
    let settled = false;

    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      hideBanner();
      document.removeEventListener('keydown', onKeyDown);
      cancelButton.removeEventListener('click', onCancel);
      confirmButton.removeEventListener('click', onConfirm);
      resolve(confirmed);
    };

    const onCancel = (): void => finish(false);
    const onConfirm = (): void => finish(true);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    };

    cancelButton.addEventListener('click', onCancel);
    confirmButton.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKeyDown);

    showBanner();
    confirmButton.focus();
  });
}

/** Reset banner singleton (tests). */
export function resetMoveConfirmDialogForTests(): void {
  hideBanner();
  bannerEl = null;
  titleEl = null;
  bodyEl = null;
  pathsEl = null;
  confirmBtn = null;
  cancelBtn = null;
}
