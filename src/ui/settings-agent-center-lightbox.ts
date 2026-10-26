import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import { iconHtml } from './icon';

const OVERLAY_ID = 'agentCenterLightboxOverlay';
const DIALOG_ID = 'agentCenterLightbox';
const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let overlayEl: HTMLDivElement | null = null;
let dialogEl: HTMLDivElement | null = null;
let titleEl: HTMLHeadingElement | null = null;
let subtitleEl: HTMLParagraphElement | null = null;
let badgeEl: HTMLSpanElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let isOpen = false;
let previousFocus: HTMLElement | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

export interface AgentCenterLightboxContent {
  title: string;
  subtitle?: string;
  badge: string;
  /** Mount all editors into the lightbox body. */
  render: (body: HTMLElement) => void;
}

/** Whether the agents center lightbox is open. */
export function isAgentCenterLightboxOpen(): boolean {
  return isOpen;
}

function trapFocus(e: KeyboardEvent): void {
  if (e.key !== 'Tab' || !dialogEl) return;
  const nodes = [...dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (n) => !n.hidden && !n.closest('[hidden]'),
  );
  if (!nodes.length) return;
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

function ensureShell(): void {
  if (overlayEl && dialogEl) return;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.className = 'agent-center-overlay hidden';
  overlayEl.hidden = true;

  dialogEl = document.createElement('div');
  dialogEl.id = DIALOG_ID;
  dialogEl.className = 'agent-center-lightbox';
  dialogEl.setAttribute('role', 'dialog');
  dialogEl.setAttribute('aria-modal', 'true');
  dialogEl.setAttribute('aria-labelledby', 'agentCenterLightboxTitle');
  dialogEl.tabIndex = -1;

  const header = document.createElement('header');
  header.className = 'agent-center-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'agent-center-header__titles';
  titleEl = document.createElement('h2');
  titleEl.id = 'agentCenterLightboxTitle';
  titleEl.className = 'agent-center-header__title';
  subtitleEl = document.createElement('p');
  subtitleEl.className = 'agent-center-header__subtitle';
  titleWrap.append(titleEl, subtitleEl);

  badgeEl = document.createElement('span');
  badgeEl.className = 'agent-center-header__badge';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn agent-center-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.innerHTML = iconHtml('close');
  closeBtn.addEventListener('click', () => closeAgentCenterLightbox());

  header.append(titleWrap, badgeEl, closeBtn);

  bodyEl = document.createElement('div');
  bodyEl.className = 'agent-center-body';
  dialogEl.append(header, bodyEl);
  overlayEl.appendChild(dialogEl);
  document.body.appendChild(overlayEl);

  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeAgentCenterLightbox();
  });
}

function mountSection(body: HTMLElement, title: string, mount: (panel: HTMLElement) => void): void {
  const section = document.createElement('section');
  section.className = 'agent-center-section';
  const heading = document.createElement('h3');
  heading.className = 'agent-center-section__title';
  heading.textContent = title;
  const panel = document.createElement('div');
  panel.className = 'agent-center-section__panel';
  section.append(heading, panel);
  body.appendChild(section);
  mount(panel);
}

/** Helper for lightbox content authors. */
export function appendAgentCenterSection(
  body: HTMLElement,
  title: string,
  mount: (panel: HTMLElement) => void,
): void {
  mountSection(body, title, mount);
}

/** Open the agents center lightbox with the given content. */
export function openAgentCenterLightbox(content: AgentCenterLightboxContent): void {
  ensureShell();
  if (!overlayEl || !dialogEl || !titleEl || !subtitleEl || !badgeEl || !bodyEl) return;

  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  titleEl.textContent = content.title;
  subtitleEl.textContent = content.subtitle ?? '';
  subtitleEl.hidden = !content.subtitle?.trim();
  badgeEl.textContent = content.badge;
  bodyEl.replaceChildren();
  content.render(bodyEl);

  overlayEl.hidden = false;
  overlayEl.classList.remove('hidden');
  isOpen = true;

  markPreviewOccluder(overlayEl, 'dialog');

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeAgentCenterLightbox();
      return;
    }
    trapFocus(e);
  };
  document.addEventListener('keydown', escapeHandler, true);
  dialogEl.focus();
}

/** Close the agents center lightbox and restore focus. */
export function closeAgentCenterLightbox(): void {
  if (!overlayEl || !isOpen) return;
  overlayEl.hidden = true;
  overlayEl.classList.add('hidden');
  isOpen = false;
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
  if (overlayEl) unmarkPreviewOccluder(overlayEl);
  previousFocus?.focus();
  previousFocus = null;
}
