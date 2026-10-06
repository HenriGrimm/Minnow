/**
 * Shared composer run-target flyout (current workspace / Worktree… / New worktree).
 * Issues Send to chat reuses this panel so the vocabulary stays one control.
 */

import {
  filterUserFacingWorktrees,
  formatWorktreeOptionLabel,
  getPrincipalWorktree,
  parseWorktreeListPorcelain,
  worktreePathsEqual,
} from '../lib/worktree-list-parse.ts';
import {
  composerGitRepoRoot,
  type ChatRunTargetChoice,
} from '../state/chat-worktree.ts';
import { listWorktrees } from '../state/worktree-service.ts';
import { getWorkspaceLabel } from '../state/workspace.ts';
import { createGitWorktreeIcon } from './git-worktree-icons.ts';
import {
  closeGitPanelNamePopover,
  openGitRefNamePopover,
} from './git-panel-name-popover.ts';
import { setStatus } from './status.ts';
import { showToast } from './toast.ts';

export interface FillRunTargetMenuOptions {
  menu: HTMLElement;
  /** Repo root used for principal / extra-worktree filtering. */
  repoRoot?: string;
  /** Composer disables the current workspace when the active chat is already Local. */
  localDisabled?: boolean;
  defaultTitle?: string;
  defaultPath?: string;
  reserved?: Iterable<string | undefined | null>;
  /** Anchor for the New worktree name popover. */
  popoverAnchor: HTMLElement;
  closeMenu: () => void;
  reopenMenu: () => void;
  onPick: (choice: ChatRunTargetChoice) => void | Promise<void>;
  /** New worktree popover closed without creating (Issues cancel). */
  onPopoverDismiss?: () => void;
}

export interface OpenRunTargetPickerOptions {
  anchor?: HTMLElement | null;
  clientX?: number;
  clientY?: number;
  repoRoot?: string;
  defaultTitle?: string;
  defaultPath?: string;
  reserved?: Iterable<string | undefined | null>;
  onPick: (choice: ChatRunTargetChoice) => void | Promise<void>;
  onCancel?: () => void;
}

let pickerMenu: HTMLDivElement | null = null;
let pickerAnchor: HTMLElement | null = null;
let pickerGhost: HTMLDivElement | null = null;
let pickerPicked = false;
let pickerOnCancel: (() => void) | null = null;
let pickerOutside: ((e: PointerEvent) => void) | null = null;
let pickerEscape: ((e: KeyboardEvent) => void) | null = null;

function menuSection(title: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'composer-run-target-menu__section';
  const heading = document.createElement('div');
  heading.className = 'composer-run-target-menu__heading';
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function menuItem(
  label: string,
  onClick: () => void,
  options?: { icon?: 'local' | 'branch' | 'worktree'; disabled?: boolean; keepOpen?: boolean },
  closeMenu?: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'composer-run-target-menu__item';
  btn.setAttribute('role', 'menuitem');
  btn.disabled = options?.disabled === true;
  if (options?.icon) {
    btn.appendChild(createGitWorktreeIcon(options.icon, 'composer-run-target-menu__item-icon'));
  }
  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);
  btn.addEventListener('click', () => {
    if (!options?.keepOpen) closeMenu?.();
    void onClick();
  });
  return btn;
}

/** Position a run-target flyout under (or above) an anchor. */
export function positionRunTargetMenu(anchor: HTMLElement, menu: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const menuHeight = menu.offsetHeight || menu.getBoundingClientRect().height;
  const menuWidth = menu.offsetWidth || menu.getBoundingClientRect().width;

  let top = rect.bottom + gap;
  if (top + menuHeight > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuHeight - gap);
  }

  let left = rect.left;
  if (left + menuWidth > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - menuWidth - margin);
  }

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

/** Fill current workspace / Worktree… / New worktree into an existing menu element. */
export async function fillRunTargetMenu(options: FillRunTargetMenuOptions): Promise<void> {
  const menu = options.menu;
  menu.replaceChildren();

  const repoRoot = options.repoRoot?.trim() || composerGitRepoRoot();
  const list = await listWorktrees();
  const parsed =
    list.ok && list.output ? parseWorktreeListPorcelain(list.output) : [];
  const principal = getPrincipalWorktree(parsed);

  const runOn = menuSection('Run on');
  runOn.appendChild(
    menuItem(
      getWorkspaceLabel().trim() || 'Current workspace',
      () => {
        void options.onPick({ kind: 'local' });
      },
      { icon: 'local', disabled: options.localDisabled === true },
      options.closeMenu,
    ),
  );

  if (
    principal?.path &&
    repoRoot &&
    !worktreePathsEqual(principal.path, repoRoot)
  ) {
    const principalLabel = principal.branch?.trim()
      ? `${principal.branch} (main worktree)`
      : 'Main worktree';
    runOn.appendChild(
      menuItem(
        principalLabel,
        () => {
          void options.onPick({
            kind: 'attach',
            path: principal.path,
            branch: principal.branch,
          });
        },
        { icon: 'worktree' },
        options.closeMenu,
      ),
    );
  }
  menu.appendChild(runOn);

  const wtSection = menuSection('Worktree');
  const attachItem = menuItem(
    'Worktree…',
    async () => {
      if (!list.ok || !list.output) {
        const msg = list.error ?? 'Could not list worktrees';
        setStatus('error', msg);
        showToast(msg, 'error');
        return;
      }
      const entries = filterUserFacingWorktrees(parsed, repoRoot).filter(
        (wt) => !worktreePathsEqual(wt.path, repoRoot),
      );
      if (!entries.length) {
        const msg = 'No extra worktrees found';
        setStatus('error', msg);
        showToast(msg, 'error');
        return;
      }
      menu.replaceChildren();
      menu.appendChild(
        menuItem(
          '← Back',
          () => {
            void fillRunTargetMenu(options).then(() => options.reopenMenu());
          },
          { keepOpen: true },
          options.closeMenu,
        ),
      );
      for (const wt of entries) {
        const label = formatWorktreeOptionLabel(wt, repoRoot, {
          principalPath: principal?.path,
        });
        menu.appendChild(
          menuItem(
            label,
            () => {
              void options.onPick({
                kind: 'attach',
                path: wt.path,
                branch: wt.branch,
              });
            },
            { icon: 'worktree' },
            options.closeMenu,
          ),
        );
      }
      options.reopenMenu();
    },
    { icon: 'worktree', keepOpen: true },
    options.closeMenu,
  );

  const newItem = menuItem(
    'New worktree',
    () => {
      openGitRefNamePopover({
        anchor: options.popoverAnchor,
        title: 'New worktree',
        kind: 'worktree',
        cwd: repoRoot,
        defaultTitle: options.defaultTitle,
        defaultPath: options.defaultPath || repoRoot,
        reserved: options.reserved,
        onSubmit: async (result) => {
          await options.onPick({
            kind: 'create',
            name: result.name,
            startPoint: result.startPoint,
            checkoutExisting: result.checkoutExisting,
          });
        },
        onDismiss: options.onPopoverDismiss,
      });
    },
    { icon: 'worktree' },
    options.closeMenu,
  );

  wtSection.append(attachItem, newItem);
  menu.appendChild(wtSection);
}

function detachPickerListeners(): void {
  if (pickerOutside) {
    document.removeEventListener('pointerdown', pickerOutside, true);
    pickerOutside = null;
  }
  if (pickerEscape) {
    document.removeEventListener('keydown', pickerEscape, true);
    pickerEscape = null;
  }
}

function removePickerGhost(): void {
  pickerGhost?.remove();
  pickerGhost = null;
}

/** Close the standalone Issues/composer picker if it is open. */
export function closeRunTargetPicker(): void {
  if (!pickerMenu && !pickerGhost) return;
  const cancelled = Boolean(pickerMenu) && !pickerPicked;
  detachPickerListeners();
  pickerMenu?.remove();
  pickerMenu = null;
  pickerAnchor = null;
  removePickerGhost();
  const onCancel = pickerOnCancel;
  pickerOnCancel = null;
  pickerPicked = false;
  if (cancelled) onCancel?.();
}

function ensureGhostAnchor(clientX: number, clientY: number): HTMLDivElement {
  const ghost = document.createElement('div');
  ghost.className = 'composer-run-target-picker-anchor';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.position = 'fixed';
  ghost.style.width = '1px';
  ghost.style.height = '1px';
  ghost.style.left = `${clientX}px`;
  ghost.style.top = `${clientY}px`;
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  pickerGhost = ghost;
  return ghost;
}

function attachPickerListeners(): void {
  pickerOutside = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (pickerMenu?.contains(target) || pickerAnchor?.contains(target)) return;
    const popover = document.querySelector('.git-panel-name-popover');
    if (popover?.contains(target)) return;
    closeRunTargetPicker();
  };
  document.addEventListener('pointerdown', pickerOutside, true);

  pickerEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    closeGitPanelNamePopover();
    closeRunTargetPicker();
  };
  document.addEventListener('keydown', pickerEscape, true);
}

/**
 * Open the composer run-target panel as a standalone picker (Issues Send to chat).
 * Escape or click-outside cancels without calling onPick.
 */
export async function openRunTargetPicker(options: OpenRunTargetPickerOptions): Promise<void> {
  closeRunTargetPicker();
  closeGitPanelNamePopover();

  const hasPoint =
    typeof options.clientX === 'number' && typeof options.clientY === 'number';
  const anchor =
    options.anchor ??
    (hasPoint ? ensureGhostAnchor(options.clientX!, options.clientY!) : null);
  if (!anchor) return;

  pickerPicked = false;
  pickerOnCancel = options.onCancel ?? null;
  pickerAnchor = anchor;

  const menu = document.createElement('div');
  menu.className = 'composer-run-target-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Run target');
  document.body.appendChild(menu);
  pickerMenu = menu;

  const finishPick = async (choice: ChatRunTargetChoice): Promise<void> => {
    pickerPicked = true;
    closeRunTargetPicker();
    await options.onPick(choice);
  };

  await fillRunTargetMenu({
    menu,
    repoRoot: options.repoRoot,
    defaultTitle: options.defaultTitle,
    defaultPath: options.defaultPath,
    reserved: options.reserved,
    popoverAnchor: anchor,
    closeMenu: () => {
      // Keep the ghost/anchor until the popover or pick finishes.
      pickerMenu?.classList.add('hidden');
    },
    reopenMenu: () => {
      if (!pickerMenu || !pickerAnchor) return;
      pickerMenu.classList.remove('hidden');
      positionRunTargetMenu(pickerAnchor, pickerMenu);
    },
    onPick: finishPick,
    onPopoverDismiss: () => {
      closeRunTargetPicker();
    },
  });

  if (pickerMenu !== menu) return;
  positionRunTargetMenu(anchor, menu);
  attachPickerListeners();
}
