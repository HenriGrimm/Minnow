/**
 * Persist Settings → Appearance to ~/.minnow/appearance.json.
 * localStorage remains the FOUC cache; the home file is the source of truth
 * across Electron origins (packaged builds bind a new port unless 9473 is free).
 */

import { isServerStorageMode } from '../config/storage-mode';
import {
  APPEARANCE_STORAGE_KEYS,
  DEFAULT_APPEARANCE_FONTS,
  type AppearanceFonts,
} from './types';
import { setAppearancePersistScheduler } from './persist-schedule';

const THEME_STORAGE_KEY = 'minnow.theme';
const THEME_FOLLOW_SYSTEM_KEY = 'minnow.theme.followSystem';
const THEME_FAMILY_KEY = 'minnow.theme.family';

const SAVE_DEBOUNCE_MS = 300;
const APPEARANCE_PATH = '/api/config/appearance';

export interface AppearancePersistState {
  version: 1;
  chatView?: 'compact' | 'full';
  followSystem: boolean;
  family: string;
  themeId: string;
  customEnabled: boolean;
  customAdvanced: boolean;
  customTokens: Record<string, string>;
  fonts: AppearanceFonts;
  updatedAt: string | null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let persistSuppressed = false;
let persistenceInstalled = false;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function parseFonts(raw: string | null): AppearanceFonts {
  if (!raw) return { ui: { ...DEFAULT_APPEARANCE_FONTS.ui }, mono: { ...DEFAULT_APPEARANCE_FONTS.mono } };
  try {
    const data = JSON.parse(raw) as { ui?: AppearanceFonts['ui']; mono?: AppearanceFonts['mono'] };
    return {
      ui: data.ui ?? { ...DEFAULT_APPEARANCE_FONTS.ui },
      mono: data.mono ?? { ...DEFAULT_APPEARANCE_FONTS.mono },
    };
  } catch {
    return { ui: { ...DEFAULT_APPEARANCE_FONTS.ui }, mono: { ...DEFAULT_APPEARANCE_FONTS.mono } };
  }
}

function parseTokens(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Snapshot browser-local appearance keys for a PUT. */
export function snapshotAppearanceFromLocalStorage(): AppearancePersistState {
  const followSystem = readStorage(THEME_FOLLOW_SYSTEM_KEY) === '1';
  const themeId = readStorage(THEME_STORAGE_KEY) || 'swamp-dark';
  const familyFromId = themeId.includes('-') ? themeId.slice(0, themeId.lastIndexOf('-')) : 'swamp';
  const family = followSystem ? readStorage(THEME_FAMILY_KEY) || familyFromId : familyFromId;
  return {
    version: 1,
    chatView: readStorage(APPEARANCE_STORAGE_KEYS.chatView) === 'full' ? 'full' : 'compact',
    followSystem,
    family,
    themeId: followSystem ? `${family}-dark` : themeId,
    customEnabled: readStorage(APPEARANCE_STORAGE_KEYS.customEnabled) === '1',
    customAdvanced: readStorage(APPEARANCE_STORAGE_KEYS.customAdvanced) === '1',
    customTokens: parseTokens(readStorage(APPEARANCE_STORAGE_KEYS.customTokens)),
    fonts: parseFonts(readStorage(APPEARANCE_STORAGE_KEYS.fonts)),
    updatedAt: new Date().toISOString(),
  };
}

/** True when localStorage holds a choice worth migrating to disk. */
export function localAppearanceHasUserChoice(state: AppearancePersistState): boolean {
  if (state.chatView === 'full') return true;
  if (state.followSystem) return true;
  if (state.themeId && state.themeId !== 'swamp-dark') return true;
  if (state.family && state.family !== 'swamp') return true;
  if (state.customEnabled) return true;
  if (Object.keys(state.customTokens).length > 0) return true;
  if (state.fonts.ui.kind !== 'preset' || state.fonts.ui.id !== 'system') return true;
  if (state.fonts.mono.kind !== 'preset' || state.fonts.mono.id !== 'system') return true;
  return false;
}

/** Write a persisted blob into localStorage without scheduling another PUT. */
export function applyAppearanceToLocalStorage(state: AppearancePersistState): boolean {
  const before = snapshotAppearanceFromLocalStorage();
  persistSuppressed = true;
  try {
    writeStorage(APPEARANCE_STORAGE_KEYS.chatView, state.chatView === 'full' ? 'full' : 'compact');
    if (state.followSystem) {
      writeStorage(THEME_FOLLOW_SYSTEM_KEY, '1');
      writeStorage(THEME_FAMILY_KEY, state.family || 'swamp');
      removeStorage(THEME_STORAGE_KEY);
    } else {
      removeStorage(THEME_FOLLOW_SYSTEM_KEY);
      writeStorage(THEME_STORAGE_KEY, state.themeId || 'swamp-dark');
      if (state.family) writeStorage(THEME_FAMILY_KEY, state.family);
    }

    if (state.customEnabled) {
      writeStorage(APPEARANCE_STORAGE_KEYS.customEnabled, '1');
    } else {
      removeStorage(APPEARANCE_STORAGE_KEYS.customEnabled);
    }
    if (state.customAdvanced) {
      writeStorage(APPEARANCE_STORAGE_KEYS.customAdvanced, '1');
    } else {
      removeStorage(APPEARANCE_STORAGE_KEYS.customAdvanced);
    }
    if (state.customTokens && Object.keys(state.customTokens).length) {
      writeStorage(APPEARANCE_STORAGE_KEYS.customTokens, JSON.stringify(state.customTokens));
    } else {
      removeStorage(APPEARANCE_STORAGE_KEYS.customTokens);
    }
    writeStorage(APPEARANCE_STORAGE_KEYS.fonts, JSON.stringify(state.fonts));
  } finally {
    persistSuppressed = false;
  }

  const after = snapshotAppearanceFromLocalStorage();
  return (
    before.chatView !== after.chatView ||
    before.followSystem !== after.followSystem ||
    before.themeId !== after.themeId ||
    before.family !== after.family ||
    before.customEnabled !== after.customEnabled ||
    before.customAdvanced !== after.customAdvanced ||
    JSON.stringify(before.customTokens) !== JSON.stringify(after.customTokens) ||
    JSON.stringify(before.fonts) !== JSON.stringify(after.fonts)
  );
}

/** Seed localStorage from the HTML-injected boot payload (FOUC + empty origin). */
export function seedLocalStorageFromAppearanceBoot(): boolean {
  const boot =
    typeof globalThis.window !== 'undefined' ? globalThis.window.__MINNOW_APPEARANCE_BOOT__ : undefined;
  if (!boot || typeof boot !== 'object') return false;
  const state: AppearancePersistState = {
    version: 1,
    chatView: boot.chatView === 'full' ? 'full' : 'compact',
    followSystem: boot.followSystem === true,
    family: typeof boot.family === 'string' ? boot.family : 'swamp',
    themeId: typeof boot.themeId === 'string' ? boot.themeId : 'swamp-dark',
    customEnabled: boot.customEnabled === true,
    customAdvanced: boot.customAdvanced === true,
    customTokens: boot.customTokens && typeof boot.customTokens === 'object' ? boot.customTokens : {},
    fonts: boot.fonts ?? { ui: { ...DEFAULT_APPEARANCE_FONTS.ui }, mono: { ...DEFAULT_APPEARANCE_FONTS.mono } },
    updatedAt: null,
  };
  return applyAppearanceToLocalStorage(state);
}

async function putAppearance(state: AppearancePersistState): Promise<void> {
  const res = await fetch(APPEARANCE_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    throw new Error(`appearance PUT failed (${res.status})`);
  }
}

async function getAppearance(): Promise<AppearancePersistState | null> {
  const res = await fetch(APPEARANCE_PATH, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as AppearancePersistState;
}

async function flushAppearanceNow(): Promise<void> {
  if (persistSuppressed || !isServerStorageMode()) return;
  const snapshot = snapshotAppearanceFromLocalStorage();
  try {
    await putAppearance(snapshot);
  } catch {
    // Keep the localStorage cache; next boot with a live server will retry.
  }
}

/** Debounced write of the current localStorage appearance to ~/.minnow. */
export function schedulePersistAppearance(): void {
  if (persistSuppressed || !isServerStorageMode()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushAppearanceNow();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Load appearance.json after the config server is up.
 * Server file wins when it has been saved; otherwise migrate localStorage up.
 * @returns true when localStorage (and therefore the live theme) changed.
 */
export async function hydrateAppearanceFromServer(): Promise<boolean> {
  if (!isServerStorageMode()) return false;
  persistSuppressed = true;
  try {
    const remote = await getAppearance();
    if (!remote) return false;
    if (!remote.updatedAt && !localAppearanceHasUserChoice(remote)) {
      const local = snapshotAppearanceFromLocalStorage();
      if (localAppearanceHasUserChoice(local)) {
        persistSuppressed = false;
        await putAppearance(local);
      }
      return false;
    }
    return applyAppearanceToLocalStorage(remote);
  } catch {
    return false;
  } finally {
    persistSuppressed = false;
  }
}

/** Wire theme/font/color writes to disk persistence. Call once after detectConfigServer. */
export function installAppearancePersistence(): void {
  if (persistenceInstalled) return;
  persistenceInstalled = true;
  setAppearancePersistScheduler(schedulePersistAppearance);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      void flushAppearanceNow();
    });
  }
}

/** Test helper: drop debounce state. */
export function resetAppearancePersistForTests(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  persistSuppressed = false;
  persistenceInstalled = false;
  setAppearancePersistScheduler(() => {});
}
