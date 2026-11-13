export const THEME_FAMILIES: readonly [
  'graphite', 'swamp', 'ocean', 'desert', 'coral', 'human', 'mint', 'mono', 'matrix',
];
export const DEFAULT_THEME_FAMILY: 'graphite';
export const DEFAULT_THEME_ID: 'graphite-dark';
export const DEFAULT_APPEARANCE_FONT_ID: 'bundled-geist';

export type AccentPreset = Exclude<ThemeFamily, 'graphite'> | 'teal' | 'blue' | 'amber' | 'violet' | 'rose';
export type GraphiteAccent = AccentPreset | `#${string}`;
export type ColorIntensity = 'none' | 'subtle' | 'rich';
export type AppearanceDensity = 'compact' | 'cozy' | 'roomy';
export const GRAPHITE_ACCENTS: readonly AccentPreset[];
export const COLOR_INTENSITIES: readonly ColorIntensity[];
export const APPEARANCE_DENSITIES: readonly AppearanceDensity[];

export function normalizeGraphiteAccent(value: unknown): GraphiteAccent;
export function normalizeColorIntensity(value: unknown): ColorIntensity;
export function normalizeAppearanceDensity(value: unknown): AppearanceDensity;
