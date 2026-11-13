import { formatCssColor, parseCssColorOrDefault, rgbaToColorInputValue } from '../appearance/color-format';
import { createField, createTextInput } from './components/field';

export function createAppearanceColorInput(onChange: (value: string) => void, showOpacity = false) {
  let color = parseCssColorOrDefault('');
  const root = document.createElement('div');
  root.className = 'appearance-color-input';
  const row = document.createElement('div');
  row.className = 'appearance-color-input__row';
  const swatch = document.createElement('input');
  swatch.type = 'color';
  swatch.className = 'appearance-color-input__swatch';
  swatch.setAttribute('aria-label', 'Open color picker');
  const hex = createTextInput({ autocomplete: 'off', spellcheck: false });
  hex.maxLength = 7;
  const field = createField({ label: 'Hex color', control: hex });
  row.append(swatch, field.root);
  root.append(row);

  const opacity = document.createElement('input');
  opacity.type = 'range';
  opacity.min = '0';
  opacity.max = '100';
  opacity.setAttribute('aria-label', 'Opacity');
  const label = document.createElement('label');
  label.className = 'appearance-color-input__opacity';
  const percentage = document.createElement('span');
  label.append('Opacity', opacity, percentage);
  if (showOpacity) root.append(label);

  function paint(): void {
    swatch.value = rgbaToColorInputValue(color);
    swatch.style.setProperty('--appearance-swatch-opacity', String(color.a));
    hex.value = swatch.value.toUpperCase();
    opacity.value = String(Math.round(color.a * 100));
    percentage.textContent = `${opacity.value}%`;
    opacity.setAttribute('aria-valuetext', percentage.textContent);
    field.setError(null);
  }

  function commit(value: string): boolean {
    const rgb = value.trim().replace(/^#/, '');
    if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(rgb)) {
      field.setError('Enter a 3- or 6-digit hex color.');
      return false;
    }
    const before = formatCssColor(color);
    color = { ...parseCssColorOrDefault(`#${rgb}`), a: color.a };
    paint();
    const after = formatCssColor(color);
    if (after !== before) onChange(after);
    return true;
  }

  swatch.addEventListener('input', () => commit(swatch.value));
  hex.addEventListener('change', () => commit(hex.value));
  hex.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit(hex.value);
  });
  opacity.addEventListener('input', () => {
    color = { ...color, a: Number(opacity.value) / 100 };
    paint();
    onChange(formatCssColor(color));
  });

  return {
    root,
    hex,
    setValue(value: string) {
      color = parseCssColorOrDefault(value);
      if (!showOpacity) color.a = 1;
      paint();
    },
    commit: () => commit(hex.value),
  };
}
