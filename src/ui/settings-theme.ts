import { getFollowSystem, getMode, getStoredFamily, getStoredTheme, setFollowSystem, setThemeMode, type ThemeFamily, type ThemeMode } from '../theme';
import { createAppearanceAccents } from './settings-accent';
import { createSegmentedControl } from './components/segmented';
import { applyResolvedTheme } from './theme';

export type ThemeControlsState = {
  followSystem: boolean;
  family: ThemeFamily;
  mode: ThemeMode;
};

export function appendThemeControls(
  mount: HTMLElement,
  options?: { onChange?: (state: ThemeControlsState) => void },
): () => void {
  const block = document.createElement('div');
  block.className = 'settings-theme-block appearance-onboarding';
  const notify = () => options?.onChange?.({
    followSystem: getFollowSystem(),
    family: getStoredFamily(),
    mode: getMode(getStoredTheme()),
  });
  const modes = createSegmentedControl({
    ariaLabel: 'Mode',
    options: [
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
      { value: 'system', label: 'System' },
    ],
    value: getFollowSystem() ? 'system' : getMode(getStoredTheme()),
    onChange(value) {
      if (value === 'system') setFollowSystem(true);
      else setThemeMode(value === 'light' ? 'light' : 'dark');
      applyResolvedTheme(getStoredTheme());
      accents.refresh();
      notify();
    },
  });
  const accents = createAppearanceAccents(notify);
  block.append(modes.root, accents.root);
  mount.append(block);
  return accents.close;
}
