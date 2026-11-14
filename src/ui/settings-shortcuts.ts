/**
 * Settings → General → Keyboard shortcuts: the same catalog the `?` overlay
 * shows, as a page you can find from search. Read-only — shortcuts are not
 * rebindable yet, and this page says so rather than implying otherwise.
 */

import { getVisibleKeyboardShortcuts, renderShortcutSections, showShellKeyboardHelp } from './shell-keyboard-help';
import { createButton } from './components/button';

/** Render the shortcut reference into its section body. */
export function renderShortcutSettings(mount: HTMLElement): void {
  mount.replaceChildren();
  const shell = document.createElement('div');
  shell.className = 'settings-general settings-shortcuts';
  shell.dataset.settingsSearchKey = 'general.shortcuts';

  const lead = document.createElement('p');
  lead.className = 'settings-section-lead';
  lead.textContent = 'Shortcuts can’t be changed yet. Press ? anywhere outside a text field to open this list as an overlay.';
  shell.append(lead);

  const open = createButton({ label: 'Open the overlay', variant: 'secondary', size: 'sm', onClick: () => showShellKeyboardHelp() });
  shell.append(open);

  const list = document.createElement('div');
  list.className = 'shell-keyboard-help settings-shortcuts__list';
  list.append(renderShortcutSections(getVisibleKeyboardShortcuts(), true));
  shell.append(list);
  mount.append(shell);
}
