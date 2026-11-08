import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Settings → Tools: native plugin packs (Feature #17).
 */

import {
  loadToolConfig,
  setToolPermission,
} from '../tools/config';
import type { PluginListItem } from '../tools/plugin-settings-types';
import { linkToRepositoryDoc } from './settings-layout';
import { bindToolsListChange, createDynamicToolGroup } from './tools-list';

/** Fetch plugin metadata for settings rows. */
export async function fetchPluginList(): Promise<PluginListItem[]> {
  try {
    const response = await fetch('/api/plugins');
    if (!response.ok) return [];
    const body = (await response.json()) as { plugins?: PluginListItem[] };
    return Array.isArray(body.plugins) ? body.plugins : [];
  } catch {
    return [];
  }
}

/**
 * Append plugin tool rows to a tools list container (Custom badge + permission select).
 */
export async function appendPluginToolsToList(
  listId: string,
): Promise<void> {
  const container = document.getElementById(listId);
  if (!container) return;

  const plugins = await fetchPluginList();
  const existing = container.querySelector('[data-tool-category="plugins"]');
  if (existing) existing.remove();

  if (plugins.length === 0) return;

  const isSettingsList = container.classList.contains('tools-list--settings');
  const bodyNodes: HTMLElement[] = [];

  const hint = document.createElement('p');
  hint.className = 'tool-group-hint';
  const toolsPath = document.createElement('code');
  toolsPath.textContent = '~/.minnow/tools/<id>/';
  hint.append(
    'Drop-in tools under ',
    toolsPath,
    '. See ',
    linkToRepositoryDoc('tool authoring', 'documentation/plugins/tool-authoring.md'),
    '.',
  );
  bodyNodes.push(hint);

  const scaffoldRow = document.createElement('div');
  scaffoldRow.className = 'settings-plugin-scaffold-row';
  const scaffoldBtn = document.createElement('button');
  scaffoldBtn.type = 'button';
  scaffoldBtn.className = 'settings-action-btn';
  scaffoldBtn.textContent = 'Scaffold new plugin…';
  scaffoldBtn.addEventListener('click', () => {
    void scaffoldPluginFromPrompt(listId);
  });
  scaffoldRow.appendChild(scaffoldBtn);
  bodyNodes.push(scaffoldRow);

  const config = loadToolConfig();

  for (const plugin of plugins) {
    const row = document.createElement('div');
    row.className = 'tool-row tool-row--plugin';
    row.setAttribute('data-tool-id', plugin.namespacedName);
    row.setAttribute('data-server-required', '');

    const controlWrap = document.createElement('div');
    controlWrap.className = 'tool-permission-wrap';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-label';
    const badge = document.createElement('span');
    badge.className = 'tool-custom-badge';
    badge.textContent = 'Custom';
    nameSpan.append(plugin.label, document.createTextNode(' '), badge);

    const select = document.createElement('select');
    select.className = 'tool-permission-select';
    select.setAttribute('aria-label', `${plugin.label} availability`);
    for (const optDef of [
      { value: 'ask', label: 'On' },
      { value: 'off', label: 'Off' },
    ] as const) {
      const opt = document.createElement('option');
      opt.value = optDef.value;
      opt.textContent = optDef.label;
      select.appendChild(opt);
    }
    const mode = config.permissions.default[plugin.namespacedName];
    // The permission level decides prompts; a row only turns the tool on or off.
    select.value = mode === 'off' ? 'off' : 'ask';

    controlWrap.append(nameSpan, select);
    row.appendChild(controlWrap);

    const desc = document.createElement('p');
    desc.className = 'tool-desc';
    desc.textContent = `${plugin.description} (${plugin.namespacedName})`;
    row.appendChild(desc);

    bodyNodes.push(row);
  }

  container.appendChild(
    createDynamicToolGroup({
      category: 'plugins',
      title: 'Plugins',
      count: `${plugins.length} tool${plugins.length === 1 ? '' : 's'}`,
      searchKey: 'tools.category.plugins',
      collapsible: isSettingsList,
      bodyNodes,
    }),
  );
  bindToolsListChange(container);
}

async function scaffoldPluginFromPrompt(listId: string): Promise<void> {
  const id = await appPrompt(
    'Plugin id (lowercase letters, numbers, hyphens):',
    'my-plugin',
  );
  if (!id?.trim()) return;

  try {
    const response = await fetch('/api/plugins/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id.trim() }),
    });
    const body = (await response.json()) as { error?: string; path?: string };
    if (!response.ok) {
      await appAlert(body.error ?? `Scaffold failed (HTTP ${response.status})`);
      return;
    }
    await fetch('/api/plugins/reload', { method: 'POST' });
    const { refreshPluginToolCache } = await import('../tools/client');
    await refreshPluginToolCache(true);
    await appendPluginToolsToList(listId);
    const { loadToolConfigIntoDrawer } = await import('../tools/config');
    loadToolConfigIntoDrawer();
    await appAlert(`Plugin created at ${body.path ?? id.trim()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await appAlert(`Scaffold failed: ${message}`);
  }
}

/** Persist permission for a plugin namespaced tool id. */
export function setPluginToolPermission(
  namespacedName: string,
  mode: 'full' | 'ask' | 'off',
  root: ParentNode = document,
): void {
  setToolPermission(namespacedName, mode, root);
}
