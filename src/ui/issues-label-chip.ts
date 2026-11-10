/**
 * Issue label chips, overflow popover, and the 10-swatch recolor picker.
 */

import {
  ISSUE_LABEL_SWATCH_IDS,
  ISSUE_LABEL_SWATCH_LABELS,
  splitIssueLabelsForList,
} from '../issues/label-catalog';
import type { IssueLabelSwatchId } from '../types';
import { getIssueLabelSwatch, setIssueLabelColor } from '../state/issues-store';
import { createIcon } from './icon';
import { markPreviewOccluder } from './preview-occlusion';

export type IssueLabelChipOptions = {
  name: string;
  removable?: boolean;
  onRemove?: () => void;
};

type OpenPopover = {
  anchor: HTMLElement;
  root: HTMLElement;
  onClose: () => void;
};

let openPopover: OpenPopover | null = null;
let popoverReposition: (() => void) | null = null;
let outsidePointerBound = false;
const deferredRefreshes = new Set<() => void>();

/** Keep issue rows stable while a body-mounted label popover is being used. */
export function deferUntilIssueLabelPopoverClosed(refresh: () => void): boolean {
  if (!openPopover) return false;
  deferredRefreshes.add(refresh);
  return true;
}

/** Paint the Linear tint from the workspace catalog onto a chip. */
export function applyIssueLabelSwatch(el: HTMLElement, name: string): void {
  el.dataset.swatch = getIssueLabelSwatch(name);
}

/**
 * True when a labels popover owns focus (skip peek remount). During focusout,
 * activeElement is already body, so callers pass event.relatedTarget to catch
 * focus moving into a popover mounted on document.body.
 */
export function isIssuesLabelPopoverFocused(relatedTarget?: EventTarget | null): boolean {
  const inPopover = (target: EventTarget | null | undefined): boolean =>
    target instanceof Element &&
    Boolean(
      target.closest(
        '.issues-labels-popover, .issues-labels-overflow, .issues-label-color-picker, .issues-labels-add-popover',
      ),
    );
  if (inPopover(document.activeElement)) return true;
  return inPopover(relatedTarget);
}

export function isIssueLabelPopoverOpenFor(container: HTMLElement): boolean {
  return openPopover !== null && container.contains(openPopover.anchor);
}

/** Close overflow, color picker, or add flyout. */
export function closeIssueLabelPopovers(): void {
  if (popoverReposition) {
    window.removeEventListener('resize', popoverReposition);
    window.removeEventListener('scroll', popoverReposition, true);
    popoverReposition = null;
  }
  openPopover?.root.remove();
  openPopover?.onClose();
  openPopover = null;
  queueMicrotask(() => {
    if (openPopover) return;
    const refreshes = [...deferredRefreshes];
    deferredRefreshes.clear();
    for (const refresh of refreshes) refresh();
  });
}

function positionIssueLabelPopover(anchor: HTMLElement, menu: HTMLElement): void {
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

function bindPopoverChrome(anchor: HTMLElement, root: HTMLElement, onClose: () => void): void {
  closeIssueLabelPopovers();
  document.body.appendChild(root);
  markPreviewOccluder(root, 'menu');
  openPopover = { anchor, root, onClose };
  positionIssueLabelPopover(anchor, root);
  popoverReposition = () => {
    if (!openPopover) return;
    positionIssueLabelPopover(anchor, openPopover.root);
  };
  window.addEventListener('resize', popoverReposition);
  window.addEventListener('scroll', popoverReposition, true);
  if (!outsidePointerBound) {
    outsidePointerBound = true;
    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target as Node | null;
        if (!openPopover) return;
        if (openPopover.root.contains(target)) return;
        if (
          target instanceof Element &&
          target.closest('.issues-labels-field__add, .issues-labels-field__more, .issues-label-chip')
        ) {
          return;
        }
        closeIssueLabelPopovers();
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !openPopover) return;
      event.preventDefault();
      closeIssueLabelPopovers();
    });
  }
}

function bindChipRecolor(chip: HTMLElement, name: string): void {
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openIssueLabelColorPicker(chip, name);
  });
}

/** Interactive or read-only colored chip. Right-click recolors the catalog name. */
export function createIssueLabelChip(options: IssueLabelChipOptions): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'issues-label issues-label-chip';
  chip.title = `${options.name}. Right-click to recolor.`;
  applyIssueLabelSwatch(chip, options.name);

  const text = document.createElement('span');
  text.className = 'issues-label-chip__text';
  text.textContent = options.name;
  chip.appendChild(text);

  if (options.removable && options.onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'issues-label-chip__remove';
    remove.setAttribute('aria-label', `Remove label ${options.name}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onRemove?.();
    });
    chip.appendChild(remove);
  }

  bindChipRecolor(chip, options.name);
  return chip;
}

/** Caret that opens labels beyond the row cap of three. */
export function createIssueLabelMoreButton(
  hiddenCount: number,
  hiddenNames: readonly string[],
  onOpen: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'issues-label issues-labels-field__more';
  more.title = hiddenNames.join(', ');
  more.setAttribute('aria-label', `${hiddenCount} more labels`);
  more.appendChild(createIcon('chevronDown', { size: 12, className: 'issues-labels-field__more-icon' }));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpen(more);
  });
  return more;
}

/** Overflow popover with the labels that did not fit on the row. */
export function openIssueLabelOverflow(
  anchor: HTMLElement,
  labels: readonly string[],
  options: { removable?: boolean; onRemove?: (name: string) => void } = {},
): void {
  const root = document.createElement('div');
  root.className = 'issues-labels-popover issues-labels-overflow';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'More labels');
  for (const name of labels) {
    root.appendChild(
      createIssueLabelChip({
        name,
        removable: options.removable,
        onRemove: options.onRemove ? () => options.onRemove?.(name) : undefined,
      }),
    );
  }
  bindPopoverChrome(anchor, root, () => {});
}

/** 10-swatch picker. Choosing a color updates every issue that uses the name. */
export function openIssueLabelColorPicker(anchor: HTMLElement, name: string): void {
  const current = getIssueLabelSwatch(name);
  const root = document.createElement('div');
  root.className = 'issues-labels-popover issues-label-color-picker';
  root.setAttribute('role', 'menu');
  root.setAttribute('aria-label', 'Color');

  for (const swatch of ISSUE_LABEL_SWATCH_IDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'issues-label-color-picker__swatch';
    button.dataset.swatch = swatch;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-label', ISSUE_LABEL_SWATCH_LABELS[swatch]);
    button.setAttribute('aria-checked', String(swatch === current));
    button.classList.toggle('is-selected', swatch === current);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      setIssueLabelColor(name, swatch as IssueLabelSwatchId);
      closeIssueLabelPopovers();
    });
    root.appendChild(button);
  }

  bindPopoverChrome(anchor, root, () => {});
}

/**
 * Read-only chip cluster for board cards: up to three chips and a caret popover.
 */
export function createIssueLabelsDisplay(labels: readonly string[]): HTMLElement | null {
  if (labels.length === 0) return null;
  const root = document.createElement('div');
  root.className = 'issues-card__labels';
  const { visible, hidden, hiddenCount } = splitIssueLabelsForList(labels);
  for (const name of visible) {
    root.appendChild(createIssueLabelChip({ name }));
  }
  if (hiddenCount > 0) {
    root.appendChild(
      createIssueLabelMoreButton(hiddenCount, hidden, (button) => {
        openIssueLabelOverflow(button, hidden);
      }),
    );
  }
  return root;
}

/** Shared flyout positioning for the add-label typeahead. */
export function mountIssueLabelFlyout(anchor: HTMLElement, root: HTMLElement, onClose: () => void): void {
  bindPopoverChrome(anchor, root, onClose);
}

export { positionIssueLabelPopover };
