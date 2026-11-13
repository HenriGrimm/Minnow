/**
 * Built-in font presets for Settings → Appearance.
 *
 * Google families are lazy-loaded via the CSS2 API when selected (see fonts.ts).
 * The bundled Geist pair stays offline-capable.
 */

import { DEFAULT_APPEARANCE_FONT_ID } from '../lib/appearance-choices.mjs';

/** Weights Minnow chrome actually uses (body / UI / labels). */
export const DEFAULT_FONT_WEIGHTS = [400, 500, 600] as const;

export type GoogleFontSpec = {
  /** Family name as Google Fonts serves it (spaces allowed). */
  family: string;
  /** Requested wght tuples; omit unused weights so the CSS2 URL stays small. */
  weights: readonly number[];
};

export type FontCatalogEntry = {
  id: string;
  label: string;
  /** Present when this preset is a Google Font. */
  google?: GoogleFontSpec;
  /** A font-face shipped in the application. */
  bundledFamily?: string;
};

const W = DEFAULT_FONT_WEIGHTS;
const W400 = [400] as const;
const W400_700 = [400, 700] as const;
const W400_500_700 = [400, 500, 700] as const;

function gf(
  id: string,
  label: string,
  family: string,
  weights: readonly number[] = W,
): FontCatalogEntry {
  return { id, label, google: { family, weights } };
}

/**
 * UI (sans) presets. Bundled and system fonts first, then alphabetical by label.
 * Display, handwriting, and serif faces are omitted — they fight 14px chrome.
 */
export const UI_FONT_CATALOG: readonly FontCatalogEntry[] = [
  { id: DEFAULT_APPEARANCE_FONT_ID, label: 'Geist', bundledFamily: 'Geist' },
  { id: 'system', label: 'System' },
  gf('albert-sans', 'Albert Sans', 'Albert Sans'),
  gf('atkinson-hyperlegible', 'Atkinson Hyperlegible', 'Atkinson Hyperlegible', W400_700),
  gf('barlow', 'Barlow', 'Barlow'),
  gf('be-vietnam-pro', 'Be Vietnam Pro', 'Be Vietnam Pro'),
  gf('cabin', 'Cabin', 'Cabin'),
  gf('dm-sans', 'DM Sans', 'DM Sans'),
  gf('figtree', 'Figtree', 'Figtree'),
  gf('fira-sans', 'Fira Sans', 'Fira Sans'),
  gf('ibm-plex-sans', 'IBM Plex Sans', 'IBM Plex Sans'),
  gf('instrument-sans', 'Instrument Sans', 'Instrument Sans'),
  gf('inter', 'Inter', 'Inter'),
  gf('karla', 'Karla', 'Karla'),
  gf('lato', 'Lato', 'Lato'),
  gf('lexend', 'Lexend', 'Lexend'),
  gf('libre-franklin', 'Libre Franklin', 'Libre Franklin'),
  gf('manrope', 'Manrope', 'Manrope'),
  gf('montserrat', 'Montserrat', 'Montserrat'),
  gf('mulish', 'Mulish', 'Mulish'),
  gf('noto-sans', 'Noto Sans', 'Noto Sans'),
  gf('nunito', 'Nunito', 'Nunito'),
  gf('nunito-sans', 'Nunito Sans', 'Nunito Sans'),
  gf('onest', 'Onest', 'Onest'),
  gf('open-sans', 'Open Sans', 'Open Sans'),
  gf('outfit', 'Outfit', 'Outfit'),
  gf('plus-jakarta-sans', 'Plus Jakarta Sans', 'Plus Jakarta Sans'),
  gf('poppins', 'Poppins', 'Poppins'),
  gf('pt-sans', 'PT Sans', 'PT Sans', W400_700),
  gf('public-sans', 'Public Sans', 'Public Sans'),
  gf('red-hat-text', 'Red Hat Text', 'Red Hat Text'),
  gf('roboto', 'Roboto', 'Roboto'),
  gf('rubik', 'Rubik', 'Rubik'),
  gf('sora', 'Sora', 'Sora'),
  gf('source-sans-3', 'Source Sans 3', 'Source Sans 3'),
  gf('space-grotesk', 'Space Grotesk', 'Space Grotesk'),
  gf('ubuntu', 'Ubuntu', 'Ubuntu', W400_500_700),
  gf('urbanist', 'Urbanist', 'Urbanist'),
  gf('work-sans', 'Work Sans', 'Work Sans'),
];

/**
 * Monospace presets. Bundled and system fonts first, then alphabetical.
 * Includes ligature coding fonts (Fira Code, JetBrains Mono, Cascadia Code).
 */
export const MONO_FONT_CATALOG: readonly FontCatalogEntry[] = [
  { id: DEFAULT_APPEARANCE_FONT_ID, label: 'Geist Mono', bundledFamily: 'Geist Mono' },
  // Preserve the former system mono pick and its existing look.
  gf('system', 'System mono', 'JetBrains Mono'),
  gf('anonymous-pro', 'Anonymous Pro', 'Anonymous Pro', W400_700),
  gf('azeret-mono', 'Azeret Mono', 'Azeret Mono'),
  gf('cascadia-code', 'Cascadia Code', 'Cascadia Code'),
  gf('courier-prime', 'Courier Prime', 'Courier Prime', W400_700),
  gf('cousine', 'Cousine', 'Cousine', W400_700),
  gf('dm-mono', 'DM Mono', 'DM Mono', W400_500_700),
  gf('fira-code', 'Fira Code', 'Fira Code'),
  gf('fira-mono', 'Fira Mono', 'Fira Mono', W400_500_700),
  gf('fragment-mono', 'Fragment Mono', 'Fragment Mono', W400),
  gf('ibm-plex-mono', 'IBM Plex Mono', 'IBM Plex Mono'),
  gf('inconsolata', 'Inconsolata', 'Inconsolata'),
  gf('jetbrains-mono', 'JetBrains Mono', 'JetBrains Mono'),
  gf('martian-mono', 'Martian Mono', 'Martian Mono'),
  gf('noto-sans-mono', 'Noto Sans Mono', 'Noto Sans Mono'),
  gf('overpass-mono', 'Overpass Mono', 'Overpass Mono'),
  gf('pt-mono', 'PT Mono', 'PT Mono', W400),
  gf('red-hat-mono', 'Red Hat Mono', 'Red Hat Mono'),
  gf('reddit-mono', 'Reddit Mono', 'Reddit Mono'),
  gf('roboto-mono', 'Roboto Mono', 'Roboto Mono'),
  gf('share-tech-mono', 'Share Tech Mono', 'Share Tech Mono', W400),
  gf('sometype-mono', 'Sometype Mono', 'Sometype Mono'),
  gf('source-code-pro', 'Source Code Pro', 'Source Code Pro'),
  gf('space-mono', 'Space Mono', 'Space Mono', W400_700),
  gf('spline-sans-mono', 'Spline Sans Mono', 'Spline Sans Mono'),
  gf('ubuntu-mono', 'Ubuntu Mono', 'Ubuntu Mono', W400_700),
];

export const UI_FONT_PRESETS = UI_FONT_CATALOG.map((entry) => entry.id) as readonly string[];
export type UiFontPresetId = (typeof UI_FONT_CATALOG)[number]['id'];

export const MONO_FONT_PRESETS = MONO_FONT_CATALOG.map((entry) => entry.id) as readonly string[];
export type MonoFontPresetId = (typeof MONO_FONT_CATALOG)[number]['id'];

function labelsFrom(catalog: readonly FontCatalogEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of catalog) out[entry.id] = entry.label;
  return out;
}

export const UI_FONT_LABELS = labelsFrom(UI_FONT_CATALOG) as Record<UiFontPresetId, string>;
export const MONO_FONT_LABELS = labelsFrom(MONO_FONT_CATALOG) as Record<MonoFontPresetId, string>;

function entryById(
  catalog: readonly FontCatalogEntry[],
  id: string,
): FontCatalogEntry | undefined {
  return catalog.find((entry) => entry.id === id);
}

export function getUiFontCatalogEntry(id: string): FontCatalogEntry | undefined {
  return entryById(UI_FONT_CATALOG, id);
}

export function getMonoFontCatalogEntry(id: string): FontCatalogEntry | undefined {
  return entryById(MONO_FONT_CATALOG, id);
}

/** Google spec for a preset, or undefined for a local-only stack. */
export function googleSpecForPreset(
  slot: 'ui' | 'mono',
  id: string,
): GoogleFontSpec | undefined {
  const entry = slot === 'ui' ? getUiFontCatalogEntry(id) : getMonoFontCatalogEntry(id);
  return entry?.google;
}

/**
 * Build a CSS2 stylesheet URL for the given families.
 * Duplicate family names collapse so System mono + JetBrains Mono share one request.
 */
export function buildGoogleFontsCss2Url(specs: readonly GoogleFontSpec[]): string {
  const seen = new Map<string, ReadonlySet<number>>();
  for (const spec of specs) {
    const prev = seen.get(spec.family);
    const next = new Set(prev ? [...prev] : []);
    for (const weight of spec.weights) next.add(weight);
    seen.set(spec.family, next);
  }
  const params: string[] = [];
  for (const [family, weights] of seen) {
    const name = family.replace(/ /g, '+');
    const wght = [...weights].sort((a, b) => a - b).join(';');
    params.push(`family=${name}:wght@${wght}`);
  }
  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}
