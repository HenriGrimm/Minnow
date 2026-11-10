import '../styles/settings-plugin-packages.css';
import { appConfirm } from './app-dialog';
import { linkToRepositoryDoc } from './settings-layout';
import { refreshPluginToolCache } from '../tools/client';
import { refreshSkillCatalog } from '../skills/client';
import { invalidateToolConfigCache, loadToolConfigFromStorage } from '../tools/config';
import { mountPluginPanel, type PluginPanelContent } from '../plugins/panel';
import { refreshPluginUi, pluginUiError } from '../plugins/ui-runtime';
import { createPollingTask } from '../lib/polling-task';
import { createIcon } from './icon';
import { createSettingsSwitch } from './settings-switch';

interface ConnectionField { id: string; label: string; secret: boolean; required: boolean }
interface PluginPackage {
  id: string; name: string; description: string; version: string; enabled: boolean; source: string;
  tools: { id: string; description: string }[];
  panels: { id: string; title: string }[];
  skills: { id: string }[];
  connections: { id: string; label: string; fields: ConnectionField[] }[];
  ui?: { entry: string };
}
interface Catalog { revision: number; packages: PluginPackage[] }
type Connections = Record<string, Record<string, { configured: boolean; value?: string }>>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api<T>(suffix = '', body?: unknown, method = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/plugins/packages${suffix}`, body === undefined ? { signal } : {
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
  const build = el('button', undefined, 'settings-action-btn settings-action-btn--primary');
  build.type = 'button';
  build.title = 'Open a new thread with /build-plugin';
  build.append(createIcon('sparkles', { size: 14 }), 'Build a plugin');
  header.append(linkToRepositoryDoc('Authoring guide', 'documentation/manual/plugins.md'), build);
  const status = el('p', 'Loading plugins…', 'plugin-settings__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const add = el('form', undefined, 'plugin-settings__add');
  add.dataset.settingsSearchKey = 'plugins.add';
  const label = el('label', 'GitHub URL or plugin folder');
  const input = el('input');
  input.placeholder = 'https://github.com/owner/plugin or a folder path';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-describedby', 'plugin-source-hint');
  input.required = true;
  label.append(input);
  const review = el('button', 'Review plugin', 'settings-action-btn');
  review.type = 'submit';
  const choose = el('button', 'Choose folder', 'settings-action-btn');
  choose.type = 'button';
  const hint = el('p', 'Use a public GitHub repository or a folder containing plugin.json. GitHub folder links work too.', 'plugin-settings__meta');
  hint.id = 'plugin-source-hint';
  const preview = el('div', undefined, 'plugin-settings__preview');
  add.append(label, review, choose);
  const list = el('div', undefined, 'plugin-settings__list');
  const panelHost = el('section', undefined, 'plugin-settings__panel');
  panelHost.hidden = true;
  shell.append(header, add, hint, preview, status, list, panelHost);
  let revision = -1;
  let installedIds = new Set<string>();
  let busy = false;
  let refreshing: Promise<void> | undefined;
  let disposePanel: (() => void) | undefined;
  const alive = () => mount.firstChild === shell;
  const closePanel = () => { disposePanel?.(); disposePanel = undefined; panelHost.replaceChildren(); panelHost.hidden = true; };

  async function action(button: HTMLButtonElement | HTMLInputElement, work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    input.disabled = review.disabled = choose.disabled = true;
    add.setAttribute('aria-busy', 'true');
    status.textContent = 'Working…';
    try { await work(); } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      busy = false;
      button.disabled = false;
      input.disabled = review.disabled = choose.disabled = false;
      add.removeAttribute('aria-busy');
    }
  }

  build.addEventListener('click', () => void action(build, async () => {
    const [sidebar, router, sessions, draft, composer] = await Promise.all([
      import('./sidebar'), import('../os/router'), import('../state/sessions'), import('./composer-draft'), import('./composer-surface'),
    ]);
    const result = await sidebar.createChatWithMode({ modeId: 'general' });
    const chat = result.ok && result.chatId ? sessions.findChatById(result.chatId) : undefined;
    if (!chat) throw new Error(result.error || 'Could not create a plugin thread');
    draft.persistComposerDraftOnChat(chat, '/build-plugin');
    sessions.scheduleSaveSessions({ chatId: chat.id });
    status.textContent = '';
    router.launchApp('code', { codeSection: 'chat' });
    draft.applyComposerDraftForChat(chat);
    const input = composer.getActiveComposerSurface().inputEl;
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(() => input?.focus());
  }));

  function button(text: string, work: (button: HTMLButtonElement) => Promise<void>) {
    const node = el('button', text, 'settings-action-btn');
    node.type = 'button';
    node.addEventListener('click', () => void action(node, () => work(node)));
    return node;
  }

  async function mutate(args: object) {
    await api('/manage', args);
    if ('action' in args && (args.action === 'install' || args.action === 'remove')) {
      invalidateToolConfigCache();
      await loadToolConfigFromStorage();
    }
    await Promise.all([refreshPluginToolCache(true), refreshSkillCatalog(), refreshPluginUi()]);
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

  async function refresh(force = false, signal?: AbortSignal): Promise<void> {
    if (refreshing) {
      try { await refreshing; } catch { /* A mutation still needs a fresh catalog. */ }
      if (!force || signal?.aborted || !alive()) return;
    }
    const pending = refreshCatalog(force, signal);
    refreshing = pending;
    try { await pending; } finally { if (refreshing === pending) refreshing = undefined; }
  }
  async function refreshCatalog(force: boolean, signal?: AbortSignal) {
    const catalog = await api<Catalog>('', undefined, 'GET', signal);
    if (signal?.aborted || !alive() || (!force && revision === catalog.revision)) return;
    revision = catalog.revision;
    await Promise.all([refreshPluginToolCache(force), refreshSkillCatalog()]);
    if (signal?.aborted || !alive()) return;
    installedIds = new Set(catalog.packages.map(p => p.id));
    closePanel();
    list.replaceChildren();
    for (const plugin of catalog.packages) {
      const row = el('article', undefined, 'plugin-settings__row');
      const main = el('div', undefined, 'plugin-settings__row-main');
      const icon = el('span', undefined, 'plugin-settings__row-icon');
      icon.appendChild(createIcon('tools', { size: 16 }));
      const meta = el('div', undefined, 'plugin-settings__row-meta');
      const count = (n: number, label: string) => `${n} ${label}${n === 1 ? '' : 's'}`;
      meta.append(el('h3', plugin.name), el('p', plugin.description), el('p', `${count(plugin.tools.length, 'tool')} · ${count(plugin.panels.length, 'panel')} · ${count(plugin.skills.length, 'skill')}`, 'plugin-settings__meta'));
      if (plugin.ui) meta.append(el('p', 'UI extension: apps, menus and DOM access', 'plugin-settings__meta'));
      const uiError = pluginUiError(plugin.id);
      if (uiError) meta.append(el('p', `UI failed: ${uiError}. Fix the source and reload.`, 'plugin-settings__status'));
      const { root: enabled, input: enabledInput } = createSettingsSwitch({
        checked: plugin.enabled,
        ariaLabel: `Enable ${plugin.name}`,
      });
      enabledInput.addEventListener('change', () => {
        const checked = enabledInput.checked;
        const restoreFocus = document.activeElement === enabledInput;
        enabledInput.checked = plugin.enabled;
        void action(enabledInput, async () => {
          await mutate({ action: checked ? 'enable' : 'disable', id: plugin.id });
          if (restoreFocus && document.activeElement === document.body) {
            [...list.querySelectorAll<HTMLInputElement>('[role="switch"]')]
              .find(input => input.dataset.pluginId === plugin.id)?.focus();
          }
        });
      });
      enabledInput.dataset.pluginId = plugin.id;
      main.append(icon, meta, el('code', plugin.version, 'plugin-settings__row-version'), enabled);
      const controls = el('div', undefined, 'plugin-settings__actions');
      controls.append(
        button('Reload from source', async () => { await mutate({ action: 'reload', id: plugin.id }); }),
        button('Remove', async () => {
          if (await appConfirm(`Remove ${plugin.name}? Its tools, skills, panels and saved connections will be removed. Plugin data is kept.`, { title: 'Remove plugin' })) await mutate({ action: 'remove', id: plugin.id });
          else status.textContent = '';
        }),
      );
      row.append(main);
      const details = el('details');
      details.append(el('summary', 'Configure'), el('p', `Source: ${plugin.source}`, 'plugin-settings__source'), controls);
      for (const tool of plugin.tools) {
        const toolLabel = el('p', tool.id, 'plugin-settings__tool');
        toolLabel.title = tool.description;
        details.append(toolLabel);
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
    status.textContent = catalog.packages.length ? `${catalog.packages.length} installed plugin${catalog.packages.length === 1 ? '' : 's'}.` : 'No plugins installed. Paste a GitHub URL or choose a plugin folder above.';
  }

  add.addEventListener('submit', event => {
    event.preventDefault();
    void action(review, async () => {
      preview.replaceChildren();
      const source = input.value.trim();
      if (!source) throw new Error('Enter a GitHub URL or choose a plugin folder.');
      status.textContent = /^https?:\/\//i.test(source) ? 'Downloading and reviewing plugin…' : 'Reviewing plugin…';
      const result = await api<{ manifest: PluginPackage; trust: string; digest: string; source: string; commit?: string }>('/inspect', { source });
      if (!alive() || input.value.trim() !== source) return;
      const p = result.manifest;
      preview.append(el('h3', `${p.name} ${p.version}`), el('p', p.description), el('p', `${p.tools.length} tools · ${p.panels.length} panels · ${p.connections.length} connections · ${p.skills.length} skills`), el('p', result.trust));
      preview.append(el('p', `Source: ${result.source}${result.commit ? ` · Commit ${result.commit.slice(0, 7)}` : ''}`, 'plugin-settings__source'));
      if (p.ui) preview.append(el('p', `Trusted UI entry: ${p.ui.entry}. This code can change Minnow’s document, add apps and menus, and use authenticated APIs.`));
      const updating = installedIds.has(p.id);
      preview.append(button(updating ? 'Trust and update' : 'Trust and install', async () => {
        await mutate({ action: updating ? 'update' : 'install', id: p.id, source: result.source, commit: result.commit, digest: result.digest });
        preview.replaceChildren(); input.value = '';
      }));
      status.textContent = 'Package validated. Review its capabilities, then select Trust and install or update.';
    });
  });
  input.addEventListener('input', () => preview.replaceChildren());
  choose.addEventListener('click', () => void action(choose, async () => {
    const { openWorkspaceFolderPicker } = await import('./workspace-folder-picker');
    const picked = await openWorkspaceFolderPicker({
      initialPath: /^https?:\/\//i.test(input.value.trim()) ? '' : input.value.trim(),
      title: 'Choose plugin folder', confirmVerb: 'Choose',
    });
    if (!alive()) return;
    if (!picked.cancelled && picked.path) {
      input.value = picked.path;
      preview.replaceChildren();
      status.textContent = 'Folder selected. Select Review plugin to continue.';
    } else status.textContent = '';
  }));
  const polling = createPollingTask(signal => refresh(false, signal));
  try { await polling.run(); } catch (error) { status.textContent = `Cannot load plugins. ${error instanceof Error ? error.message : String(error)}`; }
  const timer = window.setInterval(() => {
    if (!alive() || !mount.isConnected) { polling.cancel(); window.clearInterval(timer); closePanel(); return; }
    if (disposePanel && typeof shell.checkVisibility === 'function' && !shell.checkVisibility()) closePanel();
    if (!busy && !document.hidden) void polling.run().catch(() => { if (alive()) status.textContent = 'Cannot refresh plugins. Check the local server and retry.'; });
  }, 3000);
}
