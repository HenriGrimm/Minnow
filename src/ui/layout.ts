import { sessionState } from '../state/sessions';
import { scheduleSaveSessions } from '../state/sessions';
import { emitChatSidebarChanged } from './layout-events';
import { mountOsMobileDrawerBackdrops, syncOsMobileDrawerHtmlClass } from './mobile-drawer-portal';
import { isNarrowLayout } from './mobile-layout';
import {
  syncAppBodySidebarWidthVars,
  syncChatSidebarResizer,
} from './sidebar-resize';

export function isMobileLayout(): boolean {
  return isNarrowLayout();
}

/** Whether the chat session list is visible (desktop expanded or narrow overlay open). */
export function isChatSidebarOpen(): boolean {
  const panel = document.getElementById('chatSidebar');
  if (!panel) return false;
  if (isMobileLayout()) {
    return panel.classList.contains('mobile-open');
  }
  return !panel.classList.contains('collapsed');
}

export function closeMobileSidebar(): void {
  const side = document.getElementById('chatSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (side) side.classList.remove('mobile-open');
  syncOsMobileDrawerHtmlClass('chat', false);
  if (bd) {
    bd.classList.remove('open');
    bd.setAttribute('aria-hidden', 'true');
    (bd as HTMLButtonElement).tabIndex = -1;
  }
}

export function openMobileSidebar(): void {
  if (!isMobileLayout()) return;
  mountOsMobileDrawerBackdrops();
  const side = document.getElementById('chatSidebar');
  const bd = document.getElementById('sidebarBackdrop');
  if (side) side.classList.add('mobile-open');
  syncOsMobileDrawerHtmlClass('chat', true);
  if (bd) {
    bd.classList.add('open');
    bd.setAttribute('aria-hidden', 'false');
    (bd as HTMLButtonElement).tabIndex = 0;
  }
}

export function applySidebarVisuals(): void {
  const side = document.getElementById('chatSidebar');
  if (!side || !sessionState) return;
  if (isMobileLayout()) {
    mountOsMobileDrawerBackdrops();
    syncOsMobileDrawerHtmlClass('chat', side.classList.contains('mobile-open'));
  } else {
    syncOsMobileDrawerHtmlClass('chat', false);
    closeMobileSidebar();
  }
  side.classList.toggle('collapsed', sessionState.sidebarCollapsed);
  scheduleElectronPreviewHostLayoutAfterChatSidebarChange();
  syncAppBodySidebarWidthVars();
  syncChatSidebarResizer();
  emitChatSidebarChanged();
}

/** Re-align the Electron preview guest when the chat rail width changes. */
function scheduleElectronPreviewHostLayoutAfterChatSidebarChange(): void {
  void import('../state/file-panel').then(({ getFilePanelState }) => {
    if (getFilePanelState().rightPaneMode !== 'preview') return;
    void import('./preview-electron-visibility').then((m) => {
      m.scheduleElectronPreviewHostLayoutSync();
    });
  });
}

export function toggleSidebarLayout(): void {
  if (isMobileLayout()) {
    const side = document.getElementById('chatSidebar');
    if (side && side.classList.contains('mobile-open')) closeMobileSidebar();
    else openMobileSidebar();
    applySidebarVisuals();
    void import('./sidebar').then((m) => m.renderSidebar());
  } else {
    sessionState!.sidebarCollapsed = !sessionState!.sidebarCollapsed;
    applySidebarVisuals();
    scheduleSaveSessions();
    void import('./sidebar').then((m) => m.renderSidebar());
  }
}
