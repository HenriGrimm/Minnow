import { appConfirm } from './app-dialog';
import { createIcon } from './icon';
import { exportReefApp, reefRequest } from '../reef/client';
import type { ReefApp, ReefExport } from '../reef/types';

const platforms = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const methods = { source: 'Source + build kit', local: 'This machine', docker: 'Docker', github: 'GitHub Actions' };
const states = { queued: 'Queued', building: 'Building', ready: 'Ready to download', failed: 'Build failed', interrupted: 'Build interrupted' };
const isBusy = (item: ReefExport) => item.status === 'queued' || item.status === 'building';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}

/** Keep export choices and open logs intact as live app snapshots arrive. */
export function mountReefExport(host: HTMLElement, initial: ReefApp, refresh: () => Promise<void>) {
  let app = initial;
  let capabilities: { platform: string; arch: string; docker: boolean; github: boolean } | undefined;
  let pending = false, loading: Promise<void> | undefined;
  const rows = new Map<string, { row: HTMLElement; item: ReefExport; update: (item: ReefExport) => void }>();
  const error = element('p', '', 'reef-export-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const runAction = async (action: () => Promise<void>) => {
    error.hidden = true;
    try { await action(); }
    catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); error.hidden = false; }
  };
  function action(label: string, callback: () => Promise<void>) {
    const node = element('button', label); node.type = 'button';
    node.addEventListener('click', () => {
      if (node.disabled) return;
      node.disabled = true;
      void runAction(callback).finally(() => { node.disabled = false; syncControls(); });
    });
    return node;
  }
  const header = element('header', '', 'reef-export-header');
  const heading = element('div'); heading.append(element('h3', 'Build & export'), element('p', 'Package the latest verified version of your app.'));
  const refreshButton = action('Refresh exports', async () => { await load(); await refresh(); });
  refreshButton.prepend(createIcon('refresh')); refreshButton.classList.add('reef-export-refresh');
  header.append(heading, refreshButton);
  const layout = element('div', '', 'reef-export-layout');
  const form = element('form', '', 'reef-export-form');
  const target = element('select'); target.setAttribute('aria-label', 'Export operating system');
  const arch = element('select'); arch.setAttribute('aria-label', 'Export architecture');
  const method = element('select'); method.setAttribute('aria-label', 'Export method');
  for (const [value, label] of Object.entries(platforms)) { const option = element('option', label); option.value = value; target.append(option); }
  for (const [value, label] of [['x64', 'x64 (Intel / AMD)'], ['arm64', 'ARM64']]) { const option = element('option', label); option.value = value; arch.append(option); }
  const fields = element('div', '', 'reef-export-fields');
  for (const [label, select] of [['Operating system', target], ['Architecture', arch], ['Build method', method]] as const) {
    const field = element('label', '', 'reef-export-field'); field.append(element('span', label), select); fields.append(field);
  }
  const hint = element('p', 'Loading build options…', 'reef-export-hint');
  function updateHint() {
    hint.textContent = method.value === 'source' ? 'Download the source and instructions to build it yourself.'
      : method.value === 'github' ? 'Build in a private GitHub repository. Upload requires your confirmation.'
      : method.value === 'docker' ? 'Package the app in a local Docker container.' : 'Package the app locally. No source is uploaded.';
  }
  function updateMethods() {
    if (!capabilities) return;
    const selected = method.value;
    const choices: ReefExport['method'][] = target.value === capabilities.platform ? ['local', 'source'] : ['source'];
    if (capabilities.docker && target.value !== 'darwin') choices.push('docker');
    choices.push('github');
    method.replaceChildren(...choices.map(value => { const option = element('option', value === 'local' ? 'Build on this machine' : methods[value]); option.value = value; return option; }));
    if (choices.includes(selected as ReefExport['method'])) method.value = selected;
    updateHint();
  }
  target.addEventListener('change', updateMethods); method.addEventListener('change', updateHint);
  const create = element('button', 'Create export', 'reef-primary'); create.type = 'submit'; create.prepend(createIcon('download'));
  const note = element('p', 'Desktop packages are unsigned and unnotarized.', 'reef-export-note');
  form.append(fields, hint, create, note);
  form.addEventListener('submit', event => { event.preventDefault(); if (!create.disabled) void runAction(() => perform(method.value as ReefExport['method'], target.value as ReefExport['target'], arch.value)); });
  const history = element('section', '', 'reef-export-history'); history.setAttribute('aria-label', 'Export history');
  const historyHeader = element('div', '', 'reef-export-history-header');
  const count = element('span', '', 'reef-export-count'); count.setAttribute('role', 'status');
  historyHeader.append(element('h4', 'Exports'), count);
  const list = element('div', '', 'reef-export-list');
  const empty = element('p', 'No exports yet. Choose a platform and create your first export.', 'reef-export-empty');
  history.append(historyHeader, empty, list); layout.append(form, history); host.replaceChildren(header, layout, error);

  function syncControls() {
    const busy = app.exports.some(isBusy);
    target.disabled = arch.disabled = method.disabled = pending || !capabilities;
    create.disabled = pending || busy || !capabilities || !app.release;
    create.lastChild!.textContent = pending ? 'Starting export…' : busy ? 'Export in progress…' : 'Create export';
    form.setAttribute('aria-busy', String(pending));
    for (const { row } of rows.values()) { const retry = row.querySelector<HTMLButtonElement>('.reef-export-retry'); if (retry) retry.disabled = pending || busy; }
  }
  async function perform(exportMethod: ReefExport['method'], exportTarget: ReefExport['target'], exportArch?: string) {
    if (pending || app.exports.some(isBusy)) return;
    pending = true; syncControls();
    try {
      let cloudConsent = false;
      if (exportMethod === 'github') {
        cloudConsent = await appConfirm('Upload this app’s source to a private GitHub repository and run a build on GitHub Actions? Your local app repository stays local.', { confirmLabel: 'Upload and build' });
        if (!cloudConsent) return;
      }
      const item = await exportReefApp(app.id, { target: exportTarget, arch: exportArch, method: exportMethod, cloudConsent });
      update({ ...app, exports: [...app.exports.filter(value => value.id !== item.id), item] });
      await refresh();
    } finally { pending = false; syncControls(); }
  }
  function makeRow(item: ReefExport) {
    const row = element('article', '', 'reef-export-row'); row.dataset.exportId = item.id;
    const top = element('div', '', 'reef-export-row-top');
    const identity = element('div', '', 'reef-export-identity');
    const title = element('strong'); const metadata = element('span', '', 'reef-export-metadata'); identity.append(title, metadata);
    const status = element('span', '', 'reef-export-status'); top.append(identity, status);
    const filename = element('p', '', 'reef-export-filename');
    const actions = element('div', '', 'reef-export-row-actions');
    const download = action('Download', async () => {
      const current = rows.get(item.id)!.item;
      const response = await fetch(`/api/reef/apps/${app.id}/exports/${item.id}`);
      if (!response.ok) throw new Error('Could not download export. Refresh and try again.');
      const url = URL.createObjectURL(await response.blob());
      const link = element('a'); link.href = url; link.download = current.filename!; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }); download.prepend(createIcon('download'));
    const retry = action('Retry export', () => { const current = rows.get(item.id)!.item; return perform(current.method, current.target, current.arch); }); retry.classList.add('reef-export-retry');
    const cloud = element('a', 'View build'); cloud.target = '_blank'; cloud.rel = 'noopener noreferrer';
    actions.append(download, retry, cloud);
    const failure = element('p', '', 'reef-export-error');
    const details = element('details', '', 'reef-export-log'); details.append(element('summary', 'Build log'));
    const log = element('pre'); log.tabIndex = 0; log.setAttribute('aria-label', 'Export build log'); details.append(log);
    row.append(top, filename, failure, actions, details);
    return { row, item, update(current: ReefExport) {
      this.item = current; row.dataset.status = current.status;
      title.textContent = `${platforms[current.target]}${current.arch ? ` · ${current.arch === 'arm64' ? 'ARM64' : 'x64'}` : ''}`;
      metadata.textContent = `${methods[current.method]}${current.releaseId !== app.release?.id ? ' · Previous version' : ''}`;
      status.textContent = current.status === 'building' && current.method === 'source' ? 'Preparing source' : states[current.status];
      filename.textContent = current.filename ?? ''; filename.hidden = !current.filename;
      download.hidden = current.status !== 'ready' || !current.filename; download.setAttribute('aria-label', `Download ${current.filename ?? platforms[current.target] + ' export'}`);
      retry.hidden = current.status !== 'failed' && current.status !== 'interrupted'; retry.setAttribute('aria-label', `Retry ${platforms[current.target]} export`);
      cloud.hidden = !current.url; if (current.url) cloud.href = current.url;
      failure.textContent = current.error ?? ''; failure.hidden = !current.error;
      actions.hidden = download.hidden && retry.hidden && cloud.hidden;
      details.hidden = !current.log;
      if (log.textContent !== (current.log ?? '')) { const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 24; log.textContent = current.log ?? ''; if (atEnd) log.scrollTop = log.scrollHeight; }
    } };
  }
  function update(next: ReefApp) {
    app = next;
    const busy = app.exports.filter(isBusy).length;
    const summary = busy ? `${busy} in progress` : `${app.exports.length} ${app.exports.length === 1 ? 'export' : 'exports'}`;
    if (count.textContent !== summary) count.textContent = summary;
    empty.hidden = Boolean(app.exports.length);
    for (const [id, entry] of rows) { if (!app.exports.some(item => item.id === id)) { entry.row.remove(); rows.delete(id); } }
    let previous: HTMLElement | null = null;
    for (const item of app.exports.slice().reverse()) {
      let entry = rows.get(item.id);
      if (!entry) { entry = makeRow(item); rows.set(item.id, entry); }
      entry.update(item);
      if (entry.row.previousElementSibling !== previous || entry.row.parentElement !== list) list.insertBefore(entry.row, previous ? previous.nextSibling : list.firstChild);
      previous = entry.row;
    }
    syncControls();
  }
  async function load() {
    if (capabilities) return;
    if (loading) return loading;
    loading = (async () => {
      capabilities = await reefRequest('capabilities');
      target.value = platforms[capabilities!.platform as keyof typeof platforms] ? capabilities!.platform : 'win32';
      arch.value = capabilities!.arch === 'arm64' ? 'arm64' : 'x64';
      updateMethods(); syncControls();
    })();
    try { await loading; } finally { loading = undefined; }
  }
  update(app);
  return { update, open: () => runAction(load) };
}
