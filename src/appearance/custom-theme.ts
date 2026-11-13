/**
 * Runtime custom palette token overrides on top of preset themes.
 */

import { repairLegacyMirroredSuccess } from './theme-derive';
import {
  APPEARANCE_STORAGE_KEYS,
  CORE_THEME_TOKEN_KEYS,
  type CoreThemeTokenKey,
  type CustomThemeTokens,
  tokenKeyToCssVar,
} from './types';
import { scheduleAppearancePersist } from './persist-schedule';

type CustomThemeListener = () => void;

const listeners = new Set<CustomThemeListener>();

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
  scheduleAppearancePersist();
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
  scheduleAppearancePersist();
}

function emitChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

function isCoreTokenKey(key: string): key is CoreThemeTokenKey {
  return (CORE_THEME_TOKEN_KEYS as readonly string[]).includes(key);
}

/** Whether custom color overrides are active. */
export function isCustomThemeEnabled(): boolean {
  return readStorage(APPEARANCE_STORAGE_KEYS.customEnabled) === '1';
}

/** Whether the per-token advanced editor is active (false = simplified seed mode). */
export function isCustomThemeAdvanced(): boolean {
  return readStorage(APPEARANCE_STORAGE_KEYS.customAdvanced) === '1';
}

/** Persist simplified vs advanced custom color editor mode. */
export function setCustomThemeAdvanced(advanced: boolean): void {
  if (advanced) {
    writeStorage(APPEARANCE_STORAGE_KEYS.customAdvanced, '1');
  } else {
    removeStorage(APPEARANCE_STORAGE_KEYS.customAdvanced);
  }
}

/** Read stored custom token map (may be partial). */
export function getCustomThemeTokens(): CustomThemeTokens {
  const raw = readStorage(APPEARANCE_STORAGE_KEYS.customTokens);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: CustomThemeTokens = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isCoreTokenKey(k) && typeof v === 'string' && v.trim()) {
        out[k] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Read custom --mn-bg for boot theme-color meta. */
export function getCustomBootBgColor(): string | null {
  if (!isCustomThemeEnabled()) return null;
  return getCustomThemeTokens().bg ?? null;
}

/**
 * Fix stored simplified palettes that cloned success from accent, then return
 * the map to apply. Advanced editor tokens are left untouched.
 */
function maybeRepairStoredSuccess(map: CustomThemeTokens): CustomThemeTokens {
  if (isCustomThemeAdvanced()) return map;
  const repaired = repairLegacyMirroredSuccess(map);
  if (repaired === map) return map;
  writeStorage(APPEARANCE_STORAGE_KEYS.customTokens, JSON.stringify(repaired));
  return repaired;
}

/** Apply inline --mn-* overrides on documentElement. */
export function applyCustomTheme(tokens?: CustomThemeTokens): void {
  const root = document.documentElement;
  const map = maybeRepairStoredSuccess(tokens ?? getCustomThemeTokens());
  if (!isCustomThemeEnabled()) {
    clearCustomTheme();
    return;
  }
  for (const key of CORE_THEME_TOKEN_KEYS) {
    const value = map[key];
    const cssVar = tokenKeyToCssVar(key);
    if (value) {
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
  if (map.accent) root.style.setProperty('--mn-graphite-button', 'var(--mn-accent)');
  else root.style.removeProperty('--mn-graphite-button');
  if (map['fg-on-accent']) root.style.setProperty('--mn-graphite-button-text', 'var(--mn-fg-on-accent)');
  else root.style.removeProperty('--mn-graphite-button-text');
  updateThemeColorMetaFromCustom();
  emitChange();
}

/** Remove all inline custom token overrides. */
export function clearCustomTheme(): void {
  const root = document.documentElement;
  for (const key of CORE_THEME_TOKEN_KEYS) {
    root.style.removeProperty(tokenKeyToCssVar(key));
  }
  root.style.removeProperty('--mn-graphite-button');
  root.style.removeProperty('--mn-graphite-button-text');
}

function updateThemeColorMetaFromCustom(): void {
  const bg = getCustomThemeTokens().bg;
  if (!bg) return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
}

/** Enable custom mode and persist tokens. */
export function setCustomThemeEnabled(enabled: boolean): void {
  if (enabled) {
    writeStorage(APPEARANCE_STORAGE_KEYS.customEnabled, '1');
    applyCustomTheme();
  } else {
    removeStorage(APPEARANCE_STORAGE_KEYS.customEnabled);
    clearCustomTheme();
    emitChange();
  }
}

/** Merge and persist token overrides, then apply. */
export function setCustomThemeTokens(tokens: CustomThemeTokens): void {
  const merged = { ...getCustomThemeTokens(), ...tokens };
  writeStorage(APPEARANCE_STORAGE_KEYS.customTokens, JSON.stringify(merged));
  if (isCustomThemeEnabled()) {
    applyCustomTheme(merged);
  }
}

/** Replace entire custom token map. */
export function replaceCustomThemeTokens(tokens: CustomThemeTokens): void {
  writeStorage(APPEARANCE_STORAGE_KEYS.customTokens, JSON.stringify(tokens));
  if (isCustomThemeEnabled()) {
    applyCustomTheme(tokens);
  }
}

/** Reset custom tokens and disable overrides. */
export function resetCustomTheme(): void {
  removeStorage(APPEARANCE_STORAGE_KEYS.customTokens);
  removeStorage(APPEARANCE_STORAGE_KEYS.customEnabled);
  removeStorage(APPEARANCE_STORAGE_KEYS.customAdvanced);
  clearCustomTheme();
  emitChange();
}

/** Read computed value for a token from the active preset (before custom inline). */
export function readPresetTokenValue(key: CoreThemeTokenKey): string {
  const cssVar = tokenKeyToCssVar(key);
  const root = document.documentElement;
  const hadInline = root.style.getPropertyValue(cssVar);
  if (hadInline) root.style.removeProperty(cssVar);
  const value = getComputedStyle(root).getPropertyValue(cssVar).trim();
  if (hadInline) root.style.setProperty(cssVar, hadInline);
  return value;
}

/** Snapshot all core tokens from computed styles (preset + any active custom). */
export function readEffectiveThemeTokens(): Record<CoreThemeTokenKey, string> {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const out = {} as Record<CoreThemeTokenKey, string>;
  for (const key of CORE_THEME_TOKEN_KEYS) {
    out[key] = style.getPropertyValue(tokenKeyToCssVar(key)).trim();
  }
  return out;
}

/** Export custom theme JSON for sharing. */
export function exportCustomThemeJson(): string {
  const enabled = isCustomThemeEnabled();
  const stored = getCustomThemeTokens();
  const tokens =
    enabled && typeof getComputedStyle === 'function'
      ? { ...readEffectiveThemeTokens(), ...stored }
      : stored;
  return JSON.stringify(
    {
      version: 1,
      enabled,
      tokens,
    },
    null,
    2,
  );
}

/** Parse a palette without changing the active colors. */
export function parseCustomThemeJson(raw: string): { tokens: CustomThemeTokens; enabled: boolean } | null {
  try {
    const data = JSON.parse(raw) as {
      version?: number;
      enabled?: boolean;
      tokens?: Record<string, string>;
    };
    if (!data?.tokens || typeof data.tokens !== 'object' || Array.isArray(data.tokens)) return null;
    const tokens: CustomThemeTokens = {};
    for (const [k, v] of Object.entries(data.tokens)) {
      if (isCoreTokenKey(k) && typeof v === 'string' && v.trim()) tokens[k] = v.trim();
    }
    return { tokens, enabled: data.enabled !== false };
  } catch {
    return null;
  }
}

export function saveCustomThemeOverrides(tokens: CustomThemeTokens, enabled: boolean): void {
  setCustomThemeAdvanced(true);
  writeStorage(APPEARANCE_STORAGE_KEYS.customTokens, JSON.stringify(tokens));
  setCustomThemeEnabled(enabled);
}

/** Import custom theme JSON; returns false on invalid input. */
export function importCustomThemeJson(raw: string): boolean {
  const palette = parseCustomThemeJson(raw);
  if (!palette) return false;
  saveCustomThemeOverrides(palette.tokens, palette.enabled);
  return true;
}

/** Subscribe to custom theme changes. */
export function subscribeCustomThemeChanges(listener: CustomThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clear storage (tests). */
export function resetCustomThemeForTests(): void {
  resetCustomTheme();
  listeners.clear();
}
