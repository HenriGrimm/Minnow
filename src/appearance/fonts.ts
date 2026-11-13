/**
 * UI and monospace font presets, uploads, and CSS variable application.
 */

import {
  buildGoogleFontsCss2Url,
  getMonoFontCatalogEntry,
  getUiFontCatalogEntry,
  googleSpecForPreset,
  MONO_FONT_CATALOG,
  UI_FONT_CATALOG,
  type GoogleFontSpec,
  type MonoFontPresetId,
  type UiFontPresetId,
} from './font-catalog';
import { getAppearanceAsset, getAppearanceAssetObjectUrl } from './asset-store';
import {
  APPEARANCE_STORAGE_KEYS,
  DEFAULT_APPEARANCE_FONTS,
  type AppearanceFonts,
  type FontRef,
} from './types';
import { scheduleAppearancePersist } from './persist-schedule';

export {
  buildGoogleFontsCss2Url,
  MONO_FONT_CATALOG,
  MONO_FONT_LABELS,
  MONO_FONT_PRESETS,
  UI_FONT_CATALOG,
  UI_FONT_LABELS,
  UI_FONT_PRESETS,
} from './font-catalog';

const SYSTEM_UI =
  "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const SYSTEM_MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Stylesheet id so a font switch replaces the previous Google Fonts request. */
export const GOOGLE_FONTS_LINK_ID = 'minnow-google-fonts';
const PRECONNECT_GOOGLE = 'minnow-gf-preconnect';
const PRECONNECT_GSTATIC = 'minnow-gf-static-preconnect';

function stackForFamily(family: string | undefined, fallback: string): string {
  if (!family) return fallback;
  const safe = family.replace(/['"]/g, '');
  return `'${safe}', ${fallback}`;
}

function stacksFromCatalog(
  catalog: readonly { id: string; bundledFamily?: string; google?: GoogleFontSpec }[],
  fallback: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of catalog) {
    out[entry.id] = stackForFamily(entry.bundledFamily ?? entry.google?.family, fallback);
  }
  return out;
}

/** CSS font-family stacks for built-in presets. */
export const UI_FONT_STACKS: Record<UiFontPresetId, string> = stacksFromCatalog(
  UI_FONT_CATALOG,
  SYSTEM_UI,
) as Record<UiFontPresetId, string>;

export const MONO_FONT_STACKS: Record<MonoFontPresetId, string> = stacksFromCatalog(
  MONO_FONT_CATALOG,
  SYSTEM_MONO,
) as Record<MonoFontPresetId, string>;

const registeredUploadFonts = new Map<string, FontFace>();

type FontListener = () => void;
const listeners = new Set<FontListener>();

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

function emitChange(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {}
  }
}

function isUiPreset(id: string): id is UiFontPresetId {
  return Boolean(getUiFontCatalogEntry(id));
}

function isMonoPreset(id: string): id is MonoFontPresetId {
  return Boolean(getMonoFontCatalogEntry(id));
}

function parseFontRef(raw: unknown, slot: 'ui' | 'mono'): FontRef {
  if (!raw || typeof raw !== 'object') {
    return slot === 'ui' ? DEFAULT_APPEARANCE_FONTS.ui : DEFAULT_APPEARANCE_FONTS.mono;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === 'upload' && typeof obj.assetId === 'string') {
    return {
      kind: 'upload',
      slot,
      assetId: obj.assetId,
      familyName:
        typeof obj.familyName === 'string' ? obj.familyName : `MinnowCustom${slot}`,
    };
  }
  if (obj.kind === 'preset' && typeof obj.id === 'string') {
    if (slot === 'ui' && isUiPreset(obj.id)) {
      return { kind: 'preset', slot: 'ui', id: obj.id };
    }
    if (slot === 'mono' && isMonoPreset(obj.id)) {
      return { kind: 'preset', slot: 'mono', id: obj.id };
    }
  }
  return slot === 'ui' ? DEFAULT_APPEARANCE_FONTS.ui : DEFAULT_APPEARANCE_FONTS.mono;
}

/** Load font preferences from localStorage. */
export function getAppearanceFonts(): AppearanceFonts {
  const raw = readStorage(APPEARANCE_STORAGE_KEYS.fonts);
  if (!raw) return { ...DEFAULT_APPEARANCE_FONTS };
  try {
    const data = JSON.parse(raw) as { ui?: unknown; mono?: unknown };
    return {
      ui: parseFontRef(data.ui, 'ui'),
      mono: parseFontRef(data.mono, 'mono'),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE_FONTS };
  }
}

/** Persist font preferences. */
export function setAppearanceFonts(fonts: AppearanceFonts): void {
  writeStorage(APPEARANCE_STORAGE_KEYS.fonts, JSON.stringify(fonts));
  emitChange();
}

function stackForRef(ref: FontRef): string {
  if (ref.kind === 'preset') {
    return ref.slot === 'ui' ? UI_FONT_STACKS[ref.id] : MONO_FONT_STACKS[ref.id];
  }
  const family = ref.familyName.replace(/['"]/g, '');
  const fallback = ref.slot === 'ui' ? SYSTEM_UI : SYSTEM_MONO;
  return `'${family}', ${fallback}`;
}

async function ensureUploadFontLoaded(ref: FontRef & { kind: 'upload' }): Promise<void> {
  const cacheKey = `${ref.slot}:${ref.assetId}`;
  if (registeredUploadFonts.has(cacheKey)) return;

  const asset = await getAppearanceAsset(ref.assetId);
  if (!asset) return;

  const url = await getAppearanceAssetObjectUrl(ref.assetId);
  if (!url) return;

  const family = ref.familyName.replace(/['"]/g, '');
  const face = new FontFace(family, `url(${url})`);
  try {
    const loaded = await face.load();
    document.fonts.add(loaded);
    registeredUploadFonts.set(cacheKey, loaded);
  } catch {}
}

function googleSpecsForFonts(fonts: AppearanceFonts): GoogleFontSpec[] {
  const specs: GoogleFontSpec[] = [];
  if (fonts.ui.kind === 'preset') {
    const spec = googleSpecForPreset('ui', fonts.ui.id);
    if (spec) specs.push(spec);
  }
  if (fonts.mono.kind === 'preset') {
    const spec = googleSpecForPreset('mono', fonts.mono.id);
    if (spec) specs.push(spec);
  }
  return specs;
}

function ensurePreconnect(id: string, href: string, crossOrigin: boolean): void {
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'preconnect';
  link.href = href;
  if (crossOrigin) link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

/**
 * Swap the single Google Fonts stylesheet for the active pair.
 * Must not notify font listeners — theme.ts re-applies on that signal (MIN-262).
 */
export function syncGoogleFontsStylesheet(fonts: AppearanceFonts): void {
  if (typeof document === 'undefined' || !document.head) return;

  const specs = googleSpecsForFonts(fonts);
  const existing = document.getElementById(GOOGLE_FONTS_LINK_ID);
  if (specs.length === 0) {
    existing?.remove();
    return;
  }

  ensurePreconnect(PRECONNECT_GOOGLE, 'https://fonts.googleapis.com', false);
  ensurePreconnect(PRECONNECT_GSTATIC, 'https://fonts.gstatic.com', true);

  const href = buildGoogleFontsCss2Url(specs);
  let link = existing as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = GOOGLE_FONTS_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) {
    link.setAttribute('href', href);
  }
}

/** Apply --font-ui and --font-mono on documentElement. */
export async function applyAppearanceFonts(fonts?: AppearanceFonts): Promise<void> {
  const prefs = fonts ?? getAppearanceFonts();
  const root = document.documentElement;

  if (prefs.ui.kind === 'upload') {
    await ensureUploadFontLoaded(prefs.ui);
  }
  if (prefs.mono.kind === 'upload') {
    await ensureUploadFontLoaded(prefs.mono);
  }

  syncGoogleFontsStylesheet(prefs);

  root.style.setProperty('--font-ui', stackForRef(prefs.ui));
  root.style.setProperty('--font-mono', stackForRef(prefs.mono));
}

/** Set UI font preset or upload ref. */
export function setUiFont(ref: FontRef & { slot: 'ui' }): void {
  const fonts = getAppearanceFonts();
  fonts.ui = ref;
  setAppearanceFonts(fonts);
  void applyAppearanceFonts(fonts);
}

/** Set mono font preset or upload ref. */
export function setMonoFont(ref: FontRef & { slot: 'mono' }): void {
  const fonts = getAppearanceFonts();
  fonts.mono = ref;
  setAppearanceFonts(fonts);
  void applyAppearanceFonts(fonts);
}

/** Subscribe to font preference changes. */
export function subscribeAppearanceFonts(listener: FontListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Clear registered upload fonts (tests). */
export function resetAppearanceFontsForTests(): void {
  registeredUploadFonts.clear();
  removeStorage(APPEARANCE_STORAGE_KEYS.fonts);
  listeners.clear();
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    document.getElementById(GOOGLE_FONTS_LINK_ID)?.remove();
    document.getElementById(PRECONNECT_GOOGLE)?.remove();
    document.getElementById(PRECONNECT_GSTATIC)?.remove();
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {}
  scheduleAppearancePersist();
}
