/**
 * Reparents workspace folder control into the OS menubar left cluster while any app is foreground.
 */

import { getOsView } from './instances';
import { isOsShellEnabled } from './page-bridge';

const WORKSPACE_CONTROL_SELECTOR = '.workspace-control';
const HOME_SLOT_ID = 'workspaceControlSlot';
const MENUBAR_SLOT_ID = 'osMenubarWorkspaceSlot';

function getWorkspaceControl(): HTMLElement | null {
  return document.querySelector(WORKSPACE_CONTROL_SELECTOR);
}

function getHomeSlot(): HTMLElement | null {
  return document.getElementById(HOME_SLOT_ID);
}

function getMenubarSlot(): HTMLElement | null {
  return document.getElementById(MENUBAR_SLOT_ID);
}

/** True when workspace controls should live in the menubar left slot. */
export function shouldMountWorkspaceInMenubar(): boolean {
  if (!isOsShellEnabled()) return false;
  return getOsView() === 'app';
}

/** Move workspace controls into the menubar (every app). */
export function mountWorkspaceToMenubar(): void {
  if (!shouldMountWorkspaceInMenubar()) return;

  const control = getWorkspaceControl();
  const menubarSlot = getMenubarSlot();
  const homeSlot = getHomeSlot();
  if (!control || !menubarSlot || !homeSlot) return;
  if (control.parentElement === menubarSlot) return;

  menubarSlot.hidden = false;
  menubarSlot.appendChild(control);
  control.classList.add('is-in-menubar');
}

/** Return workspace controls to the top bar home slot. */
export function unmountWorkspaceFromMenubar(): void {
  const control = getWorkspaceControl();
  const homeSlot = getHomeSlot();
  const menubarSlot = getMenubarSlot();
  if (!control || !homeSlot) return;
  if (control.parentElement === homeSlot) return;

  homeSlot.appendChild(control);
  control.classList.remove('is-in-menubar');
  if (menubarSlot) menubarSlot.hidden = true;
}

/** Keep workspace placement aligned with foreground app. */
export function syncWorkspaceMenubarPlacement(): void {
  if (shouldMountWorkspaceInMenubar()) {
    mountWorkspaceToMenubar();
  } else {
    unmountWorkspaceFromMenubar();
  }
}

/** Whether workspace controls currently live in the menubar (tests). */
export function isWorkspaceInMenubar(): boolean {
  const control = getWorkspaceControl();
  const menubarSlot = getMenubarSlot();
  return Boolean(control && menubarSlot && control.parentElement === menubarSlot);
}
