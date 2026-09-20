import '../styles/settings-plugin-packages.css';
import { appConfirm } from './app-dialog';
import { linkToRepositoryDoc } from './settings-layout';
import { refreshPluginToolCache } from '../tools/client';
import { refreshSkillCatalog } from '../skills/client';
import { getToolPermissionForId, loadToolConfig, setToolPermission } from '../tools/config';
import { mountPluginPanel, type PluginPanelContent } from '../plugins/panel';

interface ConnectionField { id: string; label: string; secret: boolean; required: boolean }
interface PluginPackage {
  id: string; name: string; description: string; version: string; enabled: boolean; source: string;
  tools: { id: string; description: string }[];
  panels: { id: string; title: string }[];
  skills: { id: string }[];
  connections: { id: string; label: string; fields: ConnectionField[] }[];
}
interface Catalog { revision: number; packages: PluginPackage[] }
type Connections = Record<string, Record<string, { configured: boolean; value?: string }>>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api<T>(suffix = '', body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/plugins/packages${suffix}`, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Plugin request failed (${response.status})`);
  return data as T;
}

export async function renderPluginPackagesSection(mount: HTMLElement): Promise<void> {
  const shell = el('div', undefined, 'plugin-settings');
  shell.dataset.settingsSearchKey = 'plugins.installed';
  mount.replaceChildren(shell);
  const header = el('div', undefined, 'plugin-settings__header');
  const heading = el('div');
  heading.append(el('p', 'Add tools, connections, skills and custom panels. Ask Minnow to build one with /build-plugin.'));
  header.append(heading, linkToRepositoryDoc('Authoring guide', 'documentation/manual/plugins.md'));
  shell.append(header);
  const status = el('p', 'Loading plugins…', 'plugin-settings__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const add = el('form', undefined, 'plugin-settings__add');
  add.dataset.settingsSearchKey = 'plugins.add';
  const label = el('label', 'Plugin folder in this workspace');
  const input = el('input');
  input.placeholder = 'plugins/my-plugin';
  input.required = true;
  label.append(input);
  const review = el('button', 'Review plugin', 'settings-action-btn');
  review.type = 'submit';
  const preview = el('div', undefined, 'plugin-settings__preview');
  add.append(label, review);
  const list = el('div', undefined, 'plugin-settings__list');
  const panelHost = el('section', undefined, 'plugin-settings__panel');
  panelHost.hidden = true;
  shell.append(add, preview, status, list, panelHost);
  let revision = -1;
  let installedIds = new Set<string>();
  let busy = false;
  let disposePanel: (() => void) | undefined;
  const alive = () => mount.firstChild === shell;
  const closePanel = () => { disposePanel?.(); disposePanel = undefined; panelHost.replaceChildren(); panelHost.hidden = true; };

  async function action(button: HTMLButtonElement, work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = 'Working…';
    try { await work(); } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { busy = false; button.disabled = false; }
  }

  function button(text: string, work: (button: HTMLButtonElement) => Promise<void>) {
    const node = el('button', text, 'settings-action-btn');
    node.type = 'button';
    node.addEventListener('click', () => void action(node, () => work(node)));
    return node;
  }

  async function mutate(args: object) {
    await api('/manage', args);
    await Promise.all([refreshPluginToolCache(), refreshSkillCatalog()]);
    closePanel();
    await refresh(true);
  }

  async function showConnections(plugin: PluginPackage, target: HTMLElement) {
    const configured = await api<Connections>(`/${plugin.id}/connections`);
    if (!alive()) return;
    target.replaceChildren();
    const form = el('form', undefined, 'plugin-settings__connections');
    const values = new Map<HTMLInputElement, [string, string]>();
    for (const connection of plugin.connections) {
      const group = el('fieldset');
      group.append(el('legend', connection.label));
      for (const field of connection.fields) {
        const fieldLabel = el('label', `${field.label}${field.required ? ' (required)' : ''}`);
        const fieldInput = el('input');
        fieldInput.type = field.secret ? 'password' : 'text';
        fieldInput.autocomplete = 'off';
        const saved = configured[connection.id]?.[field.id];
        fieldInput.value = saved?.value ?? '';
        fieldInput.placeholder = saved?.configured ? 'Saved. Leave blank to keep.' : 'Not configured';
        fieldInput.required = field.required && !saved?.configured;
        fieldLabel.append(fieldInput);
        group.append(fieldLabel);
        values.set(fieldInput, [connection.id, field.id]);
      }
      form.append(group);
    }
    const save = el('button', 'Save connections', 'settings-action-btn');
    save.type = 'submit';
    form.append(save, button('Disconnect all', async () => {
      const connections = Object.fromEntries(plugin.connections.map(c => [c.id, Object.fromEntries(c.fields.map(f => [f.id, '']))]));
      await api(`/${plugin.id}/connections`, { connections }, 'PUT');
      await showConnections(plugin, target);
      status.textContent = 'Connections cleared.';
    }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      void action(save, async () => {
        const connections: Record<string, Record<string, string>> = {};
        for (const [fieldInput, [connectionId, fieldId]] of values) {
          if (!fieldInput.value) continue;
          (connections[connectionId] ??= {})[fieldId] = fieldInput.value;
        }
        await api(`/${plugin.id}/connections`, { connections }, 'PUT');
        await showConnections(plugin, target);
        status.textContent = 'Connections saved.';
      });
    });
    target.append(form);
    status.textContent = 'Secret values stay encrypted on this computer.';
  }

  async function refresh(force = false) {
    const catalog = await api<Catalog>();
    if (!alive() || (!force && revision === catalog.revision)) return;
    revision = catalog.revision;
    await Promise.all([refreshPluginToolCache(), refreshSkillCatalog()]);
    if (!alive()) return;
    installedIds = new Set(catalog.packages.map(p => p.id));
    closePanel();
    list.replaceChildren();
    for (const plugin of catalog.packages) {
      const row = el('article', undefined, 'plugin-settings__row');
      const meta = el('div');
      const count = (n: number, label: string) => `${n} ${label}${n === 1 ? '' : 's'}`;
      meta.append(el('h3', plugin.name), el('p', plugin.description), el('p', `${plugin.version} · ${plugin.enabled ? 'Enabled' : 'Disabled'} · ${count(plugin.tools.length, 'tool')} · ${count(plugin.panels.length, 'panel')} · ${count(plugin.skills.length, 'skill')}`, 'plugin-settings__meta'));
      const controls = el('div', undefined, 'plugin-settings__actions');
      controls.append(
        button(plugin.enabled ? 'Disable' : 'Enable', async () => { await mutate({ action: plugin.enabled ? 'disable' : 'enable', id: plugin.id }); }),
        button('Reload from source', async () => { await mutate({ action: 'reload', id: plugin.id }); }),
        button('Remove', async () => {
          if (await appConfirm(`Remove ${plugin.name}? Its tools, skills, panels and saved connections will be removed. Plugin data is kept.`, { title: 'Remove plugin' })) await mutate({ action: 'remove', id: plugin.id });
          else status.textContent = '';
        }),
      );
      row.append(meta, controls);
      const details = el('details');
      details.append(el('summary', 'Tools, panels and connections'), el('p', `Source: ${plugin.source}`, 'plugin-settings__source'));
      for (const tool of plugin.tools) {
        const toolLabel = el('label', tool.id, 'plugin-settings__tool');
        toolLabel.title = tool.description;
        const permission = el('select');
        permission.setAttribute('aria-label', `${plugin.name}: ${tool.id} permission`);
        const name = `plugin__${plugin.id.replace(/-/g, '_')}__${tool.id}`;
        for (const [value, text] of [['ask', 'Ask each time'], ['full', 'Full permission'], ['off', 'Off']]) {
          const option = el('option', text); option.value = value; permission.append(option);
        }
        permission.value = getToolPermissionForId(loadToolConfig(), name);
        permission.addEventListener('change', () => {
          setToolPermission(name, permission.value as 'ask' | 'full' | 'off');
          status.textContent = `${tool.id}: ${permission.selectedOptions[0].textContent}`;
        });
        toolLabel.append(permission); details.append(toolLabel);
      }
      for (const panel of plugin.panels) {
        const open = button(`Open ${panel.title}`, async () => {
          const content = await api<PluginPanelContent>(`/${plugin.id}/panels/${panel.id}`);
          closePanel(); panelHost.hidden = false;
          const toolbar = el('div', undefined, 'plugin-settings__actions');
          toolbar.append(el('h3', `${plugin.name} / ${panel.title}`), button('Close panel', async () => closePanel()));
          const target = el('div'); target.dataset.panelId = panel.id;
          panelHost.append(toolbar, target);
          disposePanel = mountPluginPanel(target, plugin.id, content);
          panelHost.scrollIntoView({ block: 'nearest' });
          status.textContent = '';
        });
        open.disabled = !plugin.enabled;
        details.append(open);
      }
      const connectionHost = el('div');
      if (plugin.connections.length) details.append(button('Configure connections', async () => showConnections(plugin, connectionHost)), connectionHost);
      row.append(details); list.append(row);
    }
    status.textContent = catalog.packages.length ? `${catalog.packages.length} installed plugin${catalog.packages.length === 1 ? '' : 's'}.` : 'No plugins installed. Review a plugin folder above, or ask Minnow to create one with /build-plugin.';
  }

  add.addEventListener('submit', event => {
    event.preventDefault();
    void action(review, async () => {
      preview.replaceChildren();
      const source = input.value.trim();
      const result = await api<{ manifest: PluginPackage; trust: string; digest: string }>('/inspect', { path: source });
      const p = result.manifest;
      preview.append(el('h3', `${p.name} ${p.version}`), el('p', p.description), el('p', `${p.tools.length} tools · ${p.panels.length} panels · ${p.connections.length} connections · ${p.skills.length} skills`), el('p', result.trust));
      const updating = installedIds.has(p.id);
      preview.append(button(updating ? 'Trust and update' : 'Trust and install', async () => {
        await mutate({ action: updating ? 'update' : 'install', id: p.id, path: source, digest: result.digest });
        preview.replaceChildren(); input.value = '';
      }));
      status.textContent = 'Package validated. Review the source before installing.';
    });
  });
  input.addEventListener('input', () => preview.replaceChildren());
  try { await refresh(); } catch (error) { status.textContent = `Cannot load plugins. ${error instanceof Error ? error.message : String(error)}`; }
  const timer = window.setInterval(() => {
    if (!alive() || !mount.isConnected) { window.clearInterval(timer); closePanel(); return; }
    if (disposePanel && typeof shell.checkVisibility === 'function' && !shell.checkVisibility()) closePanel();
    if (!busy) void refresh().catch(() => { status.textContent = 'Cannot refresh plugins. Check the local server and retry.'; });
  }, 3000);
}
