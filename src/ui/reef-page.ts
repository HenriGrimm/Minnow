import '../styles/reef.css';
import { createIcon } from './icon';
import { appConfirm, appPrompt } from './app-dialog';
import { launchApp, getCurrentRoute } from '../os/router';
import { getForegroundAppId } from '../os/instances';
import { getActiveChat } from '../state/sessions';
import { listProviders } from '../providers/store';
import { fetchModelsForAllProviders } from '../providers/fetch-all-models';
import { encodeModelSelectKey, decodeModelSelectKey } from '../lib/model-select-key';
import { listReefApps, getReefApp, createReefApp, reefRequest, subscribeReef, exportReefApp } from '../reef/client';
import type { ReefApp, ReefRun } from '../reef/types';
import { mountReefChat } from './reef-chat';
import { bindPreviewInstanceToElement, setPreviewInstanceVisible } from './preview-instance-host';

const terminal = new Set(['ready', 'failed', 'cancelled', 'interrupted']);
let root: HTMLElement;
let currentId: string | undefined;
let generation = 0;
let disposeEvents = () => {};
let disposePreview = () => {};
let chat: ReturnType<typeof mountReefChat> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let activePreview = '';
let previewImageUrl = '';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function button(label: string, action: () => void | Promise<void>, primary = false) {
  const node = element('button', label, primary ? 'reef-primary' : ''); node.type = 'button';
  node.addEventListener('click', () => {
    node.disabled = true;
    void Promise.resolve().then(action).catch(error => showError(errorText(error))).finally(() => { node.disabled = false; });
  });
  return node;
}
function showError(text: string) {
  const status = root.querySelector<HTMLElement>('.reef-error');
  if (status) { status.textContent = text; status.hidden = false; }
}
function navigate(id?: string) { launchApp('reef', id ? { reefAppId: id } : undefined); }
function reset() {
  disposeEvents(); disposeEvents = () => {};
  disposePreview(); disposePreview = () => {};
  if (activePreview) void window.minnow?.preview?.instances.destroy(activePreview);
  activePreview = '';
  if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
  previewImageUrl = '';
  chat?.dispose(); chat = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  root.replaceChildren();
  const error = element('p', '', 'reef-error'); error.setAttribute('role', 'alert'); error.hidden = true; root.append(error);
}
export function initReefPage() {
  if (document.getElementById('reefView')) { root = document.getElementById('reefView')!; return; }
  root = element('section', '', 'mn-os-app-layer reef-page'); root.id = 'reefView'; root.dataset.osApp = 'reef';
  (document.getElementById('osAppsLayer') ?? document.body).append(root);
  window.addEventListener('hashchange', () => {
    if (getForegroundAppId() === 'reef') void openReef(getCurrentRoute().reefAppId);
  });
}
export function suspendReef() {
  generation++; disposeEvents(); disposePreview();
  if (activePreview) setPreviewInstanceVisible(activePreview, false);
  root?.classList.remove('is-open');
}
export async function openReef(id?: string) {
  initReefPage(); const stamp = ++generation; currentId = id; reset(); root.classList.add('is-open');
  const header = element('header', '', 'reef-header');
  const identity = element('div', '', 'reef-identity'); identity.append(createIcon('modeReef'), element('h1', 'Reef'));
  header.append(identity, button(id ? 'All apps' : 'New app', () => id ? navigate() : root.querySelector<HTMLTextAreaElement>('.reef-prompt')?.focus())); root.append(header);
  try { if (id) await showDetail(id, stamp); else await showLibrary(stamp); }
  catch (error) { if (stamp === generation) showError(errorText(error)); }
}

async function showLibrary(stamp: number) {
  const create = element('form', '', 'reef-create');
  create.append(element('h2', 'What little app do you need?'), element('p', 'Describe a calculator, converter, or another useful tool. Reef builds and checks it for you.'));
  const prompt = element('textarea', '', 'reef-prompt'); prompt.rows = 3; prompt.maxLength = 16000; prompt.required = true; prompt.placeholder = 'A calculator that splits a dinner bill, including tip…'; prompt.setAttribute('aria-label', 'Describe your app');
  const controls = element('div', '', 'reef-actions');
  const models = element('select'); models.setAttribute('aria-label', 'Build model');
  const globalModel = (document.getElementById('modelSelect') as HTMLSelectElement | null)?.value;
  const selected = (globalModel ? decodeModelSelectKey(globalModel) : null) ?? getActiveChat();
  const initial = element('option', selected.modelId || 'Choose a model'); initial.value = selected.modelId ? encodeModelSelectKey(selected.providerId ?? '', selected.modelId) : ''; models.append(initial);
  const submit = element('button', 'Build app', 'reef-primary'); submit.type = 'submit';
  controls.append(models, submit); create.append(prompt, controls); root.append(create);
  const loadController = new AbortController();
  void listProviders().then(async ({ providers }) => {
    const catalogs = await fetchModelsForAllProviders(providers.filter(p => p.enabled && p.apiKind !== 'agent-cli-v1'), loadController.signal);
    if (stamp !== generation) return;
    const seen = new Set([initial.value]);
    for (const catalog of catalogs) for (const model of catalog.models) {
      const value = encodeModelSelectKey(catalog.provider.id, model.id); if (seen.has(value)) continue; seen.add(value);
      const option = element('option', `${catalog.provider.label} · ${model.id}`); option.value = value; models.append(option);
    }
  }).catch(() => {});
  create.addEventListener('submit', event => {
    event.preventDefault(); if (!prompt.value.trim() || submit.disabled) return;
    submit.disabled = true; submit.textContent = 'Checking prerequisites…';
    const binding = decodeModelSelectKey(models.value) ?? { modelId: models.value };
    void createReefApp({ prompt: prompt.value, ...binding }).then(app => navigate(app.id)).catch(error => showError(errorText(error))).finally(() => { submit.disabled = false; submit.textContent = 'Build app'; });
  });
  const heading = element('div', '', 'reef-library-heading'); heading.append(element('h2', 'Your apps'));
  const search = element('input'); search.type = 'search'; search.placeholder = 'Find an app'; search.setAttribute('aria-label', 'Search apps'); heading.append(search);
  const shelf = element('div', '', 'reef-library'); root.append(heading, shelf);
  let apps = await listReefApps(); if (stamp !== generation) return;
  const paint = () => {
    shelf.replaceChildren();
    const query = search.value.toLowerCase();
    const filtered = apps.filter(app => `${app.name} ${app.description}`.toLowerCase().includes(query));
    if (!filtered.length) shelf.append(element('p', apps.length ? 'No apps match your search.' : 'Your first app starts with the prompt above.', 'reef-empty'));
    for (const app of filtered) {
      const row = element('article', '', 'reef-app');
      const icon = element('div', app.name.slice(0, 1).toUpperCase(), 'reef-app-icon'); icon.setAttribute('aria-hidden', 'true');
      const info = element('div', '', 'reef-app-info');
      const title = button(app.name, () => navigate(app.id)); title.classList.add('reef-app-name');
      info.append(title, element('p', app.description), element('span', app.status, 'reef-status'));
      const actions = element('div', '', 'reef-actions');
      actions.append(button(app.release ? 'Open app' : 'View build', () => navigate(app.id)), button('Chat', () => navigate(app.id)));
      row.append(icon, info, actions); shelf.append(row);
    }
  };
  search.addEventListener('input', paint); paint();
  let refreshing = false;
  const subscriptions = apps.filter(app => !terminal.has(app.status)).map(app => subscribeReef(app.id, () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (refreshing || stamp !== generation) return;
      refreshing = true;
      void listReefApps().then(latest => { if (stamp === generation) { apps = latest; paint(); } }).catch(() => {}).finally(() => { refreshing = false; });
    }, 250);
  }));
  disposeEvents = () => subscriptions.forEach(dispose => dispose());
}

async function showDetail(id: string, stamp: number) {
  let app = await getReefApp(id); if (stamp !== generation) return;
  const heading = element('div', '', 'reef-detail-heading'); const title = element('h2', app.name); heading.append(title, element('p', app.description));
  const actions = element('div', '', 'reef-actions');
  const content = element('div', '', 'reef-workspace'); const main = element('div', '', 'reef-main'); const aside = element('aside');
  const build = element('section', '', 'reef-build'); build.setAttribute('aria-label', 'Build status');
  const status = element('h3'); status.setAttribute('role', 'status');
  const visual = element('div', '', 'reef-vortex'); visual.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 8; i++) { const particle = element('span', i % 2 ? '{ }' : '□', 'reef-particle'); particle.style.setProperty('--reef-particle', String(i)); visual.append(particle); }
  const ring = element('div', '', 'reef-ring'); const percent = element('span', '0%', 'reef-percent'); visual.append(ring, percent);
  const progress = element('progress'); progress.max = 100; progress.setAttribute('aria-label', 'Build progress');
  const error = element('p', '', 'reef-build-error');
  const repair = button('Send to agent to fix', async () => { await reefRequest(`apps/${id}/runs`, 'POST', {}); await refresh(); });
  const cancel = button('Cancel build', async () => { const run = app.runs.at(-1); if (run) await reefRequest(`apps/${id}/cancel`, 'POST', { runId: run.id }); await refresh(); });
  const logs = element('details'); logs.append(element('summary', 'Build log')); const log = element('pre'); logs.append(log);
  build.append(status, visual, progress, error, cancel, repair, logs);
  const preview = element('div', '', 'reef-preview'); preview.append(element('p', 'Run your app to use it here.'));
  let displayedRelease = '', launched = false;
  main.append(build, preview); content.append(main, aside);
  const runButton = button('Run app', async () => {
    const launch = await reefRequest<{ url: string }>(`apps/${id}/launch`, 'POST');
    if (stamp !== generation) return;
    launched = true;
    preview.replaceChildren();
    if (window.minnow?.preview) {
      activePreview = `reef-${id}`;
      await window.minnow.preview.instances.create(activePreview);
      disposePreview(); disposePreview = bindPreviewInstanceToElement(activePreview, preview);
      await window.minnow.preview.loadURL(launch.url, undefined, activePreview);
    } else {
      const iframe = element('iframe'); iframe.title = app.name;
      iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-downloads', 'allow-forms'); iframe.src = launch.url; preview.append(iframe);
    }
  }, true);
  const exportPanel = element('section', '', 'reef-export'); exportPanel.hidden = true;
  actions.append(runButton, button('Chat', () => chat?.focus()), button('Export', async () => { exportPanel.hidden = !exportPanel.hidden; if (!exportPanel.hidden) await showExport(exportPanel, app, refresh); }),
    button('Open in Code', () => launchApp('code', { workspacePath: app.workspacePath })),
    button('Rename', async () => { const name = await appPrompt('App name', app.name); if (name?.trim()) { await reefRequest(`apps/${id}`, 'PATCH', { name }); await refresh(); } }),
    button('Delete', async () => { if (await appConfirm(`Delete ${app.name}, its local repository, and app data?`, { danger: true, confirmLabel: 'Delete app' })) { await reefRequest(`apps/${id}`, 'DELETE'); navigate(); } }));
  heading.append(actions); root.append(heading, exportPanel, content);
  chat = mountReefChat(aside, async text => { await reefRequest(`apps/${id}/chat`, 'POST', { prompt: text }); await refresh(); });
  function paint() {
    const run = app.runs.at(-1); const busy = Boolean(run && !terminal.has(run.state));
    title.textContent = app.name; runButton.disabled = !app.release;
    status.textContent = run?.state === 'ready' ? 'Your app is ready' : run?.state === 'failed' ? 'Build failed' : run?.state === 'interrupted' ? 'Build interrupted' : run?.state === 'cancelled' ? 'Build cancelled' : `${run?.state ?? 'Queued'}${run?.attempt ? ` · repair ${run.attempt}/2` : ''}`;
    visual.hidden = !busy; progress.hidden = !busy; percent.textContent = `${run?.progress ?? 0}%`; progress.value = run?.progress ?? 0;
    error.textContent = run?.error ? `${run.failedStage ? `${run.failedStage}: ` : ''}${run.error}` : ''; error.hidden = !run?.error; cancel.hidden = !busy; repair.hidden = busy || run?.state === 'ready';
    if (log.textContent !== run?.log) log.textContent = run?.log ?? '';
    chat?.update(app, busy);
    if (app.release && !launched && displayedRelease !== app.release.id) {
      displayedRelease = app.release.id;
      void fetch(`/api/reef/apps/${id}/preview`).then(async response => {
        if (!response.ok) return;
        const blob = await response.blob();
        if (stamp !== generation || launched) return;
        if (previewImageUrl) URL.revokeObjectURL(previewImageUrl);
        previewImageUrl = URL.createObjectURL(blob);
        const image = element('img'); image.alt = `${app.name} verified build preview`; image.src = previewImageUrl;
        preview.replaceChildren(image);
      }).catch(() => {});
    }
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing || stamp !== generation) return; refreshing = true;
    try { const latest = await getReefApp(id); if (stamp !== generation) return; app = latest; paint(); }
    finally { refreshing = false; }
  }
  paint();
  disposeEvents = subscribeReef(id, () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refresh().catch(error => showError(errorText(error))); }, 200);
  });
}

async function showExport(host: HTMLElement, app: ReefApp, refresh: () => Promise<void>) {
  host.replaceChildren(element('h3', 'Export app'), element('p', 'Standalone packages are unsigned and unnotarized. Source exports include build instructions.'));
  const capabilities = await reefRequest<{ platform: string; arch: string; docker: boolean; github: boolean }>('capabilities');
  const target = element('select'); target.setAttribute('aria-label', 'Export operating system');
  for (const [value, label] of [['win32', 'Windows'], ['darwin', 'macOS'], ['linux', 'Linux']]) { const option = element('option', label); option.value = value; target.append(option); }
  target.value = capabilities.platform;
  const arch = element('select'); arch.setAttribute('aria-label', 'Export architecture');
  for (const value of ['x64', 'arm64']) { const option = element('option', value); option.value = value; arch.append(option); } arch.value = capabilities.arch;
  const method = element('select'); method.setAttribute('aria-label', 'Export method');
  const updateMethods = () => {
    method.replaceChildren();
    const choices = [['source', 'Source + build kit']];
    if (target.value === capabilities.platform) choices.unshift(['local', 'Build on this machine']);
    if (capabilities.docker && target.value !== 'darwin') choices.push(['docker', 'Build with Docker']);
    choices.push(['github', 'GitHub Actions']);
    for (const [value, label] of choices) { const option = element('option', label); option.value = value; method.append(option); }
  };
  target.addEventListener('change', updateMethods); updateMethods();
  const controls = element('div', '', 'reef-actions');
  const performExport = async (exportMethod: string, exportTarget: string, exportArch = arch.value) => {
    let cloudConsent = false;
    if (exportMethod === 'github') {
      cloudConsent = await appConfirm('Upload this app’s source to a private GitHub repository and run a build on GitHub Actions? Your local app repository stays local.', { confirmLabel: 'Upload and build' });
      if (!cloudConsent) return;
    }
    await exportReefApp(app.id, { target: exportTarget, arch: exportArch, method: exportMethod, cloudConsent });
    await refresh(); await showExport(host, await getReefApp(app.id), refresh);
  };
  controls.append(target, arch, method, button('Create export', () => performExport(method.value, target.value), true));
  host.append(controls);
  for (const item of app.exports.slice().reverse()) {
    const row = element('div', '', 'reef-export-row'); row.append(element('span', `${item.target} · ${item.method} · ${item.status}`));
    if (item.filename && item.status === 'ready') {
      row.append(button('Download', async () => {
        const response = await fetch(`/api/reef/apps/${app.id}/exports/${item.id}`);
        if (!response.ok) throw new Error('Could not download export');
        const url = URL.createObjectURL(await response.blob());
        const link = element('a'); link.href = url; link.download = item.filename!; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }));
    }
    if (item.url) { const link = element('a', 'View build'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
    if (item.error) row.append(element('p', item.error));
    if (item.status === 'failed' || item.status === 'interrupted') row.append(button('Retry', () => performExport(item.method, item.target, item.arch)));
    host.append(row);
  }
  host.append(button('Refresh exports', async () => showExport(host, await getReefApp(app.id), refresh)));
}
