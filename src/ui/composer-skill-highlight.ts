/**
 * Mirror slash skill tokens as chips over composer textareas.
 * Textareas stay the source of truth; the overlay is paint-only.
 */

import { highlightedSkillTextHtml } from '../skills/skill-chip';

const STYLE_PROPS = [
  'font',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'boxSizing',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;

function ensureHost(textarea: HTMLTextAreaElement): HTMLElement {
  const parent = textarea.parentElement;
  if (parent?.classList.contains('composer-skill-highlight-host')) {
    return parent;
  }

  const host = document.createElement('div');
  host.className = 'composer-skill-highlight-host';
  parent?.insertBefore(host, textarea);
  host.appendChild(textarea);
  return host;
}

function ensureLayer(textarea: HTMLTextAreaElement): HTMLDivElement {
  const host = ensureHost(textarea);
  let layer = host.querySelector('.composer-skill-highlight') as HTMLDivElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'composer-skill-highlight';
    layer.setAttribute('aria-hidden', 'true');
    host.insertBefore(layer, textarea);
  }
  textarea.classList.add('composer-skill-input');
  return layer;
}

function copyTextareaMetrics(textarea: HTMLTextAreaElement, layer: HTMLDivElement): void {
  const view = textarea.ownerDocument.defaultView;
  if (!view) return;
  const cs = view.getComputedStyle(textarea);
  for (const prop of STYLE_PROPS) {
    // Rewriting an unchanged inline value still dirties the layer's style.
    if (layer.style[prop] !== cs[prop]) layer.style[prop] = cs[prop];
  }
  // A visible native scrollbar narrows the textarea's text area. Match that
  // width so the paint-only layer wraps at the same words as the caret.
  const borders = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  const right = `${Math.max(0, textarea.offsetWidth - textarea.clientWidth - borders)}px`;
  if (layer.style.right !== right) layer.style.right = right;
}

/** Markup last painted into each layer, so an unchanged value skips the reparse. */
const paintedMarkup = new WeakMap<HTMLDivElement, string>();
const pendingFrames = new WeakMap<HTMLTextAreaElement, number>();

/** Paint known `/skill-id` tokens to match the live textarea. */
export function syncComposerSkillHighlight(textarea: HTMLTextAreaElement): void {
  const layer = ensureLayer(textarea);
  copyTextareaMetrics(textarea, layer);
  const html = highlightedSkillTextHtml(textarea.value);
  const markup = html ? `${html}\n` : '';
  if (paintedMarkup.get(layer) !== markup) {
    layer.innerHTML = markup;
    paintedMarkup.set(layer, markup);
  }
  layer.scrollTop = textarea.scrollTop;
  layer.scrollLeft = textarea.scrollLeft;
}

/**
 * Coalesce overlay syncs to one per frame. A keystroke fires input, keyup and the
 * auto-resize pass, and each sync forces style and layout on the composer; rAF still
 * runs before the frame paints, so the chips never trail the caret.
 */
export function scheduleComposerSkillHighlight(textarea: HTMLTextAreaElement): void {
  if (pendingFrames.has(textarea)) return;
  const view = textarea.ownerDocument.defaultView;
  if (typeof view?.requestAnimationFrame !== 'function') {
    syncComposerSkillHighlight(textarea);
    return;
  }
  pendingFrames.set(textarea, view.requestAnimationFrame(() => {
    pendingFrames.delete(textarea);
    syncComposerSkillHighlight(textarea);
  }));
}

/** Bind overlay listeners on one composer (idempotent). */
export function initComposerSkillHighlight(textarea: HTMLTextAreaElement): void {
  if (textarea.dataset.skillHighlightBound === '1') return;
  textarea.dataset.skillHighlightBound = '1';

  const sync = (): void => {
    scheduleComposerSkillHighlight(textarea);
  };

  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', sync);
  textarea.addEventListener('keyup', sync);
  textarea.addEventListener('click', sync);

  const view = textarea.ownerDocument.defaultView;
  view?.addEventListener('resize', sync);

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
  }

  syncComposerSkillHighlight(textarea);
}
