/**
 * User-facing Minnow app availability preferences.
 * Persists disabled optional app ids under minnow.os.disabledApps.
 * Missing storage means all released optional apps are enabled.
 */

import {
  getAppById,
  isCoreApp,
  isDeveloperReleased,
  listOptionalReleasedApps,
  listReleasedApps,
} from './app-registry';
import type { AppDefinition } from './app-registry';
import { closeUnavailableAppSurfaces } from './app-surface-cleanup';
import type { AppId } from './types';

// ── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'minnow.os.disabledApps';

type AppPreferencesListener = () => void;

const listeners = new Set<AppPreferencesListener>();
let cachedDisabled: ReadonlySet<AppId> | null = null;

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {}
}

function removeStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Normalize persisted disabled ids: only optional released apps may be disabled. */
export function normalizeDisabledAppIds(raw: unknown): AppId[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(listOptionalReleasedApps().map((app) => app.id));
  const out: AppId[] = [];
  const seen = new Set<AppId>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item as AppId;
    if (!allowed.has(id) || seen.has(id)) continue;
    if (isCoreApp(id) || !isDeveloperReleased(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseDisabledFromStorage(): ReadonlySet<AppId> {
  const raw = readStorage();
  if (raw == null) return new Set();
  try {
    return new Set(normalizeDisabledAppIds(JSON.parse(raw) as unknown));
  } catch {
    return new Set();
  }
}

/** Load the set of user-disabled optional app ids (empty = all released optionals on). */
export function loadDisabledAppIds(): ReadonlySet<AppId> {
  if (cachedDisabled) return cachedDisabled;
  cachedDisabled = parseDisabledFromStorage();
  return cachedDisabled;
}

function emitAppPreferences(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

function persistDisabled(ids: readonly AppId[]): void {
  const normalized = normalizeDisabledAppIds(ids);
  cachedDisabled = new Set(normalized);
  if (normalized.length === 0) {
    removeStorage();
  } else {
    writeStorage(JSON.stringify(normalized));
  }
  emitAppPreferences();
  closeUnavailableAppSurfaces();
}

// ── Enable ───────────────────────────────────────────────────────────────────

/** Persist the full disabled-optional set and notify subscribers. */
export function saveDisabledAppIds(ids: readonly AppId[]): void {
  persistDisabled(ids);
}

/**
 * Replace enabled optional apps with the given selection.
 * Core apps are always enabled; unreleased apps are ignored.
 */
export function setEnabledOptionalApps(enabledIds: readonly AppId[]): void {
  const enabled = new Set(enabledIds);
  const disabled = listOptionalReleasedApps()
    .map((app) => app.id)
    .filter((id) => !enabled.has(id));
  persistDisabled(disabled);
}

/** Enable or disable one optional released app. Core / hidden ids are no-ops. */
export function setAppEnabled(appId: AppId, enabled: boolean): void {
  if (isCoreApp(appId) || !isDeveloperReleased(appId)) return;
  const next = new Set(loadDisabledAppIds());
  if (enabled) next.delete(appId);
  else next.add(appId);
  persistDisabled([...next]);
}

/** True when the app is developer-released and not user-disabled (core always when released). */
export function isAppEnabled(appId: AppId): boolean {
  if (!isDeveloperReleased(appId)) return false;
  if (isCoreApp(appId)) return true;
  return !loadDisabledAppIds().has(appId);
}

/**
 * True when the app may appear in launch surfaces and open via deep links.
 * Alias of isAppEnabled for call sites that read as "available".
 */
export function isAppAvailable(appId: AppId): boolean {
  return isAppEnabled(appId);
}

/** Why an app cannot be launched, or null when it can. */
export function getAppUnavailableReason(
  appId: AppId,
): 'unknown' | 'developer-hidden' | 'user-disabled' | null {
  const def = getAppById(appId);
  if (!def) return 'unknown';
  if (!isDeveloperReleased(appId)) return 'developer-hidden';
  if (!isAppEnabled(appId)) return 'user-disabled';
  return null;
}

/** Released apps that are currently available to the user. */
export function listAvailableApps(): AppDefinition[] {
  return listReleasedApps().filter((app) => isAppEnabled(app.id));
}

// ── Lists ────────────────────────────────────────────────────────────────────

/** Fixed roster for the left app rail. */
const RAIL_PRIMARY_APP_IDS: AppId[] = [
  'code',
  'source-control',
  'research',
  'issues',
  'brain',
  'models',
  'scheduler',
];

/** Available apps shown on the workspace rail. */
export function listRailApps(): AppDefinition[] {
  const out: AppDefinition[] = [];
  for (const id of RAIL_PRIMARY_APP_IDS) {
    const def = getAppById(id);
    if (def && isAppEnabled(id)) out.push(def);
  }
  return out;
}

/** Available apps for the dock. */
export function listDockApps(): AppDefinition[] {
  return listAvailableApps();
}

/** Optional released apps currently enabled by the user. */
export function listEnabledOptionalAppIds(): AppId[] {
  return listOptionalReleasedApps()
    .map((app) => app.id)
    .filter((id) => isAppEnabled(id));
}

/** Subscribe to preference changes; returns unsubscribe. */
export function subscribeAppPreferences(listener: AppPreferencesListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear cache and listeners (tests). Callers should clear localStorage when needed. */
export function resetAppPreferencesForTests(): void {
  cachedDisabled = null;
  listeners.clear();
}
