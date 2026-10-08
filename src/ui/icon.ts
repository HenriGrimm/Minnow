export interface IconOptions {
  /** Sets `--mn-icon-size` (default 18px via `.icon-svg`). */
  size?: number;
  /** Extra classes (e.g. `email-icon`, `email-icon--filled`). */
  className?: string;
}

export type ShellIconName =
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'windowClose'
  | 'windowMinimize'
  | 'windowMaximize'
  | 'windowRestore'
  | 'grid'
  | 'bell'
  | 'bellOff'
  | 'arrowUp'
  | 'arrowDown'
  | 'globe'
  | 'folder'
  | 'fileText'
  | 'fileTree';

export type AppIconName =
  | 'appCode'
  | 'appChat'
  | 'appResearch'
  | 'appExpertLab'
  | 'appBenchmark'
  | 'appCompare'
  | 'appScheduler'
  | 'appCalendar'
  | 'appEmail'
  | 'appIssues'
  | 'appModels'
  | 'appBrain'
  | 'appSettings'
  | 'appStats'
  | 'appConsole'
  | 'appServers'
  | 'appAgentActivity'
  | 'appCodeOverview'
  | 'appCodeBrainMap'
  | 'appDevServer';

export type ModeIconName =
  | 'modeGeneral'
  | 'modeBuild'
  | 'modePlan'
  | 'modeSuperPlan'
  | 'modeDebug'
  | 'modeOrchestrate'
  | 'modeReef';

export type GitIconName =
  | 'gitPull'
  | 'gitPush'
  | 'gitFetch'
  | 'gitMerge'
  | 'gitRebase'
  | 'gitStash'
  | 'gitCherryPick'
  | 'gitBranch'
  | 'gitLocal'
  | 'gitWorktree'
  | 'gitGraph'
  | 'gitCommit';

export type EmailIconName =
  | 'compose'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'star'
  | 'starFilled'
  | 'archive'
  | 'trash'
  | 'mail'
  | 'mailOpen'
  | 'attach'
  | 'sync'
  | 'spam'
  | 'snooze'
  | 'move'
  | 'dashboard'
  | 'automations'
  | 'testConnection'
  | 'signOut';

export type ChromeIconName =
  | 'search'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronUp'
  | 'chevronDown'
  | 'back'
  | 'more'
  | 'menu'
  | 'plus'
  | 'capture'
  | 'check'
  | 'help'
  | 'settings'
  | 'refresh'
  | 'send'
  | 'stop'
  | 'save'
  | 'download'
  | 'upload'
  | 'undo'
  | 'clear'
  | 'expand'
  | 'compress'
  | 'edit'
  | 'addFolder'
  | 'openProject'
  | 'terminal'
  | 'browser'
  | 'deviceMobile'
  | 'deviceTablet'
  | 'deviceDesktop'
  | 'designMode'
  | 'dock'
  | 'inspectorPanel'
  | 'mic'
  | 'speaker'
  | 'tools'
  | 'boardView'
  | 'loop'
  | 'sparkles'
  | 'thinkingBrain'
  | 'reasoning'
  | 'codeMapInjection'
  | 'contextDocuments'
  | 'inbox'
  | 'moon'
  | 'link'
  | 'externalLink'
  | 'pullRequest'
  | 'subIssues'
  | 'comment'
  | 'copy'
  | 'clock';

export type BoardIconName =
  | 'boardBuild'
  | 'boardFix'
  | 'boardTest'
  | 'boardGroup';

export type StatusIconName =
  | 'statusPass'
  | 'statusFail'
  | 'statusSkip'
  | 'statusRunning'
  | 'statusPending';

export type BrainIconName =
  | 'brainGraph'
  | 'brainLog'
  | 'brainSchema'
  | 'brainProposals'
  | 'brainMemories'
  | 'brainIngest'
  | 'brainLint';

export type MetricIconName =
  | 'metricTps'
  | 'metricTtft'
  | 'metricGen'
  | 'metricTotal'
  | 'metricCtx';

/** All 149 semantic icon names. */
export type IconName =
  | ShellIconName
  | AppIconName
  | ModeIconName
  | GitIconName
  | EmailIconName
  | ChromeIconName
  | BoardIconName
  | StatusIconName
  | BrainIconName
  | MetricIconName;

/** Uicons class for each semantic name — transcribed from confirmed mapping. */
export const ICON_CLASS: Record<IconName, string> = {
  close: 'fi-rr-cross-small',
  minimize: 'fi-rr-minus-small',
  maximize: 'fi-rr-square',
  restore: 'fi-rr-duplicate',
  windowClose: 'fi-rr-cross',
  windowMinimize: 'fi-rr-window-minimize',
  windowMaximize: 'fi-rr-window-maximize',
  windowRestore: 'fi-rr-window-restore',
  grid: 'fi-rr-apps',
  bell: 'fi-rr-bell',
  bellOff: 'fi-rr-bell-slash',
  arrowUp: 'fi-rr-arrow-up',
  arrowDown: 'fi-rr-arrow-down',
  globe: 'fi-rr-globe',
  folder: 'fi-rr-folder',
  fileText: 'fi-rr-document',
  fileTree: 'fi-rr-folder',

  appCode: 'fi-rr-code-simple',
  appChat: 'fi-rr-comment',
  appResearch: 'fi-rr-search',
  appExpertLab: 'fi-rr-flask',
  appBenchmark: 'fi-rr-chart-simple',
  appCompare: 'fi-rr-columns-3',
  appScheduler: 'fi-rr-calendar-clock',
  appCalendar: 'fi-rr-calendar',
  appEmail: 'fi-rr-envelope',
  appIssues: 'fi-rr-ticket',
  appModels: 'fi-rr-microchip',
  appBrain: 'fi-rr-brain-circuit',
  appSettings: 'fi-rr-settings',
  appStats: 'fi-rr-stats',
  appConsole: 'fi-rr-terminal',
  appServers: 'fi-rr-database',
  appAgentActivity: 'fi-rr-user-robot',
  appCodeOverview: 'fi-sr-dashboard-panel',
  appCodeBrainMap: 'fi-rr-sitemap',
  appDevServer: 'fi-rr-cloud-code',

  modeGeneral: 'fi-sr-comment-dots',
  modeBuild: 'fi-sr-hammer',
  modePlan: 'fi-sr-clipboard-list',
  modeSuperPlan: 'fi-sr-clipboard-list-check',
  modeDebug: 'fi-sr-bug',
  modeOrchestrate: 'fi-sr-network',
  modeReef: 'fi-rr-coral-reef',

  gitPull: 'fi-rr-cloud-download',
  gitPush: 'fi-rr-cloud-upload',
  gitFetch: 'fi-rr-refresh',
  gitMerge: 'fi-rr-code-merge',
  gitRebase: 'fi-rr-code-branch',
  gitStash: 'fi-rr-box-open',
  gitCherryPick: 'fi-rr-cherry',
  gitBranch: 'fi-sr-code-branch',
  gitLocal: 'fi-sr-computer',
  gitWorktree: 'fi-sr-folder-tree',
  gitGraph: 'fi-rr-chart-network',
  gitCommit: 'fi-rr-code-commit',

  compose: 'fi-rr-pencil',
  reply: 'fi-rr-arrow-turn-down-left',
  replyAll: 'fi-rr-reply-all',
  forward: 'fi-rr-forward',
  star: 'fi-rr-star',
  starFilled: 'fi-sr-star',
  archive: 'fi-rr-box-alt',
  trash: 'fi-rr-trash',
  mail: 'fi-rr-envelope',
  mailOpen: 'fi-rr-envelope-open',
  attach: 'fi-rr-clip',
  sync: 'fi-rr-refresh',
  spam: 'fi-rr-shield-exclamation',
  snooze: 'fi-rr-alarm-snooze',
  move: 'fi-rr-folder-open',
  dashboard: 'fi-rr-dashboard',
  automations: 'fi-rr-bolt',
  testConnection: 'fi-rr-plug',
  signOut: 'fi-rr-sign-out-alt',

  search: 'fi-rr-search',
  chevronLeft: 'fi-rr-angle-small-left',
  chevronRight: 'fi-rr-angle-small-right',
  chevronUp: 'fi-rr-angle-small-up',
  chevronDown: 'fi-rr-angle-small-down',
  back: 'fi-rr-arrow-left',
  more: 'fi-rr-menu-dots',
  menu: 'fi-rr-menu-burger',
  plus: 'fi-rr-plus-small',
  capture: 'fi-rr-ticket',
  check: 'fi-rr-check',
  help: 'fi-rr-interrogation',
  settings: 'fi-rr-settings-sliders',
  refresh: 'fi-rr-refresh',
  send: 'fi-rr-paper-plane',
  stop: 'fi-rr-square',
  save: 'fi-rr-disk',
  download: 'fi-rr-download',
  upload: 'fi-rr-upload',
  undo: 'fi-rr-undo-alt',
  clear: 'fi-rr-trash',
  expand: 'fi-rr-expand',
  compress: 'fi-rr-compress-alt',
  edit: 'fi-rr-edit',
  addFolder: 'fi-rr-add-folder',
  openProject: 'fi-rr-folder-open',
  terminal: 'fi-rr-terminal',
  browser: 'fi-rr-browser',
  deviceMobile: 'fi-rr-mobile',
  deviceTablet: 'fi-rr-tablet',
  deviceDesktop: 'fi-rr-computer',
  designMode: 'fi-rr-magic-wand',
  dock: 'fi-rr-layout-fluid',
  inspectorPanel: 'fi-rr-sidebar-flip',
  mic: 'fi-rr-microphone',
  speaker: 'fi-rr-volume',
  tools: 'fi-rr-tools',
  boardView: 'fi-rr-layout-fluid',
  loop: 'fi-rr-rotate-right',
  sparkles: 'fi-rr-sparkles',
  thinkingBrain: 'fi-sr-brain',
  reasoning: 'fi-sr-bulb',
  codeMapInjection: 'fi-rr-sitemap',
  contextDocuments: 'fi-rr-document-signed',
  inbox: 'fi-rr-inbox',
  moon: 'fi-rr-moon',
  link: 'fi-rr-link-alt',
  externalLink: 'fi-rr-arrow-up-right-from-square',
  pullRequest: 'fi-rr-code-pull-request',
  subIssues: 'fi-rr-sitemap',
  comment: 'fi-rr-comment-alt',
  copy: 'fi-rr-copy-alt',
  clock: 'fi-rr-clock',

  boardBuild: 'fi-sr-hammer',
  boardFix: 'fi-sr-band-aid',
  boardTest: 'fi-sr-flask',
  boardGroup: 'fi-rr-objects-column',

  statusPass: 'fi-rr-check-circle',
  statusFail: 'fi-rr-cross-circle',
  statusSkip: 'fi-rr-minus-circle',
  statusRunning: 'fi-rr-spinner',
  statusPending: 'fi-rr-clock',

  brainGraph: 'fi-rr-chart-network',
  brainLog: 'fi-rr-list',
  brainSchema: 'fi-rr-table-layout',
  brainProposals: 'fi-rr-layers',
  brainMemories: 'fi-rr-brain',
  brainIngest: 'fi-rr-inbox-in',
  brainLint: 'fi-rr-triangle-warning',

  metricTps: 'fi-rr-bolt',
  metricTtft: 'fi-rr-play',
  metricGen: 'fi-rr-clock',
  metricTotal: 'fi-rr-layers',
  metricCtx: 'fi-rr-scale',
};

/** Build class list for a Uicons glyph. */
function iconClassList(name: IconName, extraClassName?: string): string {
  const uicon = ICON_CLASS[name];
  const parts = ['fi', uicon, 'icon-svg'];
  if (extraClassName) parts.push(extraClassName);
  return parts.join(' ');
}

/** Create a Uicons `<i>` element tinted via `currentColor`. */
export function createIcon(name: IconName, options: IconOptions = {}): HTMLElement {
  const { size, className } = options;
  const el = document.createElement('i');
  el.className = iconClassList(name, className);
  el.setAttribute('aria-hidden', 'true');
  if (size != null) el.style.setProperty('--mn-icon-size', `${size}px`);
  return el;
}

/** Same markup as `createIcon`, for template literals / innerHTML. */
export function iconHtml(name: IconName, options: IconOptions = {}): string {
  const { size, className } = options;
  const cls = iconClassList(name, className);
  const style = size != null ? ` style="--mn-icon-size:${size}px"` : '';
  return `<i class="${cls}" aria-hidden="true"${style}></i>`;
}

/** Apply a different semantic icon to an existing Uicons element. */
export function applyIcon(el: HTMLElement, name: IconName, options: IconOptions = {}): void {
  const uicon = ICON_CLASS[name];
  const keep = Array.from(el.classList).filter(
    (c) => c !== 'fi' && !c.startsWith('fi-rr-') && !c.startsWith('fi-sr-'),
  );
  el.className = ['fi', uicon, ...keep].join(' ');
  if (options.className) {
    for (const c of options.className.split(/\s+/)) {
      if (c) el.classList.add(c);
    }
  }
  if (options.size != null) {
    el.style.setProperty('--mn-icon-size', `${options.size}px`);
  }
}
