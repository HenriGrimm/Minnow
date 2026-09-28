import { listAvailableApps } from '../os/app-preferences';
import { isOsShellEnabled } from '../os/page-bridge';
import type { AppId } from '../os/types';
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
  registerCommandSource('shell', shellCommands, { order: 900 });
}

/** Reset module state (tests). */
export function resetShellCommandsForTests(): void {
  registered = false;
}
