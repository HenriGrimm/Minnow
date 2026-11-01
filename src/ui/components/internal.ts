/**
 * Helpers shared by the component library. Not part of the public barrel:
 * surfaces use the components, not these.
 */

import {
  markPreviewOccluder,
  unmarkPreviewOccluder,
  type PreviewOccluderKind,
} from '../preview-occlusion';

let idCounter = 0;

export type ComponentAppearance = 'default' | 'surface';

/** Keep shared behavior while an established surface owns the control's appearance. */
export function applyAppearance(root: HTMLElement, appearance?: ComponentAppearance): void {
  if (appearance !== undefined) root.toggleAttribute('data-mn-surface', appearance === 'surface');
}

/** Document-unique id for ARIA wiring (`mn-<prefix>-<n>`). */
export function nextComponentId(prefix: string): string {
  idCounter += 1;
  return `mn-${prefix}-${idCounter}`;
}

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/** Keyboard-reachable elements inside `root`, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.closest('[hidden], [aria-hidden="true"], [inert]'),
  );
}

/** Keep Tab and Shift+Tab inside `root`. Call from a keydown handler. */
export function trapTabKey(root: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const nodes = focusableWithin(root);
  if (nodes.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  const inside = active != null && root.contains(active);
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * Tag a floating root so outside-click handling in shell overlays ignores it
 * and the native preview guest steps aside while it covers the pane.
 */
export function markOverlayRoot(root: HTMLElement, kind: PreviewOccluderKind): void {
  root.dataset.aboveShellOverlay = '';
  markPreviewOccluder(root, kind);
}

export function unmarkOverlayRoot(root: HTMLElement): void {
  unmarkPreviewOccluder(root);
}

/** Whether the primary pointer can hover (mouse or trackpad). */
export function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Add `token` to a space-separated attribute such as `aria-describedby`. */
export function addAttributeToken(el: Element, name: string, token: string): void {
  const tokens = (el.getAttribute(name) ?? '').split(/\s+/).filter(Boolean);
  if (tokens.includes(token)) return;
  tokens.push(token);
  el.setAttribute(name, tokens.join(' '));
}

/** Remove `token` from a space-separated attribute, dropping it when empty. */
export function removeAttributeToken(el: Element, name: string, token: string): void {
  const tokens = (el.getAttribute(name) ?? '').split(/\s+/).filter((t) => t && t !== token);
  if (tokens.length > 0) el.setAttribute(name, tokens.join(' '));
  else el.removeAttribute(name);
}

/** Append space-separated class names, ignoring empty input. */
export function addClassNames(el: Element, classNames: string | undefined): void {
  if (!classNames) return;
  for (const name of classNames.split(/\s+/)) {
    if (name) el.classList.add(name);
  }
}
