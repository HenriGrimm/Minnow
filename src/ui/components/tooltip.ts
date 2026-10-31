/**
 * Themed tooltips. One shared `role="tooltip"` element follows whichever
 * target is hovered (after a delay) or keyboard-focused (immediately).
 * Replaces native `title=` tooltips, which ignore the theme and cannot be read
 * on focus.
 */

import '../../styles/components/tooltip.css';
import {
  addAttributeToken,
  hasFinePointer,
  markOverlayRoot,
  nextComponentId,
  removeAttributeToken,
  unmarkOverlayRoot,
} from './internal';
import { placeFloating, type FloatingPlacement } from './position';

export const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_OFFSET = 6;

export interface TooltipOptions {
  placement?: FloatingPlacement;
}

interface TooltipEntry {
  text: string;
  placement: FloatingPlacement;
  detach: () => void;
}

const entries = new WeakMap<HTMLElement, TooltipEntry>();
let tooltipEl: HTMLDivElement | null = null;
let activeTarget: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let documentListenersBound = false;

function ensureTooltipElement(): HTMLDivElement {
  if (tooltipEl && tooltipEl.ownerDocument === document && tooltipEl.isConnected) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'mn-tooltip';
  tooltipEl.id = nextComponentId('tooltip');
  tooltipEl.setAttribute('role', 'tooltip');
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function cancelShow(): void {
  if (showTimer != null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') hideTooltip();
}

function onDocumentScroll(): void {
  hideTooltip();
}

function bindDocumentListeners(): void {
  if (documentListenersBound) return;
  documentListenersBound = true;
  document.addEventListener('keydown', onDocumentKeydown, true);
  document.addEventListener('scroll', onDocumentScroll, true);
}

function unbindDocumentListeners(): void {
  if (!documentListenersBound) return;
  documentListenersBound = false;
  document.removeEventListener('keydown', onDocumentKeydown, true);
  document.removeEventListener('scroll', onDocumentScroll, true);
}

/** Whether the text adds anything to what the target already announces. */
function describesTarget(target: HTMLElement, text: string): boolean {
  return target.getAttribute('aria-label')?.trim() !== text.trim();
}

function showFor(target: HTMLElement): void {
  cancelShow();
  const entry = entries.get(target);
  if (!entry || !entry.text.trim() || !target.isConnected) return;
  if (activeTarget && activeTarget !== target) hideTooltip();
  const el = ensureTooltipElement();
  el.textContent = entry.text;
  el.hidden = false;
  markOverlayRoot(el, 'panel');
  placeFloating(el, target, { placement: entry.placement, offset: TOOLTIP_OFFSET });
  activeTarget = target;
  if (describesTarget(target, entry.text)) addAttributeToken(target, 'aria-describedby', el.id);
  bindDocumentListeners();
}

/** Hide the tooltip now, whichever target owns it. */
export function hideTooltip(): void {
  cancelShow();
  if (activeTarget && tooltipEl) removeAttributeToken(activeTarget, 'aria-describedby', tooltipEl.id);
  activeTarget = null;
  if (tooltipEl) {
    tooltipEl.hidden = true;
    unmarkOverlayRoot(tooltipEl);
  }
  unbindDocumentListeners();
}

function matchesFocusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Show `text` when `target` is hovered or keyboard-focused. Calling it again
 * for the same target updates the text. Returns a function that detaches.
 */
export function attachTooltip(
  target: HTMLElement,
  text: string,
  options: TooltipOptions = {},
): () => void {
  const existing = entries.get(target);
  if (existing) {
    existing.placement = options.placement ?? existing.placement;
    setTooltip(target, text);
    return existing.detach;
  }

  // A native title would show a second, unthemed tooltip on hover.
  target.removeAttribute('title');

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === 'touch' || (!event.pointerType && !hasFinePointer())) return;
    cancelShow();
    showTimer = setTimeout(() => {
      showTimer = null;
      showFor(target);
    }, TOOLTIP_DELAY_MS);
  };
  const onPointerLeave = () => {
    cancelShow();
    if (activeTarget === target) hideTooltip();
  };
  const onFocus = () => {
    if (matchesFocusVisible(target)) showFor(target);
  };
  const onBlur = () => {
    if (activeTarget === target) hideTooltip();
  };
  const onPointerDown = () => {
    cancelShow();
    if (activeTarget === target) hideTooltip();
  };

  target.addEventListener('pointerenter', onPointerEnter);
  target.addEventListener('pointerleave', onPointerLeave);
  target.addEventListener('focus', onFocus);
  target.addEventListener('blur', onBlur);
  target.addEventListener('pointerdown', onPointerDown);

  const detach = () => {
    target.removeEventListener('pointerenter', onPointerEnter);
    target.removeEventListener('pointerleave', onPointerLeave);
    target.removeEventListener('focus', onFocus);
    target.removeEventListener('blur', onBlur);
    target.removeEventListener('pointerdown', onPointerDown);
    if (activeTarget === target) hideTooltip();
    entries.delete(target);
  };

  entries.set(target, { text, placement: options.placement ?? 'top', detach });
  return detach;
}

/** Change a target's tooltip text; an empty string hides it until set again. */
export function setTooltip(target: HTMLElement, text: string): void {
  const entry = entries.get(target);
  if (!entry) {
    attachTooltip(target, text);
    return;
  }
  entry.text = text;
  if (activeTarget !== target || !tooltipEl) return;
  if (!text.trim()) {
    hideTooltip();
    return;
  }
  tooltipEl.textContent = text;
  if (describesTarget(target, text)) addAttributeToken(target, 'aria-describedby', tooltipEl.id);
  else removeAttributeToken(target, 'aria-describedby', tooltipEl.id);
  placeFloating(tooltipEl, target, { placement: entry.placement, offset: TOOLTIP_OFFSET });
}

/** Current tooltip text for a target, if one is attached. */
export function getTooltipText(target: HTMLElement): string | null {
  return entries.get(target)?.text ?? null;
}

/** Reset module state (tests). */
export function resetTooltipForTests(): void {
  cancelShow();
  unbindDocumentListeners();
  activeTarget = null;
  tooltipEl?.remove();
  tooltipEl = null;
}
