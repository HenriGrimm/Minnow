import hljsDarkStylesheetUrl from 'highlight.js/styles/github-dark.min.css?url';
import { refreshHljsInDocument } from '../markdown/highlighter';
import {
  applyTheme as applyThemeId,
  getFollowSystem,
  getMode,
  getStoredTheme,
  getThemePreference,
  initTheme as initThemeCore,
  resolveTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  setThemePreference as persistThemePreference,
  syncThemeListeners,
  type LegacyThemePreference,
  type ThemeFamily,
  type ThemeId,
  type ThemeMode,
} from '../theme';
import {
  applyCustomTheme,
  isCustomThemeEnabled,
  subscribeCustomThemeChanges,
} from '../appearance/custom-theme';
import {
  applyAppearanceFonts,
  subscribeAppearanceFonts,
} from '../appearance/fonts';
import { seedLocalStorageFromAppearanceBoot } from '../appearance/persist';
import { applyGraphitePreferences } from '../appearance/graphite-preferences';

export {
  getFollowSystem,
  getStoredTheme,
  getThemePreference,
  resolveTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  syncThemeListeners,
  type LegacyThemePreference as ThemePreference,
  type ThemeFamily,
  type ThemeId,
  type ThemeMode,
};

const HLJS_DARK_LINK_ID = 'minnow-hljs-github-dark';

function syncHljsDarkStylesheet(effective: ThemeMode): void {
  const existing = document.getElementById(HLJS_DARK_LINK_ID) as HTMLLinkElement | null;
  if (effective === 'dark') {
    if (existing) return;
    const link = document.createElement('link');
    link.id = HLJS_DARK_LINK_ID;
    link.rel = 'stylesheet';
    link.href = hljsDarkStylesheetUrl;
    document.head.appendChild(link);
  } else if (existing) {
    existing.remove();
  }
}

/** Apply effective theme to DOM and dependent surfaces. */
export function applyResolvedTheme(id: ThemeId): void {
  applyGraphitePreferences();
  applyThemeId(id, { persist: false });
  if (isCustomThemeEnabled()) {
    applyCustomTheme();
  }
  void applyAppearanceFonts();
  syncHljsDarkStylesheet(getMode(id));
  refreshHljsInDocument();
}

/** @deprecated Use applyResolvedTheme(getStoredTheme()). */
export function applyThemeFromPreference(_pref?: LegacyThemePreference): void {
  applyResolvedTheme(getStoredTheme());
}

let appearanceUnsubs: Array<() => void> = [];

/** Re-apply custom tokens and fonts when appearance prefs change. */
function wireAppearanceListeners(): void {
  for (const unsub of appearanceUnsubs) unsub();
  appearanceUnsubs = [
    subscribeCustomThemeChanges(() => {
      if (!isCustomThemeEnabled()) applyResolvedTheme(getStoredTheme());
    }),
    subscribeAppearanceFonts(() => {
      void applyAppearanceFonts();
    }),
  ];
}

/** Call once at startup after DOM exists. */
export function initTheme(): void {
  seedLocalStorageFromAppearanceBoot();
  initThemeCore();
  syncThemeListeners();
  wireAppearanceListeners();
  applyResolvedTheme(getStoredTheme());
}

/** Persist preference and refresh syntax highlighting. */
export function setThemePreference(pref: LegacyThemePreference): void {
  persistThemePreference(pref);
  syncThemeListeners();
  applyResolvedTheme(getStoredTheme());
}
