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

/** Render the shared permission level in the workbench. */
export async function renderPermissionSettings(
  mount: HTMLElement,
  options: { searchKey?: string; showRules?: boolean } = {},
): Promise<void> {
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
  section.dataset.settingsSearchKey = options.searchKey ?? 'general.permissions';

  const current: PermissionLevel = (await loadToolSecurityMeta()).permissionLevel;
  const list = buildPermissionLevelList(current, (level) => {
    void choosePermissionLevel(level);
  });
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Permission level');
  const items = [...list.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
  for (const item of items) item.setAttribute('role', 'radio');

  const syncSelection = (level: PermissionLevel): void => {
    for (const item of items) {
      const checked = item.dataset.level === level;
      item.setAttribute('aria-checked', String(checked));
      item.tabIndex = checked ? 0 : -1;
    }
  };
  syncSelection(current);
  list.addEventListener('keydown', (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const offset = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
    if (!offset) return;
    event.preventDefault();
    const next = items[(index + offset + items.length) % items.length];
    next.focus();
    next.click();
  });
  section.appendChild(list);

  if (options.showRules !== false) {
    const rules = document.createElement('ul');
    rules.className = 'settings-permissions__rules';
    for (const text of RULES) {
      const li = document.createElement('li');
      li.textContent = text;
      rules.appendChild(li);
    }
    section.appendChild(rules);
  }
  mount.appendChild(section);

  const off = onToolSecurityMetaChange((meta) => {
    if (!section.isConnected) {
      off();
      return;
    }
    syncSelection(meta.permissionLevel);
  });
}

/** @deprecated Kept for older imports; renders the Permissions section. */
export const renderFilesystemAccessSettings = renderPermissionSettings;
