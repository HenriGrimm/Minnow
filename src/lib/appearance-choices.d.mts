export const THEME_FAMILIES: readonly [
  'graphite', 'swamp', 'ocean', 'desert', 'coral', 'human', 'mint', 'mono', 'matrix',
];
export const DEFAULT_THEME_FAMILY: 'graphite';
export const DEFAULT_THEME_ID: 'graphite-dark';
export const DEFAULT_APPEARANCE_FONT_ID: 'bundled-geist';

export type AccentPreset = Exclude<ThemeFamily, 'graphite'> | 'teal' | 'blue' | 'amber' | 'violet' | 'rose';
export type GraphiteAccent = AccentPreset | `#${string}`;
export type AppearanceDensity = 'compact' | 'cozy' | 'roomy';
export const GRAPHITE_ACCENTS: readonly AccentPreset[];
export const DEFAULT_COLOR_INTENSITY: 50;
export const APPEARANCE_DENSITIES: readonly AppearanceDensity[];

export function normalizeGraphiteAccent(value: unknown): GraphiteAccent;
export function normalizeColorIntensity(value: unknown): number;
export function normalizeAppearanceDensity(value: unknown): AppearanceDensity;
