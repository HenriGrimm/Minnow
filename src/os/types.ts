/** Minnow app identifiers — one per launcher tile. */
export type AppId =
  | 'source-control'
  | 'code'
  | 'research'
  | 'experts'
  | 'bench'
  | 'compare'
  | 'models'
  | 'brain'
  | 'scheduler'
  | 'issues'
  | 'settings';

/** Shell surface: workspace gate vs a foreground app. */
export type OsView = 'workspaces' | 'app';

import type { ModeId } from '../chat/modes/types';
import type { ChatRunTargetChoice } from '../state/chat-worktree';

/** One running app instance (may share an appId with other closed/reopened windows). */
export interface AppInstance {
  id: string;
  appId: AppId;
  /** Optional concierge seed text passed when launching chat/research. */
  seed?: string;
  /** Full launch payload from concierge or router (consumed once by app-host). */
  launchOptions?: LaunchOptions;
  unread: number;
  /** Latest background notification snippet for dock previews. */
  msg: string;
}

/** Options when launching or foregrounding an app from the shell or router. */
export interface LaunchOptions {
  seed?: string;
  /** Settings section slug when opening from legacy `#/settings/…` redirects. */
  settingsSection?: string;
  /** Catalog field key to scroll to and highlight in Settings. */
  settingsSearchKey?: string;
  /** Models app section slug when opening from `#/app/models/…` deep links. */
  modelsSection?: string;
  /** Brain app section slug when opening from `#/app/brain/…` deep links. */
  brainSection?: string;
  /** Brain Edit: wiki path to load after foregrounding the window. */
  brainEditPath?: string;
  /** Code app: composer mode to activate. */
  modeId?: ModeId;
  /** Code app: absolute workspace path from the recent-workspace list. */
  workspacePath?: string;
  /**
   * Code app: queue as composer `codeRef` attachments before auto-send
   * (Issues Plan / Debug launches).
   */
  codeRefs?: Array<{
    path: string;
    startLine?: number;
    endLine?: number;
    text?: string;
  }>;
  /** Research: start a run immediately when a seed is present. */
  autoRun?: boolean;
  /**
   * Code app: apply this run target after the seeded chat is created and
   * before auto-send (Issues Send to chat).
   */
  runTarget?: ChatRunTargetChoice;
  /** Code app: switch to this chat after launch (notification deep-link). */
  chatId?: string;
  /** Code app section: chat workspace or a view-bar stage destination. */
  codeSection?: CodeSectionId;
  /** Experts hub: initial step when opening on the desktop surface. */
  step?: 'browse' | 'create' | 'edit';
  /** Experts hub: pre-select an expert in the roster. */
  expertId?: string;
  /** Desktop experts: open the full lab panel on entry. */
  openLab?: boolean;
  /** When set, closing this app returns to the given app (e.g. Settings from Code). */
  returnToApp?: AppId;
}

/** Code app sub-routes. Every view-bar destination has a hash so they can replace each other. */
export type CodeSectionId =
  | 'overview'
  | 'chat'
  | 'dev-server'
  | 'super-plan'
  | 'orchestrate'
  | 'boards'
  | 'map';

/** Hash path segments that map 1:1 onto {@link CodeSectionId}. */
export const CODE_SECTION_IDS: readonly CodeSectionId[] = [
  'overview',
  'chat',
  'dev-server',
  'super-plan',
  'orchestrate',
  'boards',
  'map',
];

/** Parsed hash route consumed by the OS shell and page bridge. */
export interface OsRoute {
  view: OsView;
  appId?: AppId;
  settingsSection?: string;
  modelsSection?: string;
  brainSection?: string;
  codeSection?: CodeSectionId;
  /** Issues deep link (`#/app/issues/ISS-n`) — detail panel in Phase 2. */
  issueId?: string;
}
