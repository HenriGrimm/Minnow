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
    layer.style[prop] = cs[prop];
  }
}

/** Paint known `/skill-id` tokens to match the live textarea. */
export function syncComposerSkillHighlight(textarea: HTMLTextAreaElement): void {
  const layer = ensureLayer(textarea);
  copyTextareaMetrics(textarea, layer);
  const html = highlightedSkillTextHtml(textarea.value);
  layer.innerHTML = html ? `${html}\n` : '';
  layer.scrollTop = textarea.scrollTop;
  layer.scrollLeft = textarea.scrollLeft;
}

/** Bind overlay listeners on one composer (idempotent). */
export function initComposerSkillHighlight(textarea: HTMLTextAreaElement): void {
  if (textarea.dataset.skillHighlightBound === '1') return;
  textarea.dataset.skillHighlightBound = '1';

  const sync = (): void => {
    syncComposerSkillHighlight(textarea);
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

  sync();
}
