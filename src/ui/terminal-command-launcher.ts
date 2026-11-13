import type { ShellProfile } from '../api/terminal-pty';

/** Open a fresh interactive terminal for a command the user selected in the UI. */
export async function runCommandInNewTerminal(
  buildCommand: (profile?: ShellProfile) => string,
  { shellProfileId, privateHistory }: { shellProfileId?: string; privateHistory?: boolean } = {},
): Promise<void> {
  const [{ launchApp }, terminalPanel, terminalTabs, terminalXterm] = await Promise.all([
    import('../os/router'),
    import('./terminal-panel'),
    import('./terminal-tabs'),
    import('./terminal-xterm'),
  ]);

  launchApp('code', { codeSection: 'chat' });
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  terminalPanel.openTerminalPanel();

  for (let attempt = 0; attempt < 50 && !terminalTabs.isTerminalTabsInitialized(); attempt += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  if (!terminalTabs.isTerminalTabsInitialized()) {
    throw new Error('Minnow terminal is not available.');
  }

  const tabId = await terminalTabs.addTab(shellProfileId, { privateHistory });
  await terminalXterm.waitForTerminalInputReady(tabId);
  const profile = terminalTabs.getTerminalTabShellProfile(tabId);
  if (shellProfileId && profile?.id !== shellProfileId) {
    throw new Error('The workspace shell changed. Check the connection again.');
  }
  terminalXterm.insertTextAtTerminalInput(`${buildCommand(profile)}\r`);
}
