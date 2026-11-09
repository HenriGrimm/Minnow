/**
 * Settings → Permissions: the one system-wide level (Manual / Auto / Full
 * access). Same level the composer pill and Shift+Tab change.
 *
 * (File keeps its historical name; it replaced the old "Filesystem access"
 * Workspace/Full-disk switch, which is now implied by the level.)
 */

import { detectConfigServer } from '../config/storage-mode';
import {
  loadToolSecurityMeta,
  onToolSecurityMetaChange,
} from '../config/tool-security-meta';
import type { PermissionLevel } from '../lib/permissions.mjs';
import { buildPermissionLevelList, choosePermissionLevel } from './permission-level';
import { appendSettingsOfflineHint } from './settings-controls';

const RULES = [
  'Reads inside your project never ask.',
  'Auto approves routine edits and commands, and asks before anything risky, remote, or outside the project.',
  '“Allow for this chat” remembers a command, folder, site, MCP server or plugin until the chat ends.',
  'Full access never asks. Agents still cannot touch Minnow’s encryption key or stored secrets.',
  '/ask and /plan narrow a single turn (read-only, or plan files only) whatever the level.',
];

/** Render the permission level controls into the Settings mount. */
export async function renderPermissionSettings(mount: HTMLElement): Promise<void> {
  const serverUp = await detectConfigServer();
  if (serverUp !== 'server') {
    appendSettingsOfflineHint(
      mount,
      'Permission settings are saved by the Minnow server. Open Minnow, then reopen Settings.',
    );
    return;
  }

  const section = document.createElement('section');
  section.className = 'settings-permissions';
  section.dataset.settingsSearchKey = 'general.permissions';

  let current: PermissionLevel = (await loadToolSecurityMeta()).permissionLevel;

  const render = (): void => {
    const list = buildPermissionLevelList(current, (level) => {
      void choosePermissionLevel(level);
    });
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Permission level');
    for (const item of list.querySelectorAll('[role="menuitemradio"]')) item.setAttribute('role', 'radio');
    section.querySelector('.permission-menu__list')?.remove();
    section.prepend(list);
  };

  const rules = document.createElement('ul');
  rules.className = 'settings-permissions__rules';
  for (const text of RULES) {
    const li = document.createElement('li');
    li.textContent = text;
    rules.appendChild(li);
  }
  section.appendChild(rules);
  render();
  mount.appendChild(section);

  const off = onToolSecurityMetaChange((meta) => {
    if (!section.isConnected) {
      off();
      return;
    }
    if (meta.permissionLevel === current) return;
    current = meta.permissionLevel;
    render();
  });
}

/** @deprecated Kept for older imports; renders the Permissions section. */
export const renderFilesystemAccessSettings = renderPermissionSettings;
