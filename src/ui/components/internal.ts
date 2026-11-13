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
  'details > summary:first-of-type',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/** Keyboard-reachable elements inside `root`, in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  const view = root.ownerDocument.defaultView;
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => {
    if (el.getAttribute('tabindex') === '-1' || el.closest('[hidden], [aria-hidden="true"], [inert]')
      || el.getClientRects().length === 0) return false;
    for (let details = el.closest('details:not([open])'); details; details = details.parentElement?.closest('details:not([open])') ?? null) {
      if (!details.querySelector(':scope > summary')?.contains(el)) return false;
    }
    const visibility = view?.getComputedStyle(el).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  });
}

const modalInertCounts = new WeakMap<HTMLElement, number>();

/** Inert sibling branches without hiding the modal's ancestors or changing prior inert state. */
export function isolateModalBackground(root: HTMLElement, boundary = document.body): () => void {
  const leased: HTMLElement[] = [];
  for (let branch = root; branch.parentElement && branch !== boundary; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch
        || (sibling.hidden && sibling.hasAttribute('data-above-shell-overlay'))) continue;
      const count = modalInertCounts.get(sibling);
      if (count === undefined && sibling.inert) continue;
      modalInertCounts.set(sibling, (count ?? 0) + 1);
      sibling.inert = true;
      leased.push(sibling);
    }
  }
  return () => {
    for (const element of leased.splice(0)) {
      const count = modalInertCounts.get(element) ?? 1;
      if (count > 1) modalInertCounts.set(element, count - 1);
      else {
        modalInertCounts.delete(element);
        element.inert = false;
      }
    }
  };
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
  if (event.shiftKey && (active === first || active === root || !inside)) {
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
