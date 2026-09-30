import { isAppAvailable, listAvailableApps } from '../os/app-preferences';
import { getForegroundAppId } from '../os/instances';
import { isOsShellEnabled } from '../os/page-bridge';
import type { AppId } from '../os/types';
import { MODELS_SECTIONS, MODELS_SECTION_LABELS } from './models-section-ids';
import { fieldsForArea, SETTINGS_SECTIONS, SETTINGS_SECTION_LABELS } from './settings-page-types';
import { registerCommandSource, type Command } from './command-registry';
import { showShellKeyboardHelp } from './shell-keyboard-help';

/** Apps that know better than `launchApp` how to open themselves. */
const APP_LAUNCH_OVERRIDES: Partial<Record<AppId, () => void>> = {
  issues: () => {
    void import('./issues-page').then((m) => m.openIssuesFromSidebar());
  },
};

/** "Go to Code", "Go to Issues", … for every app the user has enabled. */
function appCommands(): Command[] {
  if (!isOsShellEnabled()) return [];
  return listAvailableApps().map((app) => ({
    id: `app.${app.id}`,
    title: `Go to ${app.name}`,
    group: 'Apps',
    keywords: `${app.name} ${app.id} open switch`,
    run: () => {
      const override = APP_LAUNCH_OVERRIDES[app.id];
      if (override) {
        override();
        return;
      }
      void import('../os/router').then((m) => m.launchApp(app.id));
    },
  }));
}

/** Use the shipped navigation catalogs so retired settings never become commands. */
export function destinationCommands(): Command[] {
  if (!isOsShellEnabled()) return [];
  return [
    ...SETTINGS_SECTIONS.map((section): Command => ({
      id: `settings.${section}`,
      title: `Open ${SETTINGS_SECTION_LABELS[section]} settings`,
      group: 'Settings',
      keywords: [section, 'configure preferences', ...fieldsForArea(section).flatMap((field) => [field.label, ...(field.keywords ?? [])])].join(' '),
      available: () => isAppAvailable('settings'),
      run: async () => (await import('./settings-page')).openSettings(section),
    })),
    ...MODELS_SECTIONS.map((section): Command => ({
      id: `models.${section}`,
      title: `Open ${MODELS_SECTION_LABELS[section]}`,
      group: 'Models',
      keywords: `${section} model provider inference`,
      available: () => isAppAvailable('models'),
      run: async () => (await import('../os/router')).launchApp('models', { modelsSection: section }),
    })),
    {
      id: 'workspace.switch',
      title: 'Switch project',
      group: 'Workspace',
      keywords: 'workspace folder open recent',
      run: async () => (await import('../os/router')).navigateToWorkspaces(),
    },
    {
      id: 'issues.projects',
      title: 'Browse issue projects',
      group: 'Workspace',
      keywords: 'issues projects manage archive',
      available: () => isAppAvailable('issues'),
      run: () => { window.location.hash = '#/app/issues/projects'; },
    },
    ...([
      ['boards', 'Open boards', 'orchestrate agents plan'],
      ['dev-server', 'Open dev servers', 'start stop development preview'],
      ['map', 'Open code map', 'brain repository symbols index'],
    ] as const).map(([section, title, keywords]): Command => ({
      id: `code.${section}`,
      title,
      group: 'Workspace',
      keywords,
      available: () => isAppAvailable('code'),
      run: async () => (await import('../os/router')).launchApp('code', { codeSection: section }),
    })),
  ];
}

/** Code controls act on the current workspace, never a hidden background pane. */
export function codeCommands(inCode = getForegroundAppId() === 'code'): Command[] {
  if (!inCode) return [];
  return [
    ...(['general', 'build', 'plan', 'debug'] as const).map((modeId): Command => ({
      id: `chat.new.${modeId}`,
      title: `New ${modeId[0].toUpperCase()}${modeId.slice(1)} chat`,
      group: 'Chat',
      keywords: `${modeId} conversation create session`,
      run: async () => {
        (await import('./sidebar')).createChatWithMode({ modeId, forceNewChat: true });
      },
    })),
    {
      id: 'chat.search', title: 'Search chats', group: 'Chat', keywords: 'find history conversation messages',
      available: () => Boolean(document.getElementById('btnChatSearch')),
      run: async () => {
        const anchor = document.getElementById('btnChatSearch');
        if (anchor) (await import('./chat-search-popover')).openChatSearchPopover(anchor);
      },
    },
    {
      id: 'code.sidebar', title: 'Toggle chat sidebar', group: 'Code', keywords: 'sessions layout collapse',
      run: async () => (await import('./layout')).toggleSidebarLayout(),
    },
    {
      id: 'code.files', title: 'Toggle files pane', group: 'Code', keywords: 'explorer tree sidebar layout',
      run: async () => (await import('./file-layout')).toggleFileSidebarLayout(),
    },
    {
      id: 'code.terminal', title: 'Toggle terminal', group: 'Code', keywords: 'shell command console', shortcut: 'Ctrl+`',
      run: async () => (await import('./terminal-panel')).toggleTerminalPanel(),
    },
    {
      id: 'code.preview', title: 'Toggle preview', group: 'Code', keywords: 'browser website panel',
      run: async () => (await import('./preview-panel')).togglePreviewPanel(),
    },
    {
      id: 'code.save', title: 'Save current file', group: 'Code', keywords: 'editor write document',
      available: () => Boolean(document.querySelector('.cm-editor')),
      run: async () => { await (await import('./file-viewer')).saveFocusedViewerTab(); },
    },
  ];
}

function shellCommands(): Command[] {
  return [
    {
      id: 'shell.capture-issue',
      title: 'New issue from here',
      group: 'Shell',
      keywords: 'issue capture file bug report quick',
      shortcut: 'Ctrl/Cmd+I',
      run: () => {
        void import('./issue-capture').then((m) => m.openQuickCapture());
      },
    },
    {
      id: 'shell.keyboard-help',
      title: 'Keyboard shortcuts',
      group: 'Shell',
      keywords: 'keys bindings help cheat sheet',
      shortcut: '?',
      run: () => showShellKeyboardHelp(),
    },
  ];
}

let registered = false;

/** Register the shell's own command sources. Safe to call on every boot. */
export function initShellCommands(): void {
  if (registered) return;
  registered = true;
  registerCommandSource('shell.apps', appCommands, { order: 10 });
  registerCommandSource('shell.code', codeCommands, { order: 15 });
  registerCommandSource('shell.destinations', destinationCommands, { order: 800 });
  registerCommandSource('shell', shellCommands, { order: 900 });
}

/** Reset module state (tests). */
export function resetShellCommandsForTests(): void {
  registered = false;
}
