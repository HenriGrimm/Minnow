import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { createGitWorktreeIcon, type GitWorktreeIconKind } from './git-worktree-icons';
import { createIcon } from './icon';

const OVERLAY_ID = 'boardRunHelpOverlay';
const DIALOG_ID = 'boardRunHelpLightbox';
const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let overlayEl: HTMLDivElement | null = null;
let dialogEl: HTMLDivElement | null = null;
let isOpen = false;
let previousFocus: HTMLElement | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

/** Whether the run-settings help lightbox is open. */
export function isBoardRunHelpLightboxOpen(): boolean {
  return isOpen;
}

function trapFocus(e: KeyboardEvent): void {
  if (!dialogEl || e.key !== 'Tab') return;
  const nodes = [...dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getAttribute('aria-hidden') !== 'true',
  );
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function detachListeners(): void {
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  document.removeEventListener('keydown', trapFocus, true);
}

function createSetting(title: string, body: string, bullets: string[]): HTMLElement {
  const card = document.createElement('article');
  card.className = 'board-run-help-setting';

  const heading = document.createElement('h3');
  heading.className = 'board-run-help-setting__title';
  heading.textContent = title;

  const text = document.createElement('p');
  text.className = 'board-run-help-setting__body';
  text.textContent = body;

  const list = document.createElement('ul');
  list.className = 'board-run-help-setting__list';
  for (const item of bullets) {
    const li = document.createElement('li');
    li.textContent = item;
    list.appendChild(li);
  }

  card.append(heading, text, list);
  return card;
}

function createIsolationRow(
  icon: GitWorktreeIconKind,
  name: string,
  when: string,
  merges: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'board-run-help-mode';

  const glyph = createGitWorktreeIcon(icon, 'board-run-help-mode__icon');
  glyph.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'board-run-help-mode__name';
  label.textContent = name;

  const detail = document.createElement('div');
  detail.className = 'board-run-help-mode__detail';
  const whenEl = document.createElement('p');
  whenEl.className = 'board-run-help-mode__line';
  whenEl.textContent = when;
  const mergeEl = document.createElement('p');
  mergeEl.className = 'board-run-help-mode__line board-run-help-mode__line--merge';
  mergeEl.textContent = merges;
  detail.append(whenEl, mergeEl);

  row.append(glyph, label, detail);
  return row;
}

function buildBody(): HTMLElement {
  const body = document.createElement('div');
  body.className = 'board-run-help-body';

  const intro = document.createElement('p');
  intro.className = 'board-run-help-intro';
  intro.textContent =
    'A board run is described by two things: whether it is Running or Stopped, and how many tasks may start at once. Isolation decides where each task does its work on disk.';

  const settings = document.createElement('div');
  settings.className = 'board-run-help-settings';
  settings.append(
    createSetting(
      'Run (concurrency)',
      'How many tasks may be in flight at the same time.',
      [
        'Set to 1 to run tasks strictly one after another.',
        'Higher values finish sooner but cost more tokens and memory at once.',
        'After a renderer out-of-memory crash the effective cap is throttled until you press Start again.',
      ],
    ),
    createSetting(
      'Status (Running / Stopped)',
      'Whether the reconcile loop is ticking.',
      [
        'Running starts eligible work up to the concurrency cap.',
        'Stopped is Manual: nothing new starts unless you start a task by hand.',
        'Stop always takes control back.',
      ],
    ),
  );

  const modesTitle = document.createElement('h3');
  modesTitle.className = 'board-run-help-modes__title';
  modesTitle.id = 'boardRunHelpModesTitle';
  modesTitle.textContent = 'Isolation';

  const modesIntro = document.createElement('p');
  modesIntro.className = 'board-run-help-modes__intro';
  modesIntro.textContent =
    'Isolation gives tasks separate git checkouts so they cannot overwrite each other. Auto picks per-board at concurrency 1 and per-task above it.';

  const modes = document.createElement('section');
  modes.className = 'board-run-help-modes';
  modes.setAttribute('aria-labelledby', 'boardRunHelpModesTitle');
  modes.append(
    modesTitle,
    modesIntro,
    createIsolationRow(
      'local',
      'Off',
      'Every task edits your live workspace directly.',
      'No integration branch — the finish dashboard offers Review & commit instead of a merge.',
    ),
    createIsolationRow(
      'worktree',
      'Per-board',
      'One worktree for the whole board; tasks take turns in it.',
      'The board branch is the integration branch, so tasks commit in sequence and there is no merge step at all.',
    ),
    createIsolationRow(
      'branch',
      'Per-task',
      'Each task gets its own worktree and branch.',
      'Each task merges into integration when it passes; its worktree is then removed and the branch kept.',
    ),
    createIsolationRow(
      'branch',
      'Per-wave',
      'Tasks in the same wave share one worktree and branch.',
      'The wave branch merges into integration once, after the wave finishes.',
    ),
  );

  body.append(intro, settings, modes);
  return body;
}

function ensureShell(): void {
  if (overlayEl && dialogEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.className = 'board-run-help-overlay hidden';
  overlayEl.hidden = true;

  dialogEl = document.createElement('div');
  dialogEl.id = DIALOG_ID;
  dialogEl.className = 'board-run-help-lightbox';
  dialogEl.setAttribute('role', 'dialog');
  dialogEl.setAttribute('aria-modal', 'true');
  dialogEl.setAttribute('aria-labelledby', 'boardRunHelpTitle');
  dialogEl.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'board-run-help-header';
  const title = document.createElement('h2');
  title.id = 'boardRunHelpTitle';
  title.className = 'board-run-help-header__title';
  title.textContent = 'Run settings';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn board-run-help-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.appendChild(createIcon('close'));
  closeBtn.addEventListener('click', () => closeBoardRunHelpLightbox());

  header.append(title, closeBtn);
  dialogEl.append(header, buildBody());
  overlayEl.appendChild(dialogEl);
  document.body.appendChild(overlayEl);

  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeBoardRunHelpLightbox();
  });
}

/** Open the run-settings explainer. */
export function openBoardRunHelpLightbox(): void {
  ensureShell();
  if (isOpen) return;

  previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  isOpen = true;
  overlayEl!.hidden = false;
  overlayEl!.classList.remove('hidden');
  markPreviewOccluder(overlayEl!, 'dialog');
  dialogEl!.focus();

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBoardRunHelpLightbox();
    }
  };
  document.addEventListener('keydown', escapeHandler, true);
  document.addEventListener('keydown', trapFocus, true);
}

/** Close the explainer and restore focus. */
export function closeBoardRunHelpLightbox(): void {
  if (!isOpen) return;
  isOpen = false;
  detachListeners();
  overlayEl!.hidden = true;
  overlayEl!.classList.add('hidden');
  if (overlayEl) unmarkPreviewOccluder(overlayEl);
  previousFocus?.focus();
  previousFocus = null;
}

/** Reset module state (tests). */
export function resetBoardRunHelpLightboxForTests(): void {
  closeBoardRunHelpLightbox();
  overlayEl?.remove();
  overlayEl = null;
  dialogEl = null;
}
