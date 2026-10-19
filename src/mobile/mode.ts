/**
 * Whether this renderer boots the dedicated phone app instead of the desktop shell.
 *
 * Decided once at boot: a phone keeps the phone app through rotation, and a
 * desktop window narrowed past the breakpoint keeps the desktop shell.
 */

import { isPhoneLayout } from '../ui/mobile-layout';

/** `?mobile=0` / `?mobile=1` override, remembered per browser. */
const PREFERENCE_KEY = 'minnow.mobile.shell';
const ROOT_CLASS = 'mn-mobile-app';

let decided: boolean | null = null;

function readPreference(): 'on' | 'off' | null {
  try {
    const query = new URLSearchParams(window.location.search).get('mobile');
    if (query === '1' || query === '0') {
      window.localStorage.setItem(PREFERENCE_KEY, query === '1' ? 'on' : 'off');
    }
    const saved = window.localStorage.getItem(PREFERENCE_KEY);
    return saved === 'on' || saved === 'off' ? saved : null;
  } catch {
    return null;
  }
}

/** Remember whether this browser wants the phone app; applies on the next load. */
export function setMobileShellPreference(value: 'on' | 'off' | null): void {
  try {
    if (value) window.localStorage.setItem(PREFERENCE_KEY, value);
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {}
}

function decide(): boolean {
  if (typeof window === 'undefined') return false;
  // Electron windows and app windows are always the desktop shell.
  if (window.minnow) return false;
  const preference = readPreference();
  if (preference === 'on') return true;
  if (preference === 'off') return false;
  return isPhoneLayout();
}

/** True when this page runs the phone app. Stable for the page's lifetime. */
export function isMobileShell(): boolean {
  decided ??= decide();
  return decided;
}

/** Stamp `html.mn-mobile-app` before any desktop chrome paints. */
export function applyMobileShellRootClass(): boolean {
  const enabled = isMobileShell();
  document.documentElement.classList.toggle(ROOT_CLASS, enabled);
  return enabled;
}

/** Test hook. */
export function resetMobileShellModeForTests(value: boolean | null = null): void {
  decided = value;
}
