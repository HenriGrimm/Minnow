import {
  getFollowSystem,
  getMode,
  getStoredFamily,
  getStoredTheme,
  setFollowSystem,
  setThemeFamily,
  setThemeMode,
  THEME_FAMILY_META,
  type ThemeFamily,
  type ThemeMode,
} from '../theme';
import { applyResolvedTheme } from './theme';
import { createSettingsToggleRow } from './settings-switch';
import { iconHtml } from './icon';

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

const CHECK_SVG =
  iconHtml('check', { className: 'settings-theme-check' });

/** Build a miniature window mock that previews palette tokens for one family. */
function appendFamilyPreview(family: ThemeFamily, mode: ThemeMode): HTMLElement {
  const preview = el('div', 'settings-theme-preview');
  preview.setAttribute('data-theme', `${family}-${mode}`);

  const window = el('div', 'settings-theme-preview__window');
  const titlebar = el('div', 'settings-theme-preview__titlebar');
  titlebar.append(
    el('span', 'settings-theme-preview__titlebar-dot'),
    el('span', 'settings-theme-preview__titlebar-dot'),
    el('span', 'settings-theme-preview__titlebar-dot settings-theme-preview__titlebar-dot--accent'),
  );
  const content = el('div', 'settings-theme-preview__content');
  content.append(
    el('span', 'settings-theme-preview__line settings-theme-preview__line--wide'),
    el('span', 'settings-theme-preview__line'),
    el('span', 'settings-theme-preview__line settings-theme-preview__line--short'),
  );
  window.append(titlebar, content);
  preview.appendChild(window);
  return preview;
}

export type ThemeControlsState = {
  followSystem: boolean;
  family: ThemeFamily;
  mode: ThemeMode;
};

export type ThemeControlsOptions = {
  /** Fired after the user changes family, mode, or follow-system. */
  onChange?: (state: ThemeControlsState) => void;
};

/** Mount theme family grid, mode pills, and follow-system control. */
export function appendThemeControls(mount: HTMLElement, options?: ThemeControlsOptions): void {
  const block = el('div', 'settings-theme-block');

  const toolbar = el('div', 'settings-theme-toolbar');

  const { row: followRow, input: followInput } = createSettingsToggleRow(
    'Follow system appearance',
    { checked: getFollowSystem() },
  );
  followRow.classList.add('settings-theme-toolbar__follow');
  toolbar.appendChild(followRow);

  const modeRow = el('div', 'settings-theme-modes');
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', 'Color mode');
  const modeButtons: HTMLButtonElement[] = [];
  toolbar.appendChild(modeRow);
  block.appendChild(toolbar);

  const familyList = el('div', 'settings-theme-families settings-theme-families--grid');
  familyList.setAttribute('role', 'group');
  familyList.setAttribute('aria-label', 'Theme family');
  const familyButtons: HTMLButtonElement[] = [];

  const currentId = getStoredTheme();
  const currentFamily = getStoredFamily();
  const currentMode = getMode(currentId);

  function notifyChange(): void {
    options?.onChange?.({
      followSystem: getFollowSystem(),
      family: getStoredFamily(),
      mode: getMode(getStoredTheme()),
    });
  }

  function refreshChrome(): void {
    const follow = getFollowSystem();
    const fam = getStoredFamily();
    const mode = getMode(getStoredTheme());
    modeRow.classList.toggle('is-system', follow);
    for (const btn of modeButtons) {
      const m = btn.dataset.mode as ThemeMode;
      btn.classList.toggle('is-active', !follow && m === mode);
      btn.setAttribute('aria-pressed', String(!follow && m === mode));
      btn.disabled = follow;
    }
    for (const btn of familyButtons) {
      const f = btn.dataset.family as ThemeFamily;
      btn.classList.toggle('is-active', f === fam);
      btn.setAttribute('aria-pressed', String(f === fam));
      const preview = btn.querySelector('.settings-theme-preview');
      if (preview instanceof HTMLElement) {
        preview.setAttribute('data-theme', `${f}-${mode}`);
      }
    }
  }

  for (const meta of THEME_FAMILY_META) {
    const item = el('button', 'settings-theme-family');
    item.type = 'button';
    item.dataset.family = meta.id;

    const head = el('div', 'settings-theme-family__head');
    head.appendChild(el('span', 'settings-theme-family__name', meta.name));
    head.appendChild(el('span', 'settings-theme-family__blurb', meta.blurb));
    item.appendChild(head);
    item.appendChild(appendFamilyPreview(meta.id, currentMode));
    item.insertAdjacentHTML('beforeend', CHECK_SVG);

    item.addEventListener('click', () => {
      setThemeFamily(meta.id);
      applyResolvedTheme(getStoredTheme());
      refreshChrome();
      notifyChange();
    });

    familyButtons.push(item);
    familyList.appendChild(item);
  }

  for (const mode of ['dark', 'light'] as const) {
    const btn = el('button', 'settings-theme-mode');
    btn.type = 'button';
    btn.dataset.mode = mode;
    btn.textContent = mode === 'dark' ? 'Dark' : 'Light';
    btn.setAttribute('aria-pressed', String(!getFollowSystem() && mode === currentMode));
    if (!getFollowSystem() && mode === currentMode) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      if (getFollowSystem()) return;
      setThemeMode(mode);
      applyResolvedTheme(getStoredTheme());
      refreshChrome();
      notifyChange();
    });
    modeButtons.push(btn);
    modeRow.appendChild(btn);
  }

  followInput.addEventListener('change', () => {
    setFollowSystem(followInput.checked);
    applyResolvedTheme(getStoredTheme());
    refreshChrome();
    notifyChange();
  });

  block.appendChild(familyList);
  mount.appendChild(block);
  refreshChrome();
}
