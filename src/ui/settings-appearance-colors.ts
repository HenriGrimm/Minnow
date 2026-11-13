import {
  getCustomThemeTokens, isCustomThemeEnabled, parseCustomThemeJson, readPresetTokenValue,
  resetCustomTheme, saveCustomThemeOverrides, subscribeCustomThemeChanges,
} from '../appearance/custom-theme';
import { formatCssColor, parseCssColor } from '../appearance/color-format';
import { warnContrastPairs } from '../appearance/contrast';
import { THEME_TOKEN_GROUPS, type CoreThemeTokenKey, type CustomThemeTokens } from '../appearance/types';
import { getStoredTheme } from '../theme';
import { createAppearanceColorInput } from './appearance-color-input';
import { createButton } from './components/button';
import { createField, createSelect } from './components/field';
import { openPopover, type PopoverHandle } from './components/popover';
import { createSettingsToggleRow } from './settings-switch';
import { applyResolvedTheme } from './theme';

const COLOR_NAMES = {
  bg: 'Workspace background',
  'surface-0': 'Workbench panels',
  'surface-1': 'Menus and inputs',
  'surface-2': 'Chat bubbles',
  border: 'Panel dividers',
  'border-strong': 'Input outlines',
  fg: 'Main text',
  'fg-muted': 'Secondary text',
  'fg-subtle': 'Hints and placeholders',
  'fg-on-accent': 'Primary button text',
  accent: 'Primary buttons',
  'accent-soft': 'Highlight fill',
  'accent-border': 'Highlight outline',
  'accent-ink': 'Links and highlights',
  success: 'Success indicators',
  'success-soft': 'Success background',
  'success-border': 'Success outline',
  'success-ink': 'Success text',
  warning: 'Warning indicators',
  danger: 'Error indicators',
  'danger-soft': 'Error background',
  'danger-border': 'Error outline',
  'danger-ink': 'Error text',
  'focus-ring': 'Keyboard focus ring',
  shadow: 'Floating panel shadow',
  folder: 'Folder icons',
} as const satisfies Record<CoreThemeTokenKey, string>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function appendAppearanceCustomColors(mount: HTMLElement): () => void {
  let popover: PopoverHandle | undefined;
  const status = element('span', 'appearance-advanced__status');
  status.setAttribute('role', 'status');
  const anchor = createButton({ label: 'Edit colors…', icon: 'palette', onClick: open });
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  const row = element('div', 'appearance-advanced');
  row.append(status, anchor);
  mount.append(row);

  function refresh(): void {
    const count = Object.keys(getCustomThemeTokens()).length;
    status.textContent = !count ? 'Default colors'
      : !isCustomThemeEnabled() ? 'Overrides paused'
      : count === 1 ? '1 color override' : `${count} color overrides`;
  }

  function open(): void {
    if (popover?.isOpen()) {
      popover.close('anchor');
      return;
    }
    const original = getCustomThemeTokens();
    const wasEnabled = isCustomThemeEnabled();
    let tokens: CustomThemeTokens = { ...original };
    const panel = element('div', 'appearance-color-panel');
    const heading = element('strong', undefined, 'Advanced colors');
    const select = createSelect({ options: [] });
    const options = new Map<CoreThemeTokenKey, HTMLOptionElement>();
    for (const group of THEME_TOKEN_GROUPS) {
      const optgroup = element('optgroup');
      optgroup.label = group.id === 'semantic' ? 'Status and icons' : group.label;
      for (const key of group.keys) {
        const option = element('option', undefined, COLOR_NAMES[key]);
        option.value = key;
        optgroup.append(option);
        options.set(key, option);
      }
      select.append(optgroup);
    }
    const role = createField({ label: 'Interface element', control: select });
    const selected = () => select.value as CoreThemeTokenKey;
    const enabled = createSettingsToggleRow('Use overrides', { checked: wasEnabled });
    const contrast = element('details', 'appearance-color-panel__details appearance-color-panel__contrast');
    const contrastTitle = element('summary');
    const contrastList = element('ul');
    contrast.append(contrastTitle, contrastList);
    contrast.addEventListener('toggle', () => popover?.reposition());
    const picker = createAppearanceColorInput((value) => {
      tokens[selected()] = value;
      enabled.input.checked = true;
      paint(false);
    }, true);

    const reset = createButton({ label: 'Reset color', variant: 'ghost', size: 'sm', onClick: () => {
      delete tokens[selected()];
      paint();
    } });
    const details = element('details', 'appearance-color-panel__details');
    const file = element('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    const fileStatus = element('p', 'appearance-color-panel__file-status');
    fileStatus.setAttribute('role', 'status');
    file.addEventListener('change', async () => {
      const picked = file.files?.[0];
      file.value = '';
      if (!picked) return;
      let palette;
      try {
        palette = parseCustomThemeJson(await picked.text());
      } catch {}
      if (!panel.isConnected) return;
      if (!palette) {
        fileStatus.textContent = 'Choose a valid Minnow palette file.';
        popover?.reposition();
        return;
      }
      tokens = {};
      for (const key of options.keys()) {
        const color = palette.tokens[key];
        if (color && color.length <= 64 && CSS.supports('color', color)) tokens[key] = color;
      }
      enabled.input.checked = palette.enabled;
      fileStatus.textContent = 'Palette loaded. Apply to use it.';
      paint();
    });
    const fileActions = element('div', 'appearance-color-panel__actions');
    fileActions.append(
      createButton({ label: 'Import', size: 'sm', onClick: () => file.click() }),
      createButton({ label: 'Export', size: 'sm', onClick: () => {
        const url = URL.createObjectURL(new Blob([
          JSON.stringify({ version: 1, enabled: enabled.input.checked, tokens }, null, 2),
        ], { type: 'application/json' }));
        const link = element('a');
        link.href = url;
        link.download = 'minnow-theme.json';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }),
      createButton({ label: 'Reset all', size: 'sm', variant: 'ghost', onClick: () => {
        tokens = {};
        paint();
      } }),
    );
    details.append(element('summary', undefined, 'Palette options'), fileActions, file, fileStatus);
    details.addEventListener('toggle', () => popover?.reposition());

    const apply = createButton({ label: 'Apply colors', variant: 'primary', onClick: () => {
      if (!picker.commit()) {
        picker.hex.focus();
        return;
      }
      if (Object.keys(tokens).length) saveCustomThemeOverrides(tokens, enabled.input.checked);
      else resetCustomTheme();
      applyResolvedTheme(getStoredTheme());
      popover?.close();
    } });
    const actions = element('div', 'appearance-color-panel__actions appearance-color-panel__footer');
    actions.append(createButton({ label: 'Cancel', variant: 'ghost', onClick: () => popover?.close() }), apply);

    function paint(syncPicker = true): void {
      const key = selected();
      if (syncPicker) picker.setValue(tokens[key] ?? readPresetTokenValue(key));
      const hasOverrides = Object.keys(tokens).length > 0;
      enabled.input.disabled = !hasOverrides;
      if (!hasOverrides) enabled.input.checked = false;
      reset.disabled = !tokens[key];
      apply.disabled = wasEnabled === enabled.input.checked
        && [...options.keys()].every((key) => original[key] === tokens[key]);
      for (const [key, option] of options) option.textContent = tokens[key] ? `${COLOR_NAMES[key]} · edited` : COLOR_NAMES[key];
      const values: Record<string, string> = {};
      for (const key of ['fg', 'fg-muted', 'bg', 'surface-1', 'fg-on-accent', 'accent', 'accent-ink'] as const) {
        const color = parseCssColor(tokens[key] ?? readPresetTokenValue(key));
        if (color) values[key] = formatCssColor(color);
      }
      const warnings = enabled.input.checked ? warnContrastPairs(values) : [];
      contrast.hidden = !warnings.length;
      contrastTitle.textContent = 'Low text contrast';
      contrastList.replaceChildren(...warnings.map(({ pair, ratio, minimum }) =>
        element('li', undefined, `${pair} · ${ratio.toFixed(1)}:1 (target ${minimum}:1)`)));
      popover?.reposition();
    }

    select.addEventListener('change', () => paint());
    enabled.input.addEventListener('change', () => paint(false));
    panel.append(heading, role.root, picker.root, reset, enabled.row, contrast, details, actions);
    paint();
    popover = openPopover({
      anchor, content: panel, placement: 'bottom-end', ariaLabel: 'Advanced colors',
      className: 'appearance-color-popover', initialFocus: select,
    });
  }
  refresh();
  const unsubscribe = subscribeCustomThemeChanges(refresh);
  return () => {
    popover?.close();
    unsubscribe();
  };
}
