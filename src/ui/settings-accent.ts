import {
  GRAPHITE_ACCENTS, type AccentPreset, type GraphiteAccent,
} from '../lib/appearance-choices.mjs';
import { getCustomThemeTokens, isCustomThemeEnabled, replaceCustomThemeTokens, setCustomThemeEnabled } from '../appearance/custom-theme';
import { setGraphitePreference } from '../appearance/graphite-preferences';
import { getAccentChoice, getStoredTheme, setThemeFamily } from '../theme';
import { createAppearanceColorInput } from './appearance-color-input';
import { createButton } from './components/button';
import { openPopover, type PopoverHandle } from './components/popover';
import { applyResolvedTheme } from './theme';

const LABELS: Record<AccentPreset, string> = {
  teal: 'Minnow teal',
  blue: 'Blue',
  amber: 'Amber',
  violet: 'Violet',
  rose: 'Rose',
  swamp: 'Sage',
  ocean: 'Glacier',
  desert: 'Sand',
  coral: 'Coral',
  human: 'Copper',
  mint: 'Mint',
  mono: 'Silver',
  matrix: 'Phosphor',
};

export function createAppearanceAccents(onChange?: () => void) {
  const root = document.createElement('div');
  root.className = 'appearance-accents';
  const choices = document.createElement('div');
  choices.className = 'appearance-accents__choices';
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Accent color');
  const current = document.createElement('span');
  current.className = 'appearance-accents__current';
  current.setAttribute('role', 'status');
  let popover: PopoverHandle | undefined;

  function choose(accent: GraphiteAccent): void {
    if (isCustomThemeEnabled() && getCustomThemeTokens().accent) {
      const tokens = getCustomThemeTokens();
      delete tokens.accent;
      replaceCustomThemeTokens(tokens);
      if (!Object.keys(tokens).length) setCustomThemeEnabled(false);
    }
    setGraphitePreference('graphiteAccent', accent);
    setThemeFamily('graphite');
    applyResolvedTheme(getStoredTheme());
    refresh();
    onChange?.();
  }

  const swatches = GRAPHITE_ACCENTS.map((id) => {
    const button = createButton({
      ariaLabel: LABELS[id], pressed: false, variant: 'ghost',
      className: 'settings-accent-swatch', onClick: () => choose(id),
    });
    button.title = LABELS[id];
    button.dataset.graphiteAccent = id;
    choices.append(button);
    return { id, button };
  });

  const custom = createButton({
    label: 'Custom…', icon: 'palette', size: 'sm',
    onClick: () => {
      if (popover?.isOpen()) {
        popover.close('anchor');
        return;
      }
      const panel = document.createElement('div');
      panel.className = 'appearance-color-panel';
      const heading = document.createElement('strong');
      heading.textContent = 'Custom accent color';
      const picker = createAppearanceColorInput(() => {});
      picker.setValue(getComputedStyle(document.documentElement).getPropertyValue('--mn-accent'));
      const actions = document.createElement('div');
      actions.className = 'appearance-color-panel__actions';
      actions.append(createButton({
        label: 'Apply accent', variant: 'primary', onClick: () => {
          if (!picker.commit()) {
            picker.hex.focus();
            return;
          }
          choose(picker.hex.value.toLowerCase() as GraphiteAccent);
          popover?.close();
        },
      }));
      panel.append(heading, picker.root, actions);
      popover = openPopover({
        anchor: custom, content: panel, ariaLabel: 'Custom accent color',
        placement: 'bottom-end', initialFocus: picker.hex, className: 'appearance-color-popover',
      });
    },
  });
  custom.setAttribute('aria-haspopup', 'dialog');
  custom.setAttribute('aria-expanded', 'false');
  root.append(choices, custom, current);

  function refresh(): void {
    const value = getAccentChoice();
    const customOverride = isCustomThemeEnabled() && getCustomThemeTokens().accent;
    for (const { id, button } of swatches) button.setAttribute('aria-pressed', String(!customOverride && id === value));
    current.textContent = customOverride
      ? 'Advanced accent override'
      : value.startsWith('#') ? value.toUpperCase() : LABELS[value as AccentPreset];
  }
  refresh();
  return { root, refresh, close: () => popover?.close() };
}
