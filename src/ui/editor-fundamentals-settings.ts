import {
  loadEditorSettings,
  saveEditorSettings,
  type EditorSettings,
} from '../config/editor-settings';
import { appendSettingsGroup } from './settings-layout';
import { createSettingsToggleRow } from './settings-switch';
import { setStatus } from './status';

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

/** Append Editor → Code editing controls to the settings mount. */
export async function appendEditorFundamentalsSettings(mount: HTMLElement): Promise<void> {
  const settings = await loadEditorSettings();

  const group = appendSettingsGroup(
    mount,
    'Code editing',
    'CodeMirror defaults for the file viewer: wrap, indentation, and whitespace guides.',
    'integrations.editor',
    { emphasis: true },
  );

  const { row: wrapRow } = createSettingsToggleRow('Word wrap', {
    checked: settings.wordWrap,
    ariaLabel: 'Wrap long lines in the file editor',
    onChange: async (wordWrap) => {
      await saveEditorSettings({ wordWrap });
    },
  });
  group.append(wrapRow);

  const { row: wsRow } = createSettingsToggleRow('Show whitespace', {
    checked: settings.renderWhitespace,
    ariaLabel: 'Highlight spaces and tabs in the file editor',
    onChange: async (renderWhitespace) => {
      await saveEditorSettings({ renderWhitespace });
    },
  });
  group.append(wsRow);

  const grid = el('dl', 'settings-kv settings-editor-fundamentals');
  grid.append(el('dt', 'settings-kv__term', 'Font size'));
  const fontDd = el('dd', 'settings-kv__value');
  const fontInput = document.createElement('input');
  fontInput.type = 'number';
  fontInput.min = '10';
  fontInput.max = '24';
  fontInput.step = '1';
  fontInput.value = String(settings.fontSize);
  fontInput.className = 'settings-select settings-kv-input';
  fontInput.setAttribute('aria-label', 'Editor font size in pixels');
  fontInput.addEventListener('change', () => {
    const raw = Number(fontInput.value);
    const fontSize = Number.isFinite(raw)
      ? Math.min(24, Math.max(10, Math.round(raw)))
      : settings.fontSize;
    fontInput.value = String(fontSize);
    void saveEditorSettings({ fontSize }).then(() => setStatus('idle', 'Font size saved'));
  });
  fontDd.append(fontInput, el('span', 'settings-kv-suffix', 'px'));
  grid.append(fontDd);

  grid.append(el('dt', 'settings-kv__term', 'Tab size'));
  const tabDd = el('dd', 'settings-kv__value');
  const tabInput = document.createElement('input');
  tabInput.type = 'number';
  tabInput.min = '1';
  tabInput.max = '8';
  tabInput.step = '1';
  tabInput.value = String(settings.tabSize);
  tabInput.className = 'settings-select settings-kv-input';
  tabInput.setAttribute('aria-label', 'Spaces per Tab in the file editor');
  tabInput.addEventListener('change', () => {
    const raw = Number(tabInput.value);
    const tabSize = Number.isFinite(raw)
      ? Math.min(8, Math.max(1, Math.round(raw)))
      : settings.tabSize;
    tabInput.value = String(tabSize);
    void saveEditorSettings({ tabSize }).then(() => setStatus('idle', 'Tab size saved'));
  });
  tabDd.append(tabInput, el('span', 'settings-kv-suffix', 'spaces'));
  grid.append(tabDd);

  group.append(grid);

  const hint = el(
    'p',
    'settings-group__lead settings-editor-fundamentals__hint',
    'Find (Ctrl/Cmd+F), replace, folding, and multi-cursor use CodeMirror defaults. Reopen a file to apply font and tab changes.',
  );
  group.append(hint);
}

/** @internal test helper */
export function formatEditorFundamentalsSummary(settings: EditorSettings): string {
  return `${settings.fontSize}px · tab ${settings.tabSize} · wrap ${settings.wordWrap ? 'on' : 'off'}`;
}
