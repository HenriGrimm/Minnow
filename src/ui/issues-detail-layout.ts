/** Floating issue panel chrome. The issue editor remains mounted across tab changes. */
import { applyIcon } from './icon';
import { isContextMenuOpen } from './context-menu';
import { isAppDialogOpen } from './app-dialog';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';

let maximized = false;
let active = false;
let restoreFocus: HTMLElement | null = null;
let closePanel: (() => void) | undefined;
let listening = false;

function panelHost(): HTMLElement | null {
  return document.getElementById('issuesDetailHost');
}

function onPanelKeydown(event: KeyboardEvent): void {
  if (!active || event.defaultPrevented || isContextMenuOpen() || isAppDialogOpen()) return;
  const host = panelHost();
  if (!host || event.key !== 'Tab') return;
  // Portaled menus, pickers and dialogs own their keyboard handling.
  const target = event.target as HTMLElement | null;
  if (target && !host.contains(target) && target !== document.body) return;
  const controls = [...host.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, a[href], [tabindex], [contenteditable="true"]')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
  const first = controls[0];
  const last = controls.at(-1);
  if (!first) { event.preventDefault(); host.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === host)) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === host)) {
    event.preventDefault(); first.focus();
  }
}

/** The expand button maximizes the floating panel; it never docks it. */
export function isIssueDetailSheetExpanded(): boolean { return maximized; }

export function setIssueDetailSheetExpanded(value: boolean): void {
  maximized = value;
  refreshIssuesPeekLayoutChrome();
}

export function refreshIssuesPeekLayoutChrome(): void {
  const host = panelHost();
  const open = Boolean(host?.classList.contains('is-open'));
  const shell = document.querySelector('#issuesView .issues-shell');
  shell?.classList.toggle('is-detail-expanded', open);
  shell?.classList.toggle('is-detail-maximized', open && maximized);
  const scrim = document.getElementById('issuesDetailScrim');
  if (scrim) scrim.hidden = !open;
  // Only the list behind the panel is inert; portaled menus stay interactive.
  document.querySelectorAll<HTMLElement>('#issuesView .issues-list-pane, #issuesView .issues-selection-bar').forEach((el) => { el.inert = open; });
  const button = host?.querySelector<HTMLButtonElement>('.issues-detail__layout-expand');
  if (button) {
    const label = maximized ? 'Restore issue panel size' : 'Maximize issue panel';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(maximized));
    const icon = button.querySelector<HTMLElement>('.icon-svg');
    if (icon) applyIcon(icon, maximized ? 'compress' : 'expand', { size: 16 });
  }
  if (open === active) return;
  active = open;
  if (open) {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (host) markPreviewOccluder(host, 'dialog');
    if (scrim) markPreviewOccluder(scrim, 'dialog');
    document.addEventListener('keydown', onPanelKeydown);
    listening = true;
  } else {
    if (host) unmarkPreviewOccluder(host);
    if (scrim) unmarkPreviewOccluder(scrim);
    document.removeEventListener('keydown', onPanelKeydown);
    listening = false;
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
    restoreFocus = null;
  }
}

export function ensureIssuesPeekLayout(host: HTMLElement, onClose: () => void): void {
  const body = document.querySelector('#issuesView .issues-body');
  if (!body) return;
  closePanel = onClose;
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.tabIndex = -1;
  if (host.parentElement !== body) body.appendChild(host);
  if (!document.getElementById('issuesDetailScrim')) {
    const scrim = document.createElement('button');
    scrim.type = 'button';
    scrim.id = 'issuesDetailScrim';
    scrim.className = 'issues-detail-scrim';
    scrim.hidden = true;
    scrim.tabIndex = -1;
    scrim.setAttribute('aria-label', 'Close issue detail');
    scrim.addEventListener('click', () => closePanel?.());
    body.insertBefore(scrim, host);
  }
  refreshIssuesPeekLayoutChrome();
}

export function resetIssueDetailSheetOnClose(): void {
  maximized = false;
  refreshIssuesPeekLayoutChrome();
}

export function resetIssuesDetailLayoutForTests(): void {
  maximized = false;
  const host = panelHost();
  const scrim = document.getElementById('issuesDetailScrim');
  if (host) unmarkPreviewOccluder(host);
  if (scrim) unmarkPreviewOccluder(scrim);
  if (listening) document.removeEventListener('keydown', onPanelKeydown);
  active = false;
  listening = false;
  restoreFocus = null;
  closePanel = undefined;
}
