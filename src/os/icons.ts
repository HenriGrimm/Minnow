/**
 * OS shell icons — delegates to the central Uicons registry.
 */

import { createIcon, iconHtml, type IconName } from '../ui/icon';

export type OsIconName =
  | 'sourceControl'
  | 'code'
  | 'chat'
  | 'research'
  | 'flask'
  | 'bench'
  | 'compare'
  | 'scheduler'
  | 'issues'
  | 'chip'
  | 'brain'
  | 'gear'
  | 'arrowUp'
  | 'arrowDown'
  | 'grid'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'bell'
  | 'bellOff'
  | 'folder'
  | 'globe'
  | 'fileText';

/** @deprecated Use semantic IconName via createIcon — kept for app-registry imports. */
export const COMPARE_ICON_SRC = 'appCompare';
export const BRAIN_ICON_SRC = 'appBrain';
export const ISSUES_ICON_SRC = 'appIssues';

const OS_TO_ICON: Record<OsIconName, IconName> = {
  sourceControl: 'gitBranch',
  code: 'appCode',
  chat: 'appChat',
  research: 'appResearch',
  flask: 'appExpertLab',
  bench: 'appBenchmark',
  compare: 'appCompare',
  scheduler: 'appScheduler',
  issues: 'appIssues',
  chip: 'appModels',
  brain: 'appBrain',
  gear: 'appSettings',
  arrowUp: 'arrowUp',
  arrowDown: 'arrowDown',
  grid: 'grid',
  close: 'windowClose',
  minimize: 'windowMinimize',
  maximize: 'windowMaximize',
  restore: 'windowRestore',
  bell: 'bell',
  bellOff: 'bellOff',
  folder: 'folder',
  globe: 'globe',
  fileText: 'fileText',
};

export interface OsIconOptions {
  size?: number;
  className?: string;
}

/** Create a launcher or chrome icon element. */
export function createAppIcon(name: OsIconName, options: OsIconOptions = {}): HTMLElement {
  return createIcon(OS_TO_ICON[name], options);
}

/** @deprecated Alias for createAppIcon — all OS icons are now Uicons glyphs. */
export function createOsIcon(name: OsIconName, options: OsIconOptions = {}): HTMLElement {
  return createAppIcon(name, options);
}

/** HTML string for static templates. */
export function osIconHtml(name: OsIconName, options: OsIconOptions = {}): string {
  return iconHtml(OS_TO_ICON[name], options);
}
