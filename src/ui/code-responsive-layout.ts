import { isNarrowLayout } from './mobile-layout';

export const CODE_PRIMARY_PANE_MIN_W = 480;

const DEFAULT_CHAT_SIDEBAR_W = 300;
const DEFAULT_FILE_SIDEBAR_W = 350;
const FILE_OVERLAY_CLASS = 'mn-code-file-overlay';

export interface CodeFileOverlayPolicyInput {
  containerWidth: number;
  chatSidebarWidth: number;
  fileSidebarWidth: number;
  chatSidebarOpen: boolean;
  narrowLayout: boolean;
  primaryPaneMinWidth?: number;
}

/** Keep the primary Code pane useful before a second docked sidebar consumes it. */
export function shouldUseCodeFileOverlay(input: CodeFileOverlayPolicyInput): boolean {
  if (input.narrowLayout || !input.chatSidebarOpen || input.containerWidth <= 0) return false;
  const primaryMin = input.primaryPaneMinWidth ?? CODE_PRIMARY_PANE_MIN_W;
  return input.containerWidth - input.chatSidebarWidth - input.fileSidebarWidth < primaryMin;
}

function cssPixelValue(el: HTMLElement, property: string, fallback: number): number {
  const inlineValue = el.style.getPropertyValue(property);
  const computedValue =
    typeof getComputedStyle === 'function' ? getComputedStyle(el).getPropertyValue(property) : '';
  const parsed = Number.parseFloat(inlineValue || computedValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function closeTransientFileDrawer(): void {
  const side = document.getElementById('fileSidebar');
  const backdrop = document.getElementById('fileSidebarBackdrop');
  const opener = document.getElementById('btnCodeViewsFiles');
  side?.classList.remove('mobile-open');
  document.documentElement.classList.remove('mn-os-mobile-file-drawer');
  if (opener) {
    opener.setAttribute('aria-pressed', 'false');
    opener.setAttribute('aria-label', 'Open file tree');
    opener.setAttribute('title', 'Open file tree');
  }
  if (!backdrop) return;
  backdrop.classList.remove('open');
  backdrop.setAttribute('aria-hidden', 'true');
  (backdrop as HTMLButtonElement).tabIndex = -1;
}

/** True when Files uses a temporary drawer while Chats remains docked. */
export function isCodeFileOverlayLayout(): boolean {
  return document.documentElement.classList.contains(FILE_OVERLAY_CLASS);
}

/**
 * Apply the Code-only medium-width policy without changing either persisted
 * sidebar preference. Entering the policy closes Files; the view-bar Files
 * button can then reopen it as a temporary drawer.
 */
export function syncCodeResponsiveLayout(): boolean {
  const root = document.documentElement;
  const body = document.getElementById('appBody');
  const chat = document.getElementById('chatSidebar');
  const codeForeground = root.dataset.osApp === 'code';
  if (!codeForeground || !body || !chat) {
    const previous = root.classList.contains(FILE_OVERLAY_CLASS);
    root.classList.remove(FILE_OVERLAY_CLASS);
    if (previous) closeTransientFileDrawer();
    return false;
  }

  const bodyWidth = body.clientWidth || body.getBoundingClientRect().width;
  const chatOpen = !chat.classList.contains('collapsed') &&
    (typeof getComputedStyle !== 'function' || getComputedStyle(chat).display !== 'none');
  const next = shouldUseCodeFileOverlay({
    containerWidth: bodyWidth,
    chatSidebarWidth: cssPixelValue(body, '--sidebar-w', DEFAULT_CHAT_SIDEBAR_W),
    fileSidebarWidth: cssPixelValue(body, '--file-sidebar-w', DEFAULT_FILE_SIDEBAR_W),
    chatSidebarOpen: chatOpen,
    narrowLayout: isNarrowLayout(),
  });
  const previous = root.classList.contains(FILE_OVERLAY_CLASS);

  root.classList.toggle(FILE_OVERLAY_CLASS, next);
  if (previous !== next) closeTransientFileDrawer();
  return next;
}
