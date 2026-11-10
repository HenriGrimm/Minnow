export const THEME_FAMILIES = Object.freeze([
  'graphite', 'swamp', 'ocean', 'desert', 'coral', 'human', 'mint', 'mono', 'matrix',
]);
export const DEFAULT_THEME_FAMILY = 'graphite';
export const DEFAULT_THEME_ID = 'graphite-dark';
export const DEFAULT_APPEARANCE_FONT_ID = 'bundled-geist';

export const GRAPHITE_ACCENTS = Object.freeze(['teal', 'blue', 'amber', 'violet', 'rose']);
export const COLOR_INTENSITIES = Object.freeze(['none', 'subtle', 'rich']);
export const APPEARANCE_DENSITIES = Object.freeze(['compact', 'cozy', 'roomy']);

export function normalizeGraphiteAccent(value) {
  return GRAPHITE_ACCENTS.includes(value) ? value : 'teal';
}

export function normalizeColorIntensity(value) {
  return COLOR_INTENSITIES.includes(value) ? value : 'subtle';
}

export function normalizeAppearanceDensity(value) {
  return APPEARANCE_DENSITIES.includes(value) ? value : 'cozy';
}
