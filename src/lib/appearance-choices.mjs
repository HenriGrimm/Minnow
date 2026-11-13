export const THEME_FAMILIES = Object.freeze([
  'graphite', 'swamp', 'ocean', 'desert', 'coral', 'human', 'mint', 'mono', 'matrix',
]);
export const DEFAULT_THEME_FAMILY = 'graphite';
export const DEFAULT_THEME_ID = 'graphite-dark';
export const DEFAULT_APPEARANCE_FONT_ID = 'bundled-geist';

export const GRAPHITE_ACCENTS = Object.freeze([
  'teal', 'blue', 'amber', 'violet', 'rose',
  'swamp', 'ocean', 'desert', 'coral', 'human', 'mint', 'mono', 'matrix',
]);
export const DEFAULT_COLOR_INTENSITY = 50;
export const APPEARANCE_DENSITIES = Object.freeze(['compact', 'cozy', 'roomy']);

export function normalizeGraphiteAccent(value) {
  if (GRAPHITE_ACCENTS.includes(value)) return value;
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : 'teal';
}

export function normalizeColorIntensity(value) {
  if (value === 'none') return 0;
  if (value === 'rich') return 100;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) value = Number(value);
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_COLOR_INTENSITY;
}

export function normalizeAppearanceDensity(value) {
  return APPEARANCE_DENSITIES.includes(value) ? value : 'cozy';
}
