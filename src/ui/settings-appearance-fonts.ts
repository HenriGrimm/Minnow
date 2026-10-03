/**
 * Settings → Appearance: UI and monospace font presets + uploads.
 */

import { saveAppearanceAsset } from '../appearance/asset-store';
import type { FontCatalogEntry } from '../appearance/font-catalog';
import {
  applyAppearanceFonts,
  getAppearanceFonts,
  GOOGLE_FONTS_LINK_ID,
  MONO_FONT_CATALOG,
  setAppearanceFonts,
  setMonoFont,
  setUiFont,
  UI_FONT_CATALOG,
} from '../appearance/fonts';
import type { MonoFontPresetId, UiFontPresetId } from '../appearance/types';
import { appAlert } from './app-dialog';

let fontRowCounter = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Native <select> with System first and the rest under a Google Fonts group. */
function buildCatalogSelect(
  catalog: readonly FontCatalogEntry[],
  value: string,
  onChange: (id: string) => void,
): HTMLSelectElement {
  const select = el('select', 'settings-select settings-appearance-font-select');
  const googleGroup = document.createElement('optgroup');
  googleGroup.label = 'Google Fonts';

  for (const entry of catalog) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.label;
    if (entry.id === value) opt.selected = true;
    if (entry.google && entry.id !== 'system') {
      googleGroup.appendChild(opt);
    } else {
      select.appendChild(opt);
    }
  }
  if (googleGroup.childElementCount > 0) {
    select.appendChild(googleGroup);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function appendFontRow(
  mount: HTMLElement,
  label: string,
  select: HTMLSelectElement,
  onUpload: (file: File) => Promise<void>,
): void {
  const row = el('div', 'settings-appearance-font-row');
  const title = el('label', 'settings-appearance-font-row__label', label);
  select.id = `settings-font-${++fontRowCounter}`;
  title.htmlFor = select.id;
  row.appendChild(title);
  row.appendChild(select);

  const uploadLabel = el('button', 'settings-action-btn settings-appearance-font-upload');
  uploadLabel.type = 'button';
  uploadLabel.setAttribute('aria-label', `Upload ${label.toLowerCase()}`);
  uploadLabel.textContent = 'Upload font';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.woff2,.woff,.ttf,.otf,font/woff2,font/woff';
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      await onUpload(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appAlert(msg);
    }
  });
  uploadLabel.addEventListener('click', () => input.click());
  row.append(uploadLabel, input);
  mount.appendChild(row);
}

/** Mount font preset dropdowns, specimen preview, and upload controls. */
export function appendAppearanceFonts(mount: HTMLElement): void {
  const specimen = el('div', 'settings-appearance-font-specimen');

  const uiBlock = el('div', 'settings-appearance-font-specimen__block');
  uiBlock.appendChild(el('span', 'settings-appearance-font-specimen__label', 'UI'));
  const preview = el('p', 'settings-appearance-font-preview');
  preview.style.fontFamily = 'var(--font-ui)';
  preview.textContent = 'The quick brown fox jumps over the lazy dog. 0123456789';
  uiBlock.appendChild(preview);

  const monoBlock = el('div', 'settings-appearance-font-specimen__block');
  monoBlock.appendChild(el('span', 'settings-appearance-font-specimen__label', 'Mono'));
  const monoPreview = el(
    'pre',
    'settings-appearance-font-preview settings-appearance-font-preview--mono',
  );
  monoPreview.style.fontFamily = 'var(--font-mono)';
  monoPreview.textContent = 'const minnow = "swimming"; // mono preview';
  monoBlock.appendChild(monoPreview);

  specimen.append(uiBlock, monoBlock);
  mount.appendChild(specimen);

  function refreshPreview(): void {
    preview.style.fontFamily = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-ui')
      .trim();
    monoPreview.style.fontFamily = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-mono')
      .trim();
  }

  // Specimen paints fallbacks until the lazy Google Fonts stylesheet arrives.
  function refreshPreviewWhenReady(): void {
    refreshPreview();
    const link = document.getElementById(GOOGLE_FONTS_LINK_ID);
    if (link) {
      link.addEventListener('load', refreshPreview, { once: true });
    }
    if (document.fonts?.ready) {
      void document.fonts.ready.then(refreshPreview);
    }
  }

  const fonts = getAppearanceFonts();
  let uiId: UiFontPresetId = 'system';
  if (fonts.ui.kind === 'preset' && fonts.ui.slot === 'ui') {
    uiId = fonts.ui.id;
  }
  let monoId: MonoFontPresetId = 'system';
  if (fonts.mono.kind === 'preset' && fonts.mono.slot === 'mono') {
    monoId = fonts.mono.id;
  }

  const controls = el('div', 'settings-appearance-font-controls');

  const uiSelect = buildCatalogSelect(UI_FONT_CATALOG, uiId, (id) => {
    setUiFont({ kind: 'preset', slot: 'ui', id: id as UiFontPresetId });
    refreshPreviewWhenReady();
  });

  const monoSelect = buildCatalogSelect(MONO_FONT_CATALOG, monoId, (id) => {
    setMonoFont({ kind: 'preset', slot: 'mono', id: id as MonoFontPresetId });
    refreshPreviewWhenReady();
  });

  appendFontRow(controls, 'UI font', uiSelect, async (file) => {
    const assetId = await saveAppearanceAsset('font', file);
    const base = file.name.replace(/\.[^.]+$/, '');
    const familyName = `MinnowUI_${base.replace(/\W+/g, '_')}`;
    setUiFont({ kind: 'upload', slot: 'ui', assetId, familyName });
    uiSelect.value = 'system';
    refreshPreviewWhenReady();
  });

  appendFontRow(controls, 'Monospace font', monoSelect, async (file) => {
    const assetId = await saveAppearanceAsset('font', file);
    const base = file.name.replace(/\.[^.]+$/, '');
    const familyName = `MinnowMono_${base.replace(/\W+/g, '_')}`;
    setMonoFont({ kind: 'upload', slot: 'mono', assetId, familyName });
    monoSelect.value = 'system';
    refreshPreviewWhenReady();
  });

  const hint = el(
    'p',
    'settings-field-hint',
    fonts.ui.kind === 'upload' || fonts.mono.kind === 'upload'
      ? 'Custom uploaded fonts are stored in this browser (IndexedDB). Google Fonts load only for the selected UI and mono pair; System UI stays local.'
      : 'Google Fonts load only for the selected UI and mono pair. System UI uses the fonts already on this machine.',
  );
  controls.appendChild(hint);

  const resetBtn = el('button', 'settings-action-btn', 'Reset fonts to default');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => {
    setAppearanceFonts({
      ui: { kind: 'preset', slot: 'ui', id: 'system' },
      mono: { kind: 'preset', slot: 'mono', id: 'system' },
    });
    void applyAppearanceFonts();
    uiSelect.value = 'system';
    monoSelect.value = 'system';
    refreshPreviewWhenReady();
  });
  controls.appendChild(resetBtn);
  mount.appendChild(controls);

  refreshPreviewWhenReady();
}
