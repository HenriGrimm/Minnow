/**
 * Ctrl+Tab app surface cycling — MRU order over the left app rail roster.
 */

import { listRailApps } from './app-preferences';
import { getForegroundAppId } from './instances';
import { launchApp } from './router';
import type { AppId } from './types';

const RAIL_SETTINGS_ID: AppId = 'settings';

const MAX_MRU = 24;

let mruStack: AppId[] = ['code'];
let keyboardBound = false;

function listRailCycleAppIds(): AppId[] {
  const ids = listRailApps().map((app) => app.id);
  if (!ids.includes(RAIL_SETTINGS_ID)) ids.push(RAIL_SETTINGS_ID);
  return ids;
}

/** Whether an app id is on the rail and still available. */
function isRailSurfaceAvailable(id: AppId): boolean {
  return listRailCycleAppIds().includes(id);
}

/** Current surface for MRU indexing (Research embed, else foreground app). */
export function getCurrentAppSurfaceId(): AppId {
  const foreground = getForegroundAppId();
  if (foreground && isRailSurfaceAvailable(foreground)) return foreground;
  return mruStack.find((id) => isRailSurfaceAvailable(id)) ?? 'code';
}

/** Push a rail app to the front of the MRU stack after navigation. */
export function recordAppSurfaceFocus(id: AppId): void {
  if (!isRailSurfaceAvailable(id)) return;
  mruStack = [id, ...mruStack.filter((entry) => entry !== id)];
  if (mruStack.length > MAX_MRU) {
    mruStack.length = MAX_MRU;
  }
}

/** MRU rail apps, preserving recent-first order. */
export function listCycleableAppSurfaces(): AppId[] {
  const allowed = new Set(listRailCycleAppIds());
  const seen = new Set<AppId>();
  const out: AppId[] = [];
  for (const id of mruStack) {
    if (seen.has(id) || !allowed.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of listRailCycleAppIds()) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function activateSurface(id: AppId): void {
  launchApp(id);
}

/** Cycle forward (Ctrl+Tab) or backward (Ctrl+Shift+Tab) through recent rail apps. */
export function cycleAppSurfaces(direction: 'forward' | 'backward'): void {
  if (typeof window !== 'undefined' && window.minnow?.viewContext?.appId) return;
  const candidates = listCycleableAppSurfaces();
  if (candidates.length <= 1) return;

  const current = getCurrentAppSurfaceId();
  const currentIndex = candidates.indexOf(current);
  const baseIndex = currentIndex >= 0 ? currentIndex : 0;
  let nextIndex: number;
  if (direction === 'forward') {
    nextIndex = (baseIndex + 1) % candidates.length;
  } else {
    nextIndex = baseIndex === 0 ? Math.min(1, candidates.length - 1) : baseIndex - 1;
  }
  const next = candidates[nextIndex];
  if (!next || next === current) return;
  activateSurface(next);
}

/** Bind global Ctrl+Tab / Ctrl+Shift+Tab (not Cmd+Tab — reserved for OS / editor tabs on macOS). */
export function initAppFocusCycleKeyboard(): void {
  if (keyboardBound) return;
  keyboardBound = true;


  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented) return;
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'Tab') return;

      const helpPanel = document.getElementById('shellKeyboardHelpPanel');
      if (helpPanel && !helpPanel.hidden) return;

      event.preventDefault();
      cycleAppSurfaces(event.shiftKey ? 'backward' : 'forward');
    },
    true,
  );
}

/** Seed MRU from the live shell (tests / boot). */
export function syncAppSurfaceMruFromShell(): void {
  recordAppSurfaceFocus(getCurrentAppSurfaceId());
}

/** Read MRU order (tests). */
export function getAppSurfaceMruForTests(): readonly AppId[] {
  return [...mruStack];
}

/** Reset module state (tests). */
export function resetAppFocusCycleForTests(): void {
  mruStack = ['code'];
  keyboardBound = false;
}
