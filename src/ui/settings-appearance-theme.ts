import {
  APPEARANCE_DENSITIES,
  type AppearanceDensity,
} from '../lib/appearance-choices.mjs';
import { readGraphitePreferences, setGraphitePreference } from '../appearance/graphite-preferences';
import { subscribeCustomThemeChanges } from '../appearance/custom-theme';
import { createAppearanceAccents } from './settings-accent';
import {
  getFollowSystem,
  getMode,
  getStoredTheme,
  setFollowSystem,
  setThemeMode,
} from '../theme';
import { createSegmentedControl, createSwitch } from './components';
import { setActivityShimmerText } from './activity-shimmer';
import { applyResolvedTheme } from './theme';

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

export function appendAppearanceThemePresets(mount: HTMLElement): () => void {
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

  const colorRow = appearanceRow('Surface tint', 'How much accent color reaches backgrounds and selections.');
  colorRow.dataset.settingsSearchKey = 'appearance.theme.color';
  const tintControl = el('div', 'graphite-appearance-tint');
  const tint = el('input', 'graphite-appearance-tint__range');
  tint.type = 'range';
  tint.min = '0';
  tint.max = '100';
  tint.value = String(readGraphitePreferences().colorIntensity);
  tint.setAttribute('aria-label', 'Surface tint');
  const tintValue = el('span', 'graphite-appearance-tint__value');
  tintValue.setAttribute('aria-hidden', 'true');
  function showTintValue(): void {
    tintValue.textContent = `${tint.value}%`;
    tint.setAttribute('aria-valuetext', tintValue.textContent);
  }
  showTintValue();
  tint.addEventListener('input', () => {
    showTintValue();
    setGraphitePreference('colorIntensity', tint.valueAsNumber);
  });
  tint.addEventListener('change', () => applyResolvedTheme(getStoredTheme()));
  tintControl.append(tint, tintValue);
  colorRow.append(tintControl);

  const accentRow = appearanceRow('Accent color');
  accentRow.classList.add('graphite-appearance-row--accents');
  accentRow.dataset.settingsSearchKey = 'appearance.theme.accent';
  const accents = createAppearanceAccents();
  accentRow.append(accents.root);

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
  card.append(modeRow, accentRow, colorRow, densityRow, motion);

  function refresh(): void {
    mode.setValue(getFollowSystem() ? 'system' : getMode(getStoredTheme()), { silent: true });
    accents.refresh();
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

  mount.append(card, preview);
  refresh();
  const unsubscribe = subscribeCustomThemeChanges(accents.refresh);
  return () => {
    unsubscribe();
    accents.close();
  };
}
