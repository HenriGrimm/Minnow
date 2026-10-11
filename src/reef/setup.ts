/** The New app flow asks three things, in order, before anything is built. */
export type ReefSetupStep = 'idea' | 'name' | 'look';
export const REEF_SETUP_STEPS: ReadonlyArray<{ id: ReefSetupStep; label: string }> = [
  { id: 'idea', label: 'Idea' }, { id: 'name', label: 'Name' }, { id: 'look', label: 'Look' },
];

/** Each vibe's swatch uses the shared label tokens, so it reads in every theme. */
export interface ReefVibe { id: string; label: string; look: string; swatch: [string, string, string] }
export const REEF_VIBES: readonly ReefVibe[] = [
  { id: 'cozy', label: 'Cozy', look: 'Warm and cozy: soft cream and apricot tones, rounded corners, friendly type.', swatch: ['apricot', 'clay', 'pollen'] },
  { id: 'crisp', label: 'Crisp', look: 'Crisp and minimal: lots of white space, one calm accent color, clean sans-serif type.', swatch: ['pebble', 'dusk', 'tide'] },
  { id: 'playful', label: 'Playful', look: 'Bright and playful: bold colors, chunky buttons and a little bounce when things change.', swatch: ['blush', 'pollen', 'kelp'] },
  { id: 'night', label: 'Night owl', look: 'Dark and calm: a deep night background with soft glowing accents that are easy on the eyes.', swatch: ['dusk', 'fig', 'tide'] },
  { id: 'garden', label: 'Garden', look: 'Fresh and leafy: mossy greens, sunny highlights and gentle, organic shapes.', swatch: ['moss', 'kelp', 'pollen'] },
  { id: 'reef', label: 'Under the sea', look: 'Under the sea: tide blues with coral highlights, soft wave shapes and bubbly details.', swatch: ['tide', 'kelp', 'blush'] },
];

/** Words that say what an app does rather than what it is about. */
const FILLER = new Set(('a an and app apps are as at be between by can each every for from get gets has have help helps how i in into is it its keep keeps '
  + 'let lets like little make makes me my of on one or our show shows simple small so some that the their them then there these this to tool '
  + 'track tracks up use using want what when where which while who will with you your add adds build calculate calculates convert converts create '
  + 'creates split splits clear quick easy nice way thing things also just only all any per much many more most other out over very lot lots').split(' '));
const SHAPES: ReadonlyArray<(word: string) => string> = [
  word => `${word} Buddy`, word => `Tiny ${word}`, word => `${word} Pal`, word => `${word} Pop`,
  word => `Little ${word}`, word => `${word} Nook`, word => `Captain ${word}`, word => `${word} Wiz`,
];
const FALLBACK_NAMES = ['Pocket Pal', 'Little Helper', 'Bubble', 'Sea Sprout', 'Tide Pool'];

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** Playful, deterministic name ideas drawn from the subject words of an idea. */
export function suggestReefNames(idea: string): string[] {
  const words: string[] = [];
  for (const match of idea.toLowerCase().matchAll(/[a-z][a-z'-]*/g)) {
    const word = match[0].replace(/['-]+$/, '');
    if (word.length >= 3 && !FILLER.has(word) && !words.includes(word)) words.push(word);
    if (words.length === 3) break;
  }
  const names: string[] = [];
  SHAPES.forEach((shape, index) => { if (words.length) names.push(shape(titleCase(words[index % words.length]))); });
  for (const name of FALLBACK_NAMES) if (names.length < SHAPES.length) names.push(name);
  return [...new Set(names)].map(name => name.slice(0, 100));
}

/** A palette the person sets themselves, one colour per role, as `#rrggbb`. */
export const REEF_CUSTOM_VIBE = 'custom';
export const REEF_PALETTE_ROLES = [
  { id: 'background', label: 'Background' }, { id: 'main', label: 'Main' }, { id: 'highlight', label: 'Highlight' },
] as const;
export type ReefPalette = [string, string, string];
/** The generated app's starting colours, not Minnow's own theme. */
export const DEFAULT_REEF_PALETTE: ReefPalette = ['#fdf4e7', '#2f7d6d', '#f2994a'];

/** Match Minnow: the person's current Minnow theme, read as hex when the build starts. */
export const REEF_THEME_VIBE = 'minnow';
export interface ReefThemeColors { scheme: 'light' | 'dark'; colors: Record<string, string> }

/** The vibe's description first, then anything the person wrote about the look. */
export function composeReefLook(vibeId: string | null, notes: string, { palette = DEFAULT_REEF_PALETTE, theme }: { palette?: ReefPalette; theme?: ReefThemeColors } = {}): string {
  const list = (pairs: Array<[string, string]>) => pairs.map(([role, color]) => `${role} ${color}`).join(', ');
  const vibe = vibeId === REEF_CUSTOM_VIBE
    ? `Use this color palette: ${list(REEF_PALETTE_ROLES.map((role, index) => [role.label.toLowerCase(), palette[index]]))}.`
    : vibeId === REEF_THEME_VIBE
      ? theme ? `Match the Minnow app's current ${theme.scheme} theme: ${list(Object.entries(theme.colors))}.` : 'Match the Minnow app\'s current theme.'
      : REEF_VIBES.find(item => item.id === vibeId)?.look;
  return [vibe, notes.trim()].filter(Boolean).join('\n');
}
