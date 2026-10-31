/**
 * Anchored popovers: pickers, small forms and detail panels that belong to a
 * control. Action lists should use `openContextMenu()` instead.
 *
 * Several popovers can be open at once (a picker inside a popover). Escape
 * closes only the topmost; an outside click closes every popover it lands
 * outside of. Clicks inside menus and tooltips count as inside.
 */

import '../../styles/components/popover.css';
import {
  addClassNames,
  focusableWithin,
  markOverlayRoot,
  nextComponentId,
  unmarkOverlayRoot,
} from './internal';
import { placeFloating, type FloatingPlacement } from './position';

export type PopoverCloseReason = 'escape' | 'outside' | 'anchor' | 'api';

export interface PopoverOptions {
  anchor: HTMLElement;
  content: HTMLElement;
  /** Default `bottom-start`. */
  placement?: FloatingPlacement;
  offset?: number;
  ariaLabel?: string;
  /** `dialog` (default) for interactive content, `group` for passive content. */
  role?: 'dialog' | 'group';
  className?: string;
  /** At least as wide as the anchor (pickers under a field). */
  matchAnchorWidth?: boolean;
  /** Default `first`: the first focusable inside, else the panel. */
  initialFocus?: HTMLElement | 'first' | 'none';
  onClose?: (reason: PopoverCloseReason) => void;
}

export interface PopoverHandle {
  root: HTMLDivElement;
  close(reason?: PopoverCloseReason): void;
  reposition(): void;
  isOpen(): boolean;
}

interface OpenPopover {
  handle: PopoverHandle;
  anchor: HTMLElement;
}

const stack: OpenPopover[] = [];
let listenersBound = false;

/** Pointer targets that belong to the floating layer above popovers. */
const FLOATING_LAYER_SELECTOR = '.mn-menu, .mn-tooltip';

function onPointerDown(event: PointerEvent): void {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== 'function') return;
  if (target.closest(FLOATING_LAYER_SELECTOR)) return;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    // The anchor's own click handler decides (togglePopover closes, openPopover reopens).
    if (entry.handle.root.contains(target) || entry.anchor.contains(target)) return;
    entry.handle.close('outside');
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || stack.length === 0) return;
  // A context menu opened from a popover closes first.
  if (document.querySelector('.mn-menu')) return;
  event.preventDefault();
  // Capture phase on window: stop dialogs and shell overlays underneath reacting too.
  event.stopImmediatePropagation();
  stack[stack.length - 1].handle.close('escape');
}

function onViewportChange(event: Event): void {
  // Resize targets the window; scroll targets a node, which may be inside a popover.
  const target = event.target as Partial<Node> | null;
  const node = target && typeof target.nodeType === 'number' ? (target as Node) : null;
  for (const entry of stack) {
    if (node && entry.handle.root.contains(node)) continue;
    entry.handle.reposition();
  }
}

function bindListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onViewportChange);
  document.addEventListener('scroll', onViewportChange, true);
}

function unbindListeners(): void {
  if (!listenersBound) return;
  listenersBound = false;
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', onViewportChange);
  document.removeEventListener('scroll', onViewportChange, true);
}

/** Open a popover anchored to `options.anchor`. An open popover on the same anchor is replaced. */
export function openPopover(options: PopoverOptions): PopoverHandle {
  stack.find((entry) => entry.anchor === options.anchor)?.handle.close('api');

  const { anchor } = options;
  const root = document.createElement('div');
  root.className = 'mn-popover';
  addClassNames(root, options.className);
  root.id = nextComponentId('popover');
  root.setAttribute('role', options.role ?? 'dialog');
  if (options.ariaLabel) root.setAttribute('aria-label', options.ariaLabel);
  root.tabIndex = -1;
  root.appendChild(options.content);

  const placement = options.placement ?? 'bottom-start';
  let open = true;

  const reposition = () => {
    if (!open || !anchor.isConnected) return;
    if (options.matchAnchorWidth) root.style.minWidth = `${anchor.getBoundingClientRect().width}px`;
    placeFloating(root, anchor, { placement, offset: options.offset });
  };

  const close = (reason: PopoverCloseReason = 'api') => {
    if (!open) return;
    open = false;
    const index = stack.findIndex((entry) => entry.handle === handle);
    if (index >= 0) stack.splice(index, 1);
    if (stack.length === 0) unbindListeners();
    const active = document.activeElement;
    const focusWasInside = active != null && root.contains(active);
    root.remove();
    unmarkOverlayRoot(root);
    anchor.setAttribute('aria-expanded', 'false');
    if (anchor.getAttribute('aria-controls') === root.id) anchor.removeAttribute('aria-controls');
    if ((reason === 'escape' || focusWasInside) && anchor.isConnected) anchor.focus();
    options.onClose?.(reason);
  };

  const handle: PopoverHandle = { root, close, reposition, isOpen: () => open };

  document.body.appendChild(root);
  markOverlayRoot(root, 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', root.id);
  stack.push({ handle, anchor });
  bindListeners();
  reposition();

  const initialFocus = options.initialFocus ?? 'first';
  if (initialFocus === 'first') (focusableWithin(root)[0] ?? root).focus();
  else if (initialFocus !== 'none') initialFocus.focus();

  return handle;
}

/** Open, or close when this anchor's popover is already open. Returns the open handle or null. */
export function togglePopover(options: PopoverOptions): PopoverHandle | null {
  const existing = stack.find((entry) => entry.anchor === options.anchor);
  if (existing) {
    existing.handle.close('anchor');
    return null;
  }
  return openPopover(options);
}

/** Close every open popover, topmost first. */
export function closeAllPopovers(): void {
  for (let i = stack.length - 1; i >= 0; i -= 1) stack[i]?.handle.close('api');
}

export function isPopoverOpen(): boolean {
  return stack.length > 0;
}
