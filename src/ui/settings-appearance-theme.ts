import {
  APPEARANCE_DENSITIES,
  COLOR_INTENSITIES,
  GRAPHITE_ACCENTS,
  type AppearanceDensity,
  type ColorIntensity,
} from '../lib/appearance-choices.mjs';
import { readGraphitePreferences, setGraphitePreference } from '../appearance/graphite-preferences';
import { isCustomThemeEnabled, setCustomThemeEnabled } from '../appearance/custom-theme';
import {
  getFollowSystem,
  getMode,
  getStoredFamily,
  getStoredTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  THEME_FAMILIES,
  THEME_FAMILY_META,
  type ThemeFamily,
} from '../theme';
import { createSegmentedControl, createSwitch } from './components';
import { setActivityShimmerText } from './activity-shimmer';
import { createIcon } from './icon';
import { applyResolvedTheme } from './theme';

const ACCENT_LABELS = {
  teal: 'Minnow teal',
  blue: 'Blue',
  amber: 'Amber',
  violet: 'Violet',
  rose: 'Rose',
};
const TINT_LABELS = { none: 'Off', subtle: 'Subtle', rich: 'Rich' };
const DENSITY_LABELS = { compact: 'Compact', cozy: 'Cozy', roomy: 'Roomy' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appearanceRow(title: string, description?: string): HTMLDivElement {
  const row = el('div', 'graphite-appearance-row');
  const copy = el('div', 'graphite-appearance-row__copy');
  copy.append(el('span', 'graphite-appearance-row__title', title));
  if (description !== undefined) copy.append(el('span', 'graphite-appearance-row__hint', description));
  row.append(copy);
  return row;
}

function themeTile(family: ThemeFamily, name: string) {
  const label = el('label', 'graphite-theme-tile');
  const input = el('input', 'visually-hidden');
  input.type = 'radio';
  input.name = 'graphite-appearance-family';
  input.value = family;
  const miniature = el('span', 'settings-theme-preview graphite-theme-tile__preview');
  const rail = el('span', 'graphite-theme-tile__rail');
  rail.append(el('i', 'graphite-theme-tile__accent'), el('i', ''), el('i', ''));
  const sheet = el('span', 'graphite-theme-tile__sheet');
  sheet.append(el('i', 'graphite-theme-tile__bubble'), el('i', ''), el('i', 'graphite-theme-tile__accent'));
  miniature.append(rail, sheet);
  miniature.setAttribute('aria-hidden', 'true');
  const title = el('span', 'graphite-theme-tile__title', name);
  const dot = el('span', 'graphite-theme-tile__dot settings-theme-preview');
  dot.setAttribute('aria-hidden', 'true');
  title.prepend(dot);
  const check = createIcon('check', { size: 12, className: 'graphite-theme-tile__check' });
  check.hidden = true;
  title.append(check);
  label.append(input, miniature, title);
  return { label, input, miniature, dot, check };
}

/** Graphite’s appearance controls and shared palette preview. */
export function appendAppearanceThemePresets(mount: HTMLElement): void {
  const card = el('section', 'graphite-appearance-card');
  card.setAttribute('aria-label', 'Appearance controls');
  card.dataset.settingsSearchKey = 'appearance.theme';

  const modeRow = appearanceRow('Mode');
  modeRow.dataset.settingsSearchKey = 'appearance.theme.mode';
  const mode = createSegmentedControl({
    className: 'graphite-appearance-segment',
    ariaLabel: 'Mode',
    size: 'sm',
    options: [
      { value: 'dark', label: 'Dark', icon: 'moon' },
      { value: 'light', label: 'Light', icon: 'bulb' },
      { value: 'system', label: 'System', icon: 'inspectorPanel' },
    ],
    value: getFollowSystem() ? 'system' : getMode(getStoredTheme()),
    onChange(value) {
      if (value === 'system') setFollowSystem(true);
      else setThemeMode(value === 'light' ? 'light' : 'dark');
      applyResolvedTheme(getStoredTheme());
      refresh();
    },
  });
  modeRow.append(mode.root);

  const theme = appearanceRow('Theme', 'Each theme sets the accent and tints the surfaces.');
  theme.dataset.settingsSearchKey = 'appearance.theme.family';
  theme.classList.add('graphite-appearance-row--theme');
  const grid = el('div', 'graphite-appearance-families');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', 'Theme');
  const families = THEME_FAMILIES.filter((family) => family !== 'matrix').map((family) => {
    const title = THEME_FAMILY_META.find((preset) => preset.id === family)?.name ?? family;
    const tile = themeTile(family, title);
    tile.input.addEventListener('change', () => {
      if (tile.input.checked) chooseTheme(family);
    });
    grid.append(tile.label);
    return { family, ...tile };
  });
  theme.append(grid);

  const colorRow = appearanceRow('Color', "How much of the theme's color shows in surfaces and selection.");
  colorRow.dataset.settingsSearchKey = 'appearance.theme.color';
  const color = createSegmentedControl({
    className: 'graphite-appearance-segment',
    ariaLabel: 'Color intensity',
    size: 'sm',
    options: COLOR_INTENSITIES.map((value) => ({ value, label: TINT_LABELS[value] })),
    value: readGraphitePreferences().colorIntensity,
    onChange(value) {
      setGraphitePreference('colorIntensity', value as ColorIntensity);
      applyResolvedTheme(getStoredTheme());
    },
  });
  colorRow.append(color.root);

  const accentRow = appearanceRow('Accent', '');
  accentRow.dataset.settingsSearchKey = 'appearance.theme.accent';
  const accentHint = accentRow.querySelector('.graphite-appearance-row__hint')!;
  const accents = el('div', 'graphite-appearance-accents');
  accents.setAttribute('role', 'group');
  accents.setAttribute('aria-label', 'Accent');
  const swatches = GRAPHITE_ACCENTS.map((id) => {
    const button = el('button', 'graphite-appearance-swatch');
    button.type = 'button';
    button.dataset.accent = id;
    button.setAttribute('aria-label', ACCENT_LABELS[id]);
    button.title = ACCENT_LABELS[id];
    button.addEventListener('click', () => {
      setGraphitePreference('graphiteAccent', id);
      chooseTheme('graphite');
    });
    accents.append(button);
    return { id, button };
  });
  accentRow.append(accents);

  const densityRow = appearanceRow('Density', 'Adjust spacing in sidebars, menus, chats, and lists.');
  densityRow.dataset.settingsSearchKey = 'appearance.density';
  const density = createSegmentedControl({
    className: 'graphite-appearance-segment',
    ariaLabel: 'Density',
    size: 'sm',
    options: APPEARANCE_DENSITIES.map((value) => ({ value, label: DENSITY_LABELS[value] })),
    value: readGraphitePreferences().density,
    onChange: (value) => setGraphitePreference('density', value as AppearanceDensity),
  });
  densityRow.append(density.root);

  const motion = appearanceRow('Reduce motion', 'Keeps the stop ring and activity text still. Follows the system by default.');
  motion.dataset.settingsSearchKey = 'appearance.reduceMotion';
  const reduce = createSwitch({
    ariaLabel: 'Reduce motion',
    checked: readGraphitePreferences().reduceMotion,
    size: 'sm',
    className: 'graphite-appearance-switch',
    onChange: (checked) => setGraphitePreference('reduceMotion', checked),
  });
  motion.append(reduce.root);
  card.append(modeRow, theme, colorRow, accentRow, densityRow, motion);

  // Matrix remains available for existing profiles and as an extra theme choice.
  const matrix = el('button', 'graphite-appearance-matrix', 'Matrix');
  matrix.type = 'button';
  matrix.addEventListener('click', () => chooseTheme('matrix'));
  const extras = el('details', 'graphite-appearance-extra-theme');
  extras.append(el('summary', '', 'More themes'), matrix);

  function chooseTheme(family: ThemeFamily): void {
    if (isCustomThemeEnabled()) setCustomThemeEnabled(false);
    setThemeFamily(family);
    applyResolvedTheme(getStoredTheme());
    refresh();
  }

  function refresh(): void {
    const family = getStoredFamily();
    const activeMode = getMode(getStoredTheme());
    mode.setValue(getFollowSystem() ? 'system' : activeMode, { silent: true });
    for (const tile of families) {
      tile.input.checked = tile.family === family;
      tile.check.hidden = !tile.input.checked;
      tile.miniature.dataset.theme = tile.dot.dataset.theme = `${tile.family}-${activeMode}`;
    }
    const name = THEME_FAMILY_META.find((preset) => preset.id === family)?.name ?? family;
    accentHint.textContent = family === 'graphite'
      ? 'Graphite takes any accent.'
      : `Set by ${name}. Picking one switches to Graphite.`;
    const { graphiteAccent } = readGraphitePreferences();
    for (const { id, button } of swatches) {
      button.setAttribute('aria-pressed', String(family === 'graphite' && id === graphiteAccent));
    }
    matrix.setAttribute('aria-pressed', String(family === 'matrix'));
  }

  const preview = el('section', 'graphite-appearance-preview');
  preview.append(el('h3', 'graphite-appearance-preview__label', 'Preview'));
  const example = el('div', 'graphite-appearance-preview__card');
  const heading = el('div', 'graphite-appearance-preview__row');
  heading.append(
    el('span', 'graphite-appearance-preview__dot'),
    el('span', '', 'Unify agent permissions'),
    el('span', 'graphite-appearance-preview__chip', 'Running'),
  );
  const activity = el('div', 'graphite-appearance-preview__row');
  const stop = el('span', 'graphite-appearance-preview__stop');
  stop.setAttribute('aria-hidden', 'true');
  const sampleStatus = el('span', 'graphite-appearance-preview__grow');
  setActivityShimmerText(sampleStatus, 'Running the engine suite…');
  activity.append(sampleStatus, stop);
  example.append(heading, el('p', '', 'Wired the renderer gate to decidePermission. Running the engine suite next.'), activity);
  preview.append(example);

  mount.append(card, preview, extras);
  if (getStoredFamily() === 'matrix') extras.open = true;
  refresh();
}
