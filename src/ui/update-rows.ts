import { describeUpdaterStrip, getUpdaterApi, releaseNotesExcerpt } from '../electron/updater-client';
import { type UpdateCenter } from '../os/update-center';
import { modelProducerLogoSvg } from '../providers/model-producer';
import { renderReleaseNotesMarkdown } from './release-notes-markdown';
import { iconHtml } from './icon';
import { MINNOW_GLYPH_HEADER_HTML } from './minnow-glyph';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function updateButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = el('button', `updates-button${primary ? ' updates-button--primary' : ''}`, label);
  button.type = 'button';
  button.onclick = onClick;
  return button;
}

function createRow(title: string, logo: string) {
  const root = el('article', 'updates-row');
  const header = el('div', 'updates-row__header');
  const mark = el('span', 'updates-row__mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = logo;
  const main = el('div', 'updates-row__main');
  const titleEl = el('h3', 'updates-row__title', title);
  const versions = el('p', 'updates-row__versions');
  const actions = el('div', 'updates-row__actions');
  const status = el('p', 'updates-row__status');
  status.setAttribute('role', 'status');
  const extra = el('div', 'updates-row__extra');
  main.append(titleEl, versions);
  header.append(mark, main, actions);
  root.append(header, status, extra);
  return { root, versions, actions, status, extra };
}

export function updateSummary(center: UpdateCenter): string {
  const count = center.pendingUpdates().length;
  const { app, appChecking, cliChecking, cli, cliError, cliRestricted } = center.state;
  if (center.isInstallingCli()) return 'Installing CLI updates…';
  if (count) return `${count} update${count === 1 ? '' : 's'} available`;
  if (cliChecking || appChecking || app?.state === 'checking') return 'Checking for updates…';
  if (cliError || center.state.appError || app?.state === 'error') return 'Some updates could not be checked';
  if (cliRestricted) return 'Updates are managed on the computer running Minnow';
  if (cli?.items.some(row => row.state === 'unavailable')) return 'Some CLI versions could not be checked';
  if ((app?.state === 'idle' && app.lastCheckedAt) || cli?.items.length) return 'You’re up to date';
  if (cli) return 'No CLI updates to show';
  return 'Waiting for first check';
}

/** Shared rows; state updates keep the same controls, focus and disclosures mounted. */
export function createUpdateRows(center: UpdateCenter, surface: 'settings' | 'popover') {
  const root = el('div', 'updates-list');
  const app = createRow('Minnow', MINNOW_GLYPH_HEADER_HTML);
  const restart = updateButton('Restart to update', () => { void center.restart(); }, true);
  const progress = el('progress', 'updates-row__progress');
  progress.max = 100;
  progress.setAttribute('aria-label', 'Minnow download progress');
  const notes = el('details', 'updates-notes');
  const notesSummary = el('summary', 'updates-notes__summary', 'Release notes');
  const notesBody = el('div', 'updates-notes__body');
  notes.append(notesSummary, notesBody);
  const restartHint = el('p', 'updates-row__hint', 'Minnow will close and reopen. Save your work before restarting.');
  app.actions.append(restart);
  app.extra.append(progress, restartHint, notes);
  const appGroup = el('section', 'updates-group');
  appGroup.setAttribute('aria-label', 'Minnow desktop');
  appGroup.append(app.root);

  const cliGroup = el('section', 'updates-group');
  const cliHeading = el('h3', 'updates-group__heading', 'CLI providers');
  const cliList = el('div', 'updates-group__list');
  const cliHint = el('p', 'updates-group__hint');
  cliHint.setAttribute('role', 'status');
  cliGroup.append(cliHeading, cliList, cliHint);
  root.append(appGroup, cliGroup);
  let renderedNotes: string | null = null;
  const rows = new Map<string, ReturnType<typeof createRow> & { button: HTMLButtonElement; detail: HTMLElement }>();

  function render() {
    const state = center.state;
    const status = state.app;
    const api = getUpdaterApi();
    const ready = status?.state === 'ready';
    const downloading = status?.state === 'downloading';
    const activeVersion = (ready || downloading) && status.pendingVersion;
    const appText = status ? describeUpdaterStrip(status, window.navigator.onLine) : null;
    app.versions.textContent = status
      ? [`v${status.installedVersion}`, activeVersion && `→ v${activeVersion}`].filter(Boolean).join(' ')
      : api ? 'Desktop app' : 'Browser session';
    app.status.textContent = state.appError || (state.restarting ? 'Restarting Minnow…'
      : status?.unsupportedReason === 'macos-signing' ? 'This macOS build requires a manual update.'
      : status?.unsupportedReason === 'dev' ? 'Desktop updates are available in the installed Minnow app.'
      : ready ? 'Ready to restart'
      : appText?.label ?? (api ? 'Reading update status…' : 'Desktop updates are available in the installed Minnow app.'));
    app.root.dataset.tone = state.appError ? 'warn' : ready ? 'ready' : appText?.tone ?? 'muted';
    restart.hidden = !ready;
    restart.disabled = state.restarting || center.isInstallingCli();
    restartHint.textContent = center.isInstallingCli() ? 'Restart is available when CLI updates finish.'
      : 'Minnow will close and reopen. Save your work before restarting.';
    restartHint.hidden = !ready;
    progress.hidden = !downloading;
    if (downloading) progress.value = status.progressPercent ?? 0;
    const nextNotes = activeVersion ? status.releaseNotes : null;
    notes.hidden = !nextNotes;
    if (nextNotes !== renderedNotes) {
      notes.open = false;
      if (nextNotes) {
        notesSummary.textContent = `What’s new in ${activeVersion}`;
        if (surface === 'settings') renderReleaseNotesMarkdown(notesBody, nextNotes);
        else {
          const list = el('ul');
          list.append(...releaseNotesExcerpt(nextNotes).map(line => el('li', '', line)));
          notesBody.replaceChildren(list);
        }
      } else notesBody.replaceChildren();
      renderedNotes = nextNotes;
    }
    const items = state.cli?.items ?? [];
    for (const [key, row] of rows) {
      if (!items.some(item => item.kind === key)) { row.root.remove(); rows.delete(key); }
    }
    for (const item of items) {
      let row = rows.get(item.kind);
      if (!row) {
        const parts = createRow(item.label, modelProducerLogoSvg(item.kind === 'codex' ? 'openai' : item.kind)
          ?? iconHtml('terminal', { size: 16 }));
        const button = updateButton('Update', () => { void center.updateCli(item.kind); }, true);
        button.setAttribute('aria-label', `Update ${item.label}`);
        const detail = el('p', 'updates-row__hint');
        detail.setAttribute('role', 'status');
        parts.actions.append(button);
        parts.extra.append(detail);
        row = { ...parts, button, detail };
        cliList.append(row.root);
        rows.set(item.kind, row);
      }
      const op = state.operations.get(item.kind);
      const running = op?.state === 'running' || state.cliInstalling.includes(item.kind);
      const available = item.state === 'available';
      row.versions.textContent = [item.installedVersion ? `v${item.installedVersion}` : 'Version unknown',
        available && item.latestVersion ? `→ v${item.latestVersion}` : ''].filter(Boolean).join(' ');
      row.status.textContent = running ? 'Updating in the background…' : available ? 'Update available'
        : item.state === 'current' ? 'Up to date' : 'Could not verify the latest version';
      row.root.dataset.tone = op?.state === 'error' ? 'warn' : available ? 'ready' : 'muted';
      row.button.hidden = item.state === 'current' && !running;
      row.button.disabled = running || state.restarting;
      row.button.textContent = running ? 'Updating…' : op?.state === 'error' ? 'Retry' : 'Update';
      row.detail.textContent = op && !running ? op.message : '';
      row.detail.hidden = !row.detail.textContent;
    }
    cliHint.textContent = state.cliError || (state.cliRestricted ? 'Check and install CLI updates on the computer running Minnow.'
      : items.length ? '' : state.cli ? 'No CLI providers are installed.' : 'Looking for installed CLI providers…');
    cliHint.hidden = !cliHint.textContent;
  }
  return { root, render };
}
