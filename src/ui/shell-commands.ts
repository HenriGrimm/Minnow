import { isOsShellEnabled } from '../os/page-bridge';
import { registerCommandSource, type Command } from './command-registry';
import { buildShellNavigationCommands } from './shell-navigation-commands';
import { showShellKeyboardHelp } from './shell-keyboard-help';

/** App and section destinations, resolved lazily so the palette stays entry-light. */
function navigationCommands(): Command[] {
  if (!isOsShellEnabled()) return [];
  return buildShellNavigationCommands({
    launchApp: (appId, options) => {
      void import('../os/router').then((m) => m.launchApp(appId, options));
    },
  });
}

function shellCommands(): Command[] {
  return [
    {
      id: 'shell.switch-workspace',
      title: 'Switch workspace',
      group: 'Actions',
      keywords: 'open change project folder repository workspace',
      run: () => {
        void import('../os/workspace-gate').then((m) => m.openWorkspaceGate({ switch: true }));
      },
    },
    {
      id: 'shell.capture-issue',
      title: 'New issue from here',
      group: 'Actions',
      keywords: 'issue capture file bug report quick',
      shortcut: 'Ctrl/Cmd+I',
      run: () => {
        void import('./issue-capture').then((m) => m.openQuickCapture());
      },
    },
    {
      id: 'shell.new-brain-page',
      title: 'New Brain page',
      group: 'Actions',
      keywords: 'create wiki knowledge note memory document',
      run: () => {
        void import('../os/router').then((m) =>
          m.launchApp('brain', { brainSection: 'edit', brainEditPath: 'facts/' }),
        );
      },
    },
    {
      id: 'shell.new-scheduled-job',
      title: 'New scheduled job',
      group: 'Actions',
      keywords: 'create automation recurring cron interval scheduler reminder',
      run: async () => {
        const router = await import('../os/router');
        router.launchApp('scheduler');
        const scheduler = await import('./scheduler-page');
        await scheduler.openNewSchedulerJob();
      },
    },
    {
      id: 'shell.keyboard-help',
      title: 'Keyboard shortcuts',
      group: 'Help',
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
  registerCommandSource('shell.navigation', navigationCommands, { order: 10 });
  registerCommandSource('shell', shellCommands, { order: 900 });
}

/** Reset module state (tests). */
export function resetShellCommandsForTests(): void {
  registered = false;
}
